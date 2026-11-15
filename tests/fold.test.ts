import { describe, expect, it } from 'vitest'
import { fold, occurrenceId, HOLD_AHEAD_MS } from '../src/core/fold'
import { Clock, encodeHlc } from '../src/core/hlc'
import { getBalances, toLedger } from '../src/core/balances'
import type { Money, Op } from '../src/core/types'

const G = 'group-1'
const DAY = 86_400_000
const T0 = Date.parse('2026-11-01T10:00:00Z')

function rng(seed: number) {
  let s = seed >>> 0
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s % n
  }
}

function shuffle<T>(arr: T[], r: (n: number) => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = r(i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

let opSeq = 0
function op(device: string, pt: number, entity: Op['entity'], entityId: string, set: Record<string, unknown>, c = 0): Op {
  return { opId: `op-${++opSeq}`, groupId: G, entity, entityId, set, hlc: encodeHlc({ pt, c, device }), author: device }
}

const devA = 'aaaaaaaaaaaaaaaa'
const devB = 'bbbbbbbbbbbbbbbb'
const devC = 'cccccccccccccccc'

function money(amount: number, paidFor: string[], mode: Money['splitMode'] = 'EVENLY', shares?: number[]): Money {
  return {
    amount,
    currency: 'EUR',
    splitMode: mode,
    paidFor: paidFor.map((p, i) => ({ participantId: p, shares: shares ? shares[i] : 1 })),
  }
}

/** Comparable projection of a state (drops Maps). */
function view(ops: Op[], now = T0 + 30 * DAY) {
  const s = fold(G, ops, { now, today: '2026-12-01' })
  return { group: s.group, participants: s.participants, expenses: s.expenses, devices: s.devices, held: s.held.map((o) => o.opId) }
}

function randomOps(seed: number, count: number): Op[] {
  const r = rng(seed)
  const devices = [devA, devB, devC]
  const people = ['p1', 'p2', 'p3', 'p4']
  const expenses = Array.from({ length: 8 }, (_, i) => `e${i}`)
  const ops: Op[] = [op(devA, T0, 'group', G, { name: 'Trip', currency: 'EUR' })]
  for (const p of people) ops.push(op(devA, T0 + 1, 'participant', p, { name: p.toUpperCase() }))
  for (let i = 0; i < count; i++) {
    const dev = devices[r(3)]
    // Few distinct times on purpose: lots of concurrent edits and HLC ties broken by device.
    const pt = T0 + 1000 * r(40)
    const e = expenses[r(expenses.length)]
    switch (r(6)) {
      case 0:
        ops.push(op(dev, pt, 'expense', e, { title: 'T' + r(100), date: '2026-11-0' + (1 + r(9)), paidBy: people[r(4)], money: money(100 + r(10000), people.slice(0, 1 + r(4))), category: r(10), notes: '' }, r(3)))
        break
      case 1:
        ops.push(op(dev, pt, 'expense', e, { title: 'Edit' + r(100) }, r(3)))
        break
      case 2:
        ops.push(op(dev, pt, 'expense', e, { money: money(r(5000), people.slice(r(3)), 'BY_SHARES', [1, 2, 3, 4].slice(0, 4 - r(1))) }, r(3)))
        break
      case 3:
        ops.push(op(dev, pt, 'expense', e, { deleted: r(2) === 0 }, r(3)))
        break
      case 4:
        ops.push(op(dev, pt, 'participant', people[r(4)], { name: 'N' + r(50) }, r(3)))
        break
      case 5:
        // Some ops from the future (held), some with a recurrence rule.
        if (r(4) === 0) ops.push(op(dev, T0 + 60 * DAY, 'expense', e, { notes: 'future' }))
        else ops.push(op(dev, pt, 'expense', e, { recurrence: ['none', 'weekly', 'monthly'][r(3)] }, r(3)))
        break
    }
  }
  return ops
}

describe('CRDT convergence', () => {
  it('gives identical state for 1,000 random orderings (with duplicates)', () => {
    const ops = randomOps(42, 300)
    const reference = JSON.stringify(view(ops))
    const r = rng(7)
    for (let i = 0; i < 1000; i++) {
      let shuffled = shuffle(ops, r)
      // Duplicate deliveries must not matter either.
      if (i % 3 === 0) shuffled = shuffled.concat(shuffle(ops, r).slice(0, 50))
      expect(JSON.stringify(view(shuffled))).toBe(reference)
    }
  })

  it('converges across many random op sets', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const ops = randomOps(seed, 120)
      const r = rng(seed * 31)
      const a = JSON.stringify(view(shuffle(ops, r)))
      const b = JSON.stringify(view(shuffle(ops, r)))
      expect(a).toBe(b)
    }
  })

  it('merges concurrent edits of different fields, and LWW on the same field', () => {
    const create = op(devA, T0, 'expense', 'e', { title: 'Dinner', date: '2026-11-02', paidBy: 'p1', money: money(3000, ['p1', 'p2']) })
    const editTitleA = op(devA, T0 + 10, 'expense', 'e', { title: 'Dinner A' })
    const editTitleB = op(devB, T0 + 10, 'expense', 'e', { title: 'Dinner B' }) // same time: device b wins the tie
    const editNotes = op(devC, T0 + 5, 'expense', 'e', { notes: 'with wine' })
    const e = fold(G, [editNotes, editTitleA, create, editTitleB]).expenses[0]
    expect(e.title).toBe('Dinner B')
    expect(e.notes).toBe('with wine')
  })

  it('a delete vs. a concurrent edit: the later HLC wins, restore undoes the delete', () => {
    const create = op(devA, T0, 'expense', 'e', { title: 'X', date: '2026-11-02', paidBy: 'p1', money: money(100, ['p1']) })
    const del = op(devB, T0 + 20, 'expense', 'e', { deleted: true })
    const edit = op(devA, T0 + 10, 'expense', 'e', { title: 'Y' })
    let s = fold(G, [create, edit, del])
    expect(s.expenses[0].deleted).toBe(true)
    expect(s.expenses[0].title).toBe('Y')
    const restore = op(devC, T0 + 30, 'expense', 'e', { deleted: false })
    s = fold(G, [restore, del, edit, create])
    expect(s.expenses[0].deleted).toBe(false)
  })

  it('ignores ops of other groups and malformed ops', () => {
    const good = op(devA, T0, 'participant', 'p1', { name: 'Ann' })
    const other = { ...op(devA, T0, 'participant', 'p2', { name: 'Bob' }), groupId: 'other' }
    const bad = { ...op(devA, T0, 'participant', 'p3', { name: 'Eve' }), hlc: 'nonsense' }
    expect(fold(G, [good, other, bad]).participants.map((p) => p.name)).toEqual(['Ann'])
  })
})

