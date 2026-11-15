import { afterEach, describe, expect, it } from 'vitest'
import { startRelay } from '../scripts/dev-relay.mjs'
import { Clock } from '../src/core/hlc'
import { fold } from '../src/core/fold'
import { OpFactory } from '../src/core/ops'
import type { Money } from '../src/core/types'
import { bytesToHex } from '../src/core/util'
import { Store, type GroupRecord } from '../src/store/db'
import { deviceFromSecret } from '../src/store/device'
import { GroupSync } from '../src/sync/engine'
import { generateSecretKey } from 'nostr-tools/pure'

type RelayHandle = Awaited<ReturnType<typeof startRelay>>

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function relay(opts: Record<string, unknown> = {}): Promise<RelayHandle> {
  const r = await startRelay({ quiet: true, ...opts })
  cleanups.push(() => r.close())
  return r
}

let dbSeq = 0
const GROUP_KEY = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
const GID = 'g-' + Math.random().toString(36).slice(2)

async function device(relays: string[], opts: { skewMs?: number; fallbackRelays?: string[]; key?: string } = {}) {
  const store = await Store.open('test-' + ++dbSeq)
  const dev = deviceFromSecret(bytesToHex(generateSecretKey()))
  const now = () => Date.now() + (opts.skewMs ?? 0)
  const clock = new Clock(dev.hlcId, now)
  const group: GroupRecord = { id: GID, key: opts.key ?? GROUP_KEY, name: 'Test', relays, joinedAt: now(), lastOpened: now() }
  await store.putGroup(group)
  const sync = new GroupSync({
    store,
    group,
    device: dev,
    clock,
    now,
    fallbackRelays: opts.fallbackRelays ?? [],
    timing: { repairDelayMs: 0, flushDelayMs: 0, reconcileEveryMs: 0 },
  })
  const factory = new OpFactory(GID, clock, dev.pubkey)
  cleanups.push(() => sync.stop())
  const state = async (at = now()) => {
    const s = fold(GID, await store.groupOps(GID), { now: at, today: '2026-12-31' })
    return JSON.stringify({ g: s.group, p: s.participants, e: s.expenses, held: s.held.length })
  }
  return { store, dev, sync, factory, now, state }
}

const money = (amount: number, who: string[]): Money => ({
  amount,
  currency: 'EUR',
  splitMode: 'EVENLY',
  paidFor: who.map((participantId) => ({ participantId, shares: 1 })),
})

