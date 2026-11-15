import type { Event } from 'nostr-tools/pure'
import type { Clock } from '../core/hlc'
import type { Op } from '../core/types'
import { hexToBytes } from '../core/util'
import type { GroupRecord, StoredEvent, Store } from '../store/db'
import type { DeviceIdentity } from '../store/device'
import { Relay, type Filter, type RelayStatus } from './relay'
import { FALLBACK_RELAYS, normalizeRelayUrl, relayInfo, type RelayInfo } from './relays'
import { buildSnapshot, chunkSnapshot, newestCompleteSnapshot, snapshotOps, SNAPSHOT_EVERY } from './snapshot'
import {
  batchOps,
  groupCrypto,
  KIND,
  MAX_PLAINTEXT,
  openEvent,
  encodePlaintext,
  signEvent,
  type GroupCrypto,
  type SnapChunkPayload,
} from './wire'

/** Upper bound on relays per group, whatever a group-meta op says. */
export const MAX_GROUP_RELAYS = 16

export type Timing = {
  /** Subtracted from each relay's `since` cursor to absorb clock skew (s). */
  overlapSec: number
  /** Minimum time between two full reconciliations with the same relay (ms). */
  reconcileEveryMs: number
  /** Delay between two re-published events per relay (ms). */
  repairDelayMs: number
  /** Max events re-published per relay per reconciliation pass. */
  repairMax: number
  /** Debounce before the outbox is flushed (ms). */
  flushDelayMs: number
  publishTimeoutMs: number
}

export const DEFAULT_TIMING: Timing = {
  overlapSec: 15 * 60,
  reconcileEveryMs: 3 * 60 * 60 * 1000,
  repairDelayMs: 400,
  repairMax: 300,
  flushDelayMs: 300,
  publishTimeoutMs: 10_000,
}

export type RelayView = {
  url: string
  status: RelayStatus
  fallback: boolean
  info?: RelayInfo | null
  lastError?: string
  lastReconcile?: number
  reconcileMode?: 'nip77' | 'paged'
}

export type SyncStatus = {
  relays: RelayView[]
  /** Ops saved on this phone, not yet signed and sent. */
  outbox: number
  /** Own events no relay has confirmed yet. */
  unconfirmed: number
  repairQueue: number
  reconciling: boolean
}

type Opts = {
  store: Store
  group: GroupRecord
  device: DeviceIdentity
  clock: Clock
  relayFactory?: (url: string) => Relay
  now?: () => number
  timing?: Partial<Timing>
  fallbackRelays?: string[]
}

/**
 * Sync for one group: outbox → batch → encrypt → sign → publish, live fetch with
 * per-relay cursors + overlap, periodic ID reconciliation (NIP-77 or paged) and
 * re-publishing of stored signed events that a relay is missing.
 */
export class GroupSync {
  readonly gc: GroupCrypto
  readonly groupId: string
  /** Called when new ops were stored (local or remote). */
  onChange: () => void = () => {}
  /** Called when the sync status changed. */
  onStatus: () => void = () => {}

  private store: Store
  private group: GroupRecord
  private device: DeviceIdentity
  private clock: Clock
  private now: () => number
  private timing: Timing
  private relayFactory: (url: string) => Relay
  private fallbackUrls: string[]
  private relays = new Map<string, Relay>()
  private fallbackActive = false
  private subs = new Map<string, { close: () => void }>()
  private infos = new Map<string, RelayInfo | null>()
  private cursors = new Map<string, number>()
  private lastReconcile = new Map<string, number>()
  private reconcileMode = new Map<string, 'nip77' | 'paged'>()
  private repairQueues = new Map<string, string[]>()
  private repairing = new Set<string>()
  private reconcilingCount = 0
  private chain: Promise<unknown> = Promise.resolve()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushing: Promise<void> | null = null
  private started = false
  private outboxCount = 0
  private unconfirmed = 0
  private opCount = 0
  private snapChunks: SnapChunkPayload[] = []
  private cursorTimer: ReturnType<typeof setInterval> | null = null