describe('households', () => {
  it('folds the household field, with the latest write winning and an empty value clearing it', () => {
    const create = [op(devA, T0, 'participant', 'p1', { name: 'Ann' }), op(devA, T0, 'participant', 'p2', { name: 'Bob' })]
    const join = op(devA, T0 + 1, 'participant', 'p2', { household: 'p1' })
    const leave = op(devB, T0 + 2, 'participant', 'p2', { household: '' })
    expect(fold(G, [...create, join]).participants.find((p) => p.id === 'p2')?.household).toBe('p1')
    expect(fold(G, [leave, ...create, join]).participants.find((p) => p.id === 'p2')?.household).toBeUndefined()
  })

  it('ignores a participant pointing at themselves', () => {
    const ops = [op(devA, T0, 'participant', 'p1', { name: 'Ann', household: 'p1' })]
    expect(fold(G, ops).participants[0].household).toBeUndefined()
  })
})

describe('held future ops', () => {
  it('holds ops more than 1 h ahead and applies them once the clock catches up', () => {
    const create = op(devA, T0, 'expense', 'e', { title: 'Now', date: '2026-11-01', paidBy: 'p1', money: money(100, ['p1']) })
    const future = op(devB, T0 + 2 * 60 * 60 * 1000, 'expense', 'e', { title: 'From the future' })
    let s = fold(G, [create, future], { now: T0 })
    expect(s.expenses[0].title).toBe('Now')
    expect(s.held.map((o) => o.opId)).toEqual([future.opId])
    s = fold(G, [create, future], { now: T0 + 2 * 60 * 60 * 1000 - HOLD_AHEAD_MS + 1 })
    expect(s.expenses[0].title).toBe('From the future')
    expect(s.held).toEqual([])
  })

  it('accepts ops up to 1 h ahead', () => {
    const create = op(devA, T0 + HOLD_AHEAD_MS, 'participant', 'p', { name: 'Ann' })
    expect(fold(G, [create], { now: T0 }).participants).toHaveLength(1)
  })

  it('local clock ignores far-future remote timestamps', () => {
    let now = T0
    const clock = new Clock(devA, () => now)
    clock.receive(encodeHlc({ pt: T0 + 5 * 60 * 60 * 1000, c: 0, device: devB }))
    expect(clock.tick().startsWith(String(T0))).toBe(true)
    clock.receive(encodeHlc({ pt: T0 + 30 * 60 * 1000, c: 4, device: devB }))
    expect(clock.tick()).toBe(encodeHlc({ pt: T0 + 30 * 60 * 1000, c: 5, device: devA }))
  })
})