async function until(cond: () => Promise<boolean> | boolean, ms = 8000) {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function seed(d: Awaited<ReturnType<typeof device>>, n = 3) {
  const ops = [
    d.factory.op('group', GID, { name: 'Raclette 2026', currency: 'EUR' }),
    d.factory.op('participant', 'p1', { name: 'Ann' }),
    d.factory.op('participant', 'p2', { name: 'Bob' }),
  ]
  for (let i = 0; i < n; i++)
    ops.push(d.factory.op('expense', 'e' + i, { title: 'Cheese ' + i, date: '2026-11-1' + (i % 10), paidBy: 'p1', money: money(1000 + i, ['p1', 'p2']), category: 9 }))
  await d.sync.addLocal(ops)
}

describe('sync engine (against a local relay)', () => {
  it('round-trips encrypted ops between two devices through 2 relays', async () => {
    const r1 = await relay()
    const r2 = await relay({ nip77: false })
    const a = await device([r1.url, r2.url])
    const b = await device([r1.url, r2.url])
    await a.sync.start()
    await b.sync.start()
    await seed(a)
    await until(async () => (await b.state()) === (await a.state()))
    // Relays only ever saw ciphertext with an opaque tag.
    const ev = [...r1.events.values()][0]
    expect(ev.kind).toBe(30078)
    expect(ev.content).not.toContain('Cheese')
    expect(ev.tags.map((t: string[]) => t[0]).sort()).toEqual(['d', 'z'])
    expect(JSON.stringify(ev.tags)).not.toContain(GID)
    // Both relays acknowledged the event.
    await until(async () => (await a.store.groupEvents(GID)).every((e) => e.relays.length === 2))
    expect(a.sync.status().unconfirmed).toBe(0)
  })

  it('ignores events encrypted with another key or tampered with', async () => {
    const r = await relay()
    const a = await device([r.url])
    const evil = await device([r.url], { key: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) })
    await a.sync.start()
    await evil.sync.start()
    await seed(evil)
    await until(() => r.events.size > 0)
    await new Promise((res) => setTimeout(res, 200))
    expect((await a.store.groupOps(GID)).length).toBe(0)
    const tampered = { ...[...r.events.values()][0], content: 'AAAA' }
    expect(await a.sync.receive(r.url, tampered)).toBe(false)
  })

  it('offline edits on two phones converge after reconnect, one clock 2 h ahead', async () => {
    const r1 = await relay()
    const r2 = await relay({ nip77: false })
    const a = await device([r1.url, r2.url])
    const b = await device([r1.url, r2.url], { skewMs: 2 * 60 * 60 * 1000 })
    await a.sync.start()
    await b.sync.start()
    await seed(a)
    await until(async () => (await b.store.groupOps(GID)).length === (await a.store.groupOps(GID)).length)

    // Airplane mode: both stop, edit offline, then reconnect.
    a.sync.stop()
    b.sync.stop()
    await a.store.addLocalOps([
      a.factory.op('expense', 'e0', { title: 'Cheese (edited by A)' }),
      a.factory.op('expense', 'e1', { notes: 'A was here' }),
      a.factory.op('expense', 'e9', { title: 'Wine', date: '2026-11-15', paidBy: 'p2', money: money(2500, ['p1', 'p2']) }),
    ])
    await b.store.addLocalOps([
      b.factory.op('expense', 'e0', { money: money(5000, ['p1']) }),
      b.factory.op('expense', 'e2', { deleted: true }),
      b.factory.op('participant', 'p3', { name: 'Cy' }),
    ])
    const a2 = new GroupSync({ store: a.store, group: (await a.store.getGroup(GID))!, device: a.dev, clock: new Clock(a.dev.hlcId, a.now), now: a.now, fallbackRelays: [], timing: { repairDelayMs: 0, flushDelayMs: 0, reconcileEveryMs: 0 } })
    const b2 = new GroupSync({ store: b.store, group: (await b.store.getGroup(GID))!, device: b.dev, clock: new Clock(b.dev.hlcId, b.now), now: b.now, fallbackRelays: [], timing: { repairDelayMs: 0, flushDelayMs: 0, reconcileEveryMs: 0 } })
    cleanups.push(() => a2.stop(), () => b2.stop())
    await a2.start()
    await b2.start()
    await until(async () => (await a.store.groupOps(GID)).length === 12 && (await b.store.groupOps(GID)).length === 12)

    // Same set of ops on both phones. B's ops are held on A until A's clock catches up …
    const aNow = JSON.parse(await a.state())
    expect(aNow.held).toBe(3)
    // … and once it has, every device shows the same state.
    const later = Date.now() + 2 * 60 * 60 * 1000 + 1000
    expect(await a.state(later)).toBe(await b.state(later))
    const s = JSON.parse(await a.state(later))
    const e0 = s.e.find((e: { id: string }) => e.id === 'e0')
    expect(e0.title).toBe('Cheese (edited by A)')
    expect(e0.money.amount).toBe(5000)
    expect(s.p.map((p: { name: string }) => p.name)).toEqual(['Ann', 'Bob', 'Cy'])
  })

  it('sends ops saved while no relay was reachable once one is', async () => {
    const r = await relay()
    const a = await device([])
    await a.sync.start()
    await a.sync.addLocal([a.factory.op('participant', 'p1', { name: 'Ann' })])
    await a.sync.flush() // no relay: returns at once
    a.sync.setRelays([r.url])
    await until(() => r.events.size === 1)
    await a.sync.addLocal([a.factory.op('participant', 'p2', { name: 'Bob' })])
    await until(() => r.events.size === 2)
  })

  it('signs at publish time: an op edited offline gets a fresh created_at', async () => {
    const r = await relay()
    const a = await device([r.url])
    const op = a.factory.op('participant', 'p1', { name: 'Ann' })
    await a.store.addLocalOps([op])
    await new Promise((res) => setTimeout(res, 1100))
    const before = Math.floor(Date.now() / 1000)
    await a.sync.start()
    await until(() => r.events.size === 1)
    expect([...r.events.values()][0].created_at).toBeGreaterThanOrEqual(before)
  })

  for (const nip77 of [true, false]) {
    it(`reconciliation (${nip77 ? 'NIP-77' : 'paged'}) re-publishes history a relay dropped and fetches events behind the cursor`, async () => {
      const r = await relay({ nip77, maxLimit: 7 })
      const a = await device([r.url])
      const b = await device([r.url])
      await a.sync.start()
      await seed(a, 30)
      await until(async () => (await a.store.groupEvents(GID)).every((e) => e.relays.length === 1))
      const total = r.events.size

      // The relay forgets everything older; a phone that kept the signed events restores it.
      r.drop()
      expect(r.events.size).toBe(0)
      const res = await a.sync.reconcile(r.url, true)
      expect(res?.have).toBe(total)
      expect(a.sync.status().relays[0].reconcileMode).toBe(nip77 ? 'nip77' : 'paged')
      await until(() => r.events.size === total)

      // An event signed with an old created_at lands behind B's cursor: the live
      // subscription misses it, reconciliation finds it.
      await b.sync.start()
      await until(async () => (await b.store.groupOps(GID)).length === (await a.store.groupOps(GID)).length)
      const late = a.factory.op('expense', 'late', { title: 'Old receipt', date: '2026-10-01', paidBy: 'p2', money: money(700, ['p1', 'p2']) })
      const { batchOps, signEvent } = await import('../src/sync/wire')
      const [batch] = await batchOps([late])
      const old = signEvent(a.sync.gc, 'ops', batch.plaintext, a.dev.sk, Math.floor(Date.now() / 1000) - 86400 * 30)
      // Delivered straight into the relay store (no live broadcast).
      r.events.set(old.id, old)
      await new Promise((res) => setTimeout(res, 100))
      expect((await b.store.groupOps(GID)).some((o) => o.opId === late.opId)).toBe(false)
      await b.sync.reconcile(r.url, true)
      expect((await b.store.groupOps(GID)).some((o) => o.opId === late.opId)).toBe(true)
    })
  }

  it('publishes to fallback relays when fewer than 2 relays accept', async () => {
    const good = await relay()
    const bad = await relay({ reject: true })
    const fb = await relay()
    const a = await device([good.url, bad.url], { fallbackRelays: [fb.url] })
    await a.sync.start()
    await seed(a, 1)
    await until(() => fb.events.size > 0)
    expect(bad.events.size).toBe(0)
    await until(async () => (await a.store.groupEvents(GID)).every((e) => e.relays.length === 2))
  })

  it('a new member catches up from a snapshot alone, then a late older op merges correctly', async () => {
    const r = await relay()
    const a = await device([r.url])
    await a.sync.start()
    await seed(a, 260) // crosses the 200-op snapshot threshold
    await until(async () => (await a.store.groupEvents(GID)).some((e) => e.kind === 'snap' && e.relays.length > 0), 15000)
    // Make sure the snapshot covers everything (another one after all ops are in).
    await a.sync.publishSnapshot()

    // Relays dropped all op events; only snapshot chunks remain.
    r.drop([...r.events.values()].filter((e: { tags: string[][] }) => e.tags.some((t) => t[0] === 'z' && t[1] === a.sync.gc.opsTag)).map((e: { id: string }) => e.id))
    const c = await device([r.url])
    await c.sync.start()
    await until(async () => (await c.store.groupOps(GID)).length > 0)
    expect(await c.state()).toBe(await a.state())
    expect((await c.store.getGroup(GID))!.historyFrom).toBeGreaterThan(0)

    // A late op from a device with an old clock: older than the snapshot for one field, it must lose.
    const skewed = new Clock('dddddddddddddddd', () => Date.now() - 86400_000)
    const lateOld = new OpFactory(GID, skewed, 'dd'.repeat(32)).op('expense', 'e5', { title: 'stale title' })
    const lateNew = a.factory.op('expense', 'e6', { title: 'fresh title' })
    for (const d of [a, c]) await d.store.putOps([lateOld, lateNew])
    expect(await c.state()).toBe(await a.state())
    const s = JSON.parse(await c.state())
    expect(s.e.find((e: { id: string }) => e.id === 'e5').title).toBe('Cheese 5')
    expect(s.e.find((e: { id: string }) => e.id === 'e6').title).toBe('fresh title')
  })
})