  constructor(o: Opts) {
    this.store = o.store
    this.group = o.group
    this.groupId = o.group.id
    this.device = o.device
    this.clock = o.clock
    this.now = o.now ?? Date.now
    this.timing = { ...DEFAULT_TIMING, ...o.timing }
    this.relayFactory = o.relayFactory ?? ((url) => new Relay(url))
    this.fallbackUrls = o.fallbackRelays ?? FALLBACK_RELAYS
    this.gc = groupCrypto(hexToBytes(o.group.key))
  }

  private nowSec() {
    return Math.floor(this.now() / 1000)
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.outboxCount = (await this.store.outbox(this.groupId)).length
    const events = await this.store.groupEvents(this.groupId)
    this.unconfirmed = events.filter((e) => e.event.pubkey === this.device.pubkey && e.relays.length === 0).length
    this.opCount = (await this.store.groupOps(this.groupId)).length
    for (const url of this.group.relays) this.addRelay(url, false)
    this.cursorTimer = setInterval(() => void this.saveCursors(), 10_000)
    this.emitStatus()
  }

  stop(): void {
    this.started = false
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.cursorTimer) clearInterval(this.cursorTimer)
    void this.saveCursors()
    for (const r of this.relays.values()) r.close()
    this.relays.clear()
    this.subs.clear()
  }

  /** Updates the group's relay list (from the group-meta op or settings). */
  setRelays(list: string[]): void {
    // The list can come from any member's op: keep only valid relay URLs, and not too many.
    const urls = [...new Set(list.map(normalizeRelayUrl).filter((u): u is string => !!u))].slice(0, MAX_GROUP_RELAYS)
    if (urls.length === 0) return
    const same = urls.length === this.group.relays.length && urls.every((u) => this.group.relays.includes(u))
    if (same) return
    this.group = { ...this.group, relays: urls }
    void this.store.updateGroup(this.groupId, { relays: urls })
    if (!this.started) return
    for (const url of urls) if (!this.relays.has(url)) this.addRelay(url, false)
    for (const [url, r] of this.relays)
      if (!urls.includes(url) && !(this.fallbackActive && this.fallbackUrls.includes(url))) {
        r.close()
        this.relays.delete(url)
        this.subs.delete(url)
      }
    this.emitStatus()
  }

  /** Reconnect everything now (e.g. on the browser's `online` event). */
  kick(): void {
    for (const r of this.relays.values()) r.kick()
  }

  private isFallback(url: string) {
    return !this.group.relays.includes(url) && this.fallbackUrls.includes(url)
  }

  private addRelay(url: string, fallback: boolean): Relay {
    let r = this.relays.get(url)
    if (r) return r
    r = this.relayFactory(url)
    this.relays.set(url, r)
    r.onStatus = (s) => {
      if (s === 'open') void this.onRelayOpen(url)
      this.emitStatus()
    }
    void relayInfo(url).then((info) => {
      this.infos.set(url, info)
      if (info && (info.paymentRequired || info.authRequired) && !fallback) r!.lastError = 'requires payment or auth'
      this.emitStatus()
    })
    r.connect()
    return r
  }

  private async onRelayOpen(url: string) {
    const relay = this.relays.get(url)
    if (!relay) return
    const c = await this.store.getCursor(this.groupId, url)
    if (!this.cursors.has(url)) this.cursors.set(url, c.since)
    if (!this.lastReconcile.has(url)) this.lastReconcile.set(url, c.lastReconcile)

    // Bootstrap from a snapshot when this device has nothing yet.
    if (this.opCount === 0 && !this.group.historyFrom) await this.serial(() => this.bootstrapFromSnapshot(relay))

    this.subscribe(relay)
    this.scheduleFlush(0)
    void this.resendRecent(url)
    if (this.now() - (this.lastReconcile.get(url) ?? 0) > this.timing.reconcileEveryMs) void this.reconcile(url)
  }

  private historyBound(): number | undefined {
    return this.group.historyFrom ? Math.floor(this.group.historyFrom / 1000) - this.timing.overlapSec : undefined
  }

  private subscribe(relay: Relay) {
    this.subs.get(relay.url)?.close()
    const cursor = this.cursors.get(relay.url) ?? 0
    let since = cursor > 0 ? cursor - this.timing.overlapSec : undefined
    const hb = this.historyBound()
    if (hb !== undefined) since = Math.max(since ?? 0, hb)
    const f: Filter = { kinds: [KIND], '#z': [this.gc.opsTag, this.gc.snapTag] }
    if (since !== undefined && since > 0) f.since = since
    const sub = relay.subscribe([f], {
      onEvent: (ev) => void this.receive(relay.url, ev),
      onEose: () => void this.saveCursors(),
    })
    this.subs.set(relay.url, sub)
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn)
    this.chain = p.catch(() => {})
    return p
  }

  private emitStatus() {
    this.onStatus()
  }

  status(): SyncStatus {
    return {
      relays: [...this.relays.values()].map((r) => ({
        url: r.url,
        status: r.status,
        fallback: this.isFallback(r.url),
        info: this.infos.get(r.url),
        lastError: r.lastError || undefined,
        lastReconcile: this.lastReconcile.get(r.url) || undefined,
        reconcileMode: this.reconcileMode.get(r.url),
      })),
      outbox: this.outboxCount,
      unconfirmed: this.unconfirmed,
      repairQueue: [...this.repairQueues.values()].reduce((s, q) => s + q.length, 0),
      reconciling: this.reconcilingCount > 0,
    }
  }

  // ---------- receiving ----------

  /** Handles one event from a relay (or a backup). Returns true if it was new. */
  receive(relayUrl: string | null, ev: Event): Promise<boolean> {
    if (relayUrl) {
      const c = this.cursors.get(relayUrl) ?? 0
      // Only advance the cursor for plausible timestamps.
      if (ev.created_at > c && ev.created_at <= this.nowSec() + 3600) this.cursors.set(relayUrl, ev.created_at)
    }
    return this.serial(async () => {
      const known = await this.store.getEvent(ev.id)
      if (known) {
        if (relayUrl && !known.relays.includes(relayUrl)) {
          await this.store.addEventRelays(ev.id, [relayUrl])
          if (known.relays.length === 0 && known.event.pubkey === this.device.pubkey) {
            this.unconfirmed = Math.max(0, this.unconfirmed - 1)
            this.emitStatus()
          }
        }
        return false
      }
      let decoded
      try {
        decoded = await openEvent(this.gc, this.groupId, ev)
      } catch {
        return false // not ours, tampered with, or undecodable: ignore
      }
      const stored: StoredEvent = {
        id: ev.id,
        groupId: this.groupId,
        kind: decoded.kind,
        event: ev,
        relays: relayUrl ? [relayUrl] : [],
        receivedAt: this.now(),
      }
      if (decoded.kind === 'ops') {
        const fresh = await this.store.ingestEvent(stored, decoded.ops)
        for (const op of fresh) this.clock.receive(op.hlc)
        if (fresh.length) {
          this.opCount += fresh.length
          this.onChange()
          this.maybeSnapshot()
        }
      } else {
        await this.store.ingestEvent(stored, [])
        this.snapChunks.push(decoded.chunk)
        // A complete snapshot also counts as "seen": don't publish another for a while.
        if (decoded.chunk.i === decoded.chunk.n - 1) void this.store.updateGroup(this.groupId, { lastSnapshotOps: this.opCount })
      }
      return true
    })
  }

  private async bootstrapFromSnapshot(relay: Relay) {
    const { events } = await relay.query([{ kinds: [KIND], '#z': [this.gc.snapTag], limit: 200 }])
    const chunks: SnapChunkPayload[] = []
    for (const ev of events) {
      try {
        const d = await openEvent(this.gc, this.groupId, ev)
        if (d.kind === 'snap') chunks.push(d.chunk)
      } catch {
        /* ignore */
      }
    }
    const snap = await newestCompleteSnapshot(chunks)
    if (!snap || snap.groupId !== this.groupId) return
    const ops = snapshotOps(snap)
    await this.store.putOps(ops)
    for (const op of ops) this.clock.receive(op.hlc)
    this.opCount += ops.length
    this.group = { ...this.group, historyFrom: snap.at, lastSnapshotOps: this.opCount }
    await this.store.updateGroup(this.groupId, { historyFrom: snap.at, lastSnapshotOps: this.opCount })
    this.onChange()
  }

  /** Drops the history bound so reconciliation fetches everything relays still have. */
  async loadFullHistory(): Promise<void> {
    this.group = { ...this.group, historyFrom: undefined }
    await this.store.updateGroup(this.groupId, { historyFrom: undefined })
    for (const r of this.relays.values()) if (r.status === 'open') this.subscribe(r)
    await this.reconcileAll(true)
  }

  private async saveCursors() {
    for (const [url, since] of this.cursors) {
      const c = await this.store.getCursor(this.groupId, url)
      if (since > c.since || (this.lastReconcile.get(url) ?? 0) > c.lastReconcile)
        await this.store.putCursor({ ...c, since: Math.max(since, c.since), lastReconcile: this.lastReconcile.get(url) ?? c.lastReconcile })
    }
  }

  // ---------- sending ----------

  /** Saves local ops (op log + outbox) and schedules sending. */
  async addLocal(ops: Op[]): Promise<void> {
    await this.store.addLocalOps(ops)
    this.outboxCount += ops.length
    this.opCount += ops.length
    this.onChange()
    this.emitStatus()
    this.scheduleFlush()
  }

  private scheduleFlush(delay = this.timing.flushDelayMs) {
    if (!this.started) return
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay)
  }

  private openRelays(): Relay[] {
    return [...this.relays.values()].filter((r) => r.status === 'open')
  }

  private capFor(): number {
    let cap = MAX_PLAINTEXT
    for (const url of this.group.relays) {
      const max = this.infos.get(url)?.maxMessageLength
      // NIP-44 base64 adds ~4/3, plus the event envelope.
      if (max) cap = Math.min(cap, Math.floor((max - 1500) * 0.7))
    }
    return Math.max(cap, 4000)
  }

  /**
   * Signs and sends the outbox. Signing happens here, at send time, so
   * `created_at` is fresh even for edits made offline hours ago.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    const run = async () => {
      if (this.openRelays().length === 0) return
      const ops = (await this.store.outbox(this.groupId)).sort((a, b) => (a.hlc < b.hlc ? -1 : 1))
      if (ops.length === 0) return
      for (const batch of await batchOps(ops, this.capFor())) {
        const ev = signEvent(this.gc, 'ops', batch.plaintext, this.device.sk, this.nowSec())
        await this.store.commitOutboxEvent(
          { id: ev.id, groupId: this.groupId, kind: 'ops', event: ev, relays: [], receivedAt: this.now() },
          batch.ops,
        )
        this.outboxCount = Math.max(0, this.outboxCount - batch.ops.length)
        this.unconfirmed++
        this.emitStatus()
        await this.publish(ev)
      }
      this.maybeSnapshot()
    }
    // Clear the guard only after it was set (run() may finish synchronously).
    const p = run().finally(() => {
      if (this.flushing === p) this.flushing = null
    })
    this.flushing = p
    return p
  }

  /** Publishes to all group relays; if fewer than 2 accept, to the fallback relays too. */
  async publish(ev: Event, only?: string[]): Promise<string[]> {
    const targets = only ? only.map((u) => this.relays.get(u)).filter((r): r is Relay => !!r) : this.openRelays()
    const accepted: string[] = []
    await Promise.all(
      targets.map(async (r) => {
        const res = await r.publish(ev, this.timing.publishTimeoutMs)
        if (res.ok || res.message.startsWith('duplicate')) accepted.push(r.url)
        else r.lastError = res.message
      }),
    )
    if (!only && accepted.length < 2 && this.fallbackUrls.length) {
      this.fallbackActive = true
      const fbs = this.fallbackUrls.filter((u) => !accepted.includes(u)).map((u) => this.addRelay(u, true))
      await Promise.all(
        fbs.map(async (r) => {
          if (!(await r.waitOpen(5000))) return
          const res = await r.publish(ev, this.timing.publishTimeoutMs)
          if (res.ok || res.message.startsWith('duplicate')) accepted.push(r.url)
        }),
      )
    }
    if (accepted.length) {
      const before = await this.store.getEvent(ev.id)
      await this.store.addEventRelays(ev.id, accepted)
      if (before && before.relays.length === 0 && ev.pubkey === this.device.pubkey) this.unconfirmed = Math.max(0, this.unconfirmed - 1)
    }
    this.emitStatus()
    return accepted
  }

  /** On (re)connect: send recent events this relay hasn't confirmed (quick path before reconciliation). */
  private async resendRecent(url: string) {
    const since = this.nowSec() - 7 * 86400
    const events = (await this.store.groupEvents(this.groupId))
      .filter((e) => !e.relays.includes(url) && e.event.created_at >= since && (e.event.pubkey === this.device.pubkey || e.relays.length === 0))
      .sort((a, b) => a.event.created_at - b.event.created_at)
    if (events.length) this.enqueueRepair(url, events.map((e) => e.id))
  }

  // ---------- reconciliation & repair ----------

  async reconcileAll(force = false): Promise<void> {
    await Promise.all([...this.relays.keys()].map((u) => this.reconcile(u, force)))
  }

  /**
   * Compares the full set of event IDs with one relay. Events the relay has and
   * we don't are fetched; events we have and it doesn't are queued for re-publishing.
   */
  async reconcile(url: string, force = false): Promise<{ need: number; have: number } | null> {
    const relay = this.relays.get(url)
    if (!relay) return null
    if (!force && this.now() - (this.lastReconcile.get(url) ?? 0) < this.timing.reconcileEveryMs) return null
    if (!(await relay.waitOpen(5000))) return null
    this.reconcilingCount++
    this.emitStatus()
    try {
      const local = (await this.store.groupEvents(this.groupId)).filter((e) => {
        const hb = this.historyBound()
        return hb === undefined || e.event.created_at >= hb
      })
      const info = this.infos.get(url) ?? (await relayInfo(url))
      let result: { need: string[]; have: string[] } | null = null
      if (info?.nip77) {
        result = await this.reconcileNegentropy(relay, local).catch(() => null)
        if (result) this.reconcileMode.set(url, 'nip77')
      }
      if (!result) {
        result = await this.reconcilePaged(relay, local, info?.maxLimit)
        if (result) this.reconcileMode.set(url, 'paged')
      }
      if (!result) return null
      // Fetch what we're missing (paged mode already delivered the events).
      for (let i = 0; i < result.need.length; i += 100) {
        const ids = result.need.slice(i, i + 100)
        const { events } = await relay.query([{ ids }])
        for (const ev of events) await this.receive(url, ev)
      }
      this.enqueueRepair(url, result.have)
      this.lastReconcile.set(url, this.now())
      await this.saveCursors()
      return { need: result.need.length, have: result.have.length }
    } finally {
      this.reconcilingCount--
      this.emitStatus()
    }
  }

  private filterBase(): Filter {
    const f: Filter = { kinds: [KIND], '#z': [this.gc.opsTag, this.gc.snapTag] }
    const hb = this.historyBound()
    if (hb !== undefined) f.since = hb
    return f
  }

  private async reconcileNegentropy(relay: Relay, local: StoredEvent[]): Promise<{ need: string[]; have: string[] } | null> {
    const { Negentropy, NegentropyStorageVector } = await import('../vendor/negentropy.js')
    const storage = new NegentropyStorageVector()
    for (const e of local) storage.insert(e.event.created_at, e.id)
    storage.seal()
    const neg = new Negentropy(storage, 50_000)
    const need: string[] = []
    const have: string[] = []
    return new Promise((resolve) => {
      let done = false
      const finish = (r: { need: string[]; have: string[] } | null) => {
        if (done) return
        done = true
        clearTimeout(t)
        session.close()
        resolve(r)
      }
      const t = setTimeout(() => finish(null), 30_000)
      const session = relay.negOpen(this.filterBase(), neg.initiate(), {
        onMsg: (msg) => {
          try {
            const next = neg.reconcile(
              msg,
              (id: string) => have.push(id),
              (id: string) => need.push(id),
            )
            if (next) session.send(next)
            else finish({ need, have })
          } catch {
            finish(null)
          }
        },
        onErr: () => finish(null),
      })
    })
  }

  /** Paged fetch stepping `until` backwards, respecting the relay's result limit. */
  private async reconcilePaged(relay: Relay, local: StoredEvent[], maxLimit?: number): Promise<{ need: string[]; have: string[] } | null> {
    const limit = Math.min(500, maxLimit ?? 500)
    const remote = new Set<string>()
    let until: number | undefined
    for (let page = 0; page < 1000; page++) {
      const f: Filter = { ...this.filterBase(), limit }
      if (until !== undefined) f.until = until
      const { events, complete } = await relay.query([f])
      if (!complete && events.length === 0) return null
      let oldest = Infinity
      for (const ev of events) {
        if (!remote.has(ev.id)) {
          remote.add(ev.id)
          await this.receive(relay.url, ev)
        }
        oldest = Math.min(oldest, ev.created_at)
      }
      // Relays may silently cap below the limit we asked for, so a short page
      // doesn't prove we're done: only an empty page does.
      if (events.length === 0) break
      const next = oldest === until ? oldest - 1 : oldest
      // `until` is inclusive: re-reading the boundary second guards against cut pages.
      until = next
    }
    const have = local.filter((e) => !remote.has(e.id)).map((e) => e.id)
    return { need: [], have }
  }

  private enqueueRepair(url: string, ids: string[]) {
    if (ids.length === 0) return
    const q = this.repairQueues.get(url) ?? []
    for (const id of ids) if (!q.includes(id)) q.push(id)
    this.repairQueues.set(url, q.slice(0, this.timing.repairMax))
    this.emitStatus()
    void this.runRepair(url)
  }

  /** Re-publishes stored signed events to a relay that lacks them: rate-limited, oldest first. */
  private async runRepair(url: string) {
    if (this.repairing.has(url)) return
    this.repairing.add(url)
    try {
      const q = this.repairQueues.get(url) ?? []
      const evs = (await Promise.all(q.map((id) => this.store.getEvent(id)))).filter((e): e is StoredEvent => !!e)
      evs.sort((a, b) => a.event.created_at - b.event.created_at)
      this.repairQueues.set(url, evs.map((e) => e.id))
      while ((this.repairQueues.get(url) ?? []).length) {
        const relay = this.relays.get(url)
        if (!relay || relay.status !== 'open') break
        const id = this.repairQueues.get(url)!.shift()!
        const ev = evs.find((e) => e.id === id)
        if (ev) await this.publish(ev.event, [url])
        this.emitStatus()
        if (this.timing.repairDelayMs) await new Promise((r) => setTimeout(r, this.timing.repairDelayMs))
      }
    } finally {
      this.repairing.delete(url)
      this.emitStatus()
    }
  }

  // ---------- snapshots ----------

  private snapshotting = false

  private maybeSnapshot() {
    const since = this.opCount - (this.group.lastSnapshotOps ?? 0)
    if (since < SNAPSHOT_EVERY || this.snapshotting || this.openRelays().length === 0) return
    void this.publishSnapshot()
  }

  async publishSnapshot(): Promise<number> {
    this.snapshotting = true
    try {
      const ops = await this.store.groupOps(this.groupId)
      const snap = buildSnapshot(this.groupId, ops, this.now())
      const chunks = await chunkSnapshot(snap)
      for (const c of chunks) {
        const ev = signEvent(this.gc, 'snap', await encodePlaintext(c), this.device.sk, this.nowSec(), `s:${c.id}:${c.i}`)
        await this.store.ingestEvent({ id: ev.id, groupId: this.groupId, kind: 'snap', event: ev, relays: [], receivedAt: this.now() }, [])
        await this.publish(ev)
      }
      this.group = { ...this.group, lastSnapshotOps: ops.length }
      await this.store.updateGroup(this.groupId, { lastSnapshotOps: ops.length })
      return chunks.length
    } finally {
      this.snapshotting = false
    }
  }
}