describe('atomic money field', () => {
  it('a concurrent amount edit and split edit never produce a split that does not add up', () => {
    const create = op(devA, T0, 'expense', 'e', {
      title: 'Hotel', date: '2026-11-02', paidBy: 'p1', money: money(10000, ['p1', 'p2'], 'BY_AMOUNT', [5000, 5000]),
    })
    // A raises the amount (keeping the split proportional); B changes the split for the old amount.
    const a = op(devA, T0 + 10, 'expense', 'e', { money: money(12000, ['p1', 'p2'], 'BY_AMOUNT', [6000, 6000]) })
    const b = op(devB, T0 + 10, 'expense', 'e', { money: money(10000, ['p1', 'p2'], 'BY_AMOUNT', [7000, 3000]) })
    for (const order of [[create, a, b], [b, a, create], [a, create, b]]) {
      const e = fold(G, order).expenses[0]
      const sum = e.money.paidFor.reduce((s, p) => s + p.shares, 0)
      expect(sum).toBe(e.money.amount)
      expect(e.inconsistent).toBeUndefined()
      expect(e.money.amount).toBe(10000) // device b wins the tie, as a whole
    }
  })

  it('flags inconsistent imported data and still splits the full amount', () => {
    const create = op(devA, T0, 'expense', 'e', {
      title: 'Bad', date: '2026-11-02', paidBy: 'p1', money: money(100, ['p1', 'p2'], 'BY_AMOUNT', [30, 30]),
    })
    const e = fold(G, [create]).expenses[0]
    expect(e.inconsistent).toBe(true)
    const b = getBalances([toLedger(e)])
    expect(b.p1.paidFor + b.p2.paidFor).toBe(100)
    expect(b.p1.total + b.p2.total).toBe(0)
  })
})

describe('recurring expenses', () => {
  const tmplCreate = () =>
    op(devA, Date.parse('2026-08-31T09:00:00Z'), 'expense', 'rent', {
      title: 'Rent', date: '2026-08-31', paidBy: 'p1', money: money(100000, ['p1', 'p2']), recurrence: 'monthly',
    })

  it('derives occurrences up to today with deterministic ids, clamping the 31st', () => {
    const s = fold(G, [tmplCreate()], { now: T0, today: '2026-11-15' })
    const dates = s.expenses.map((e) => e.date).sort()
    expect(dates).toEqual(['2026-08-31', '2026-09-30', '2026-10-31'])
    const occ = s.expenses.find((e) => e.date === '2026-09-30')!
    expect(occ.id).toBe(occurrenceId('rent', '2026-09-30'))
    expect(occ.recurringFrom).toBe('rent')
    expect(occ.recurrence).toBe('none')
  })

  it('a real edit to an occurrence always wins over the derived values, however late it is computed', () => {
    const t = tmplCreate()
    const occ = occurrenceId('rent', '2026-09-30')
    // Edited by a device whose clock is far behind (but after the occurrence date was seen).
    const edit = op(devB, Date.parse('2026-09-30T00:00:00Z'), 'expense', occ, { title: 'Rent (Sept, shared with guest)' })
    for (const ops of [[t, edit], [edit, t]]) {
      const s = fold(G, ops, { now: T0, today: '2026-11-15' })
      expect(s.expenses.find((e) => e.id === occ)!.title).toBe('Rent (Sept, shared with guest)')
    }
  })

  it('template edits only affect later occurrences; deleting the template stops future ones', () => {
    const t = tmplCreate()
    const raise = op(devB, Date.parse('2026-10-05T12:00:00Z'), 'expense', 'rent', { money: money(120000, ['p1', 'p2']) })
    let s = fold(G, [t, raise], { now: T0, today: '2026-11-15' })
    const byDate = Object.fromEntries(s.expenses.map((e) => [e.date, e.money.amount]))
    expect(byDate['2026-09-30']).toBe(100000)
    expect(byDate['2026-10-31']).toBe(120000)

    const del = op(devA, Date.parse('2026-11-10T08:00:00Z'), 'expense', 'rent', { deleted: true })
    s = fold(G, [t, raise, del], { now: Date.parse('2027-01-10T00:00:00Z'), today: '2027-01-10' })
    const live = s.expenses.filter((e) => !e.deleted).map((e) => e.date).sort()
    expect(live).toEqual(['2026-09-30', '2026-10-31'])
  })

  it('a backdated template uses its creation values for past occurrences', () => {
    const t = op(devA, Date.parse('2026-11-10T09:00:00Z'), 'expense', 'gym', {
      title: 'Gym', date: '2026-10-20', paidBy: 'p1', money: money(3000, ['p1']), recurrence: 'weekly',
    })
    const s = fold(G, [t], { now: Date.parse('2026-11-10T10:00:00Z'), today: '2026-11-10' })
    expect(s.expenses.map((e) => e.date).sort()).toEqual(['2026-10-20', '2026-10-27', '2026-11-03', '2026-11-10'])
    expect(s.expenses.every((e) => e.money.amount === 3000)).toBe(true)
  })

  it('changing the rule applies from the edit onward', () => {
    const t = op(devA, Date.parse('2026-09-01T09:00:00Z'), 'expense', 'x', {
      title: 'X', date: '2026-09-01', paidBy: 'p1', money: money(100, ['p1']), recurrence: 'monthly',
    })
    const weekly = op(devA, Date.parse('2026-10-15T09:00:00Z'), 'expense', 'x', { recurrence: 'weekly' })
    const s = fold(G, [t, weekly], { now: T0, today: '2026-11-15' })
    expect(s.expenses.map((e) => e.date).sort()).toEqual([
      '2026-09-01', '2026-10-01', '2026-11-01', '2026-11-08', '2026-11-15',
    ])
  })
})
