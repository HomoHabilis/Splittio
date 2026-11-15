import { describe, expect, it } from 'vitest'
import {
  EXACT_SETTLEMENT_LIMIT,
  getSuggestedReimbursements,
  type Balances,
  type Reimbursement,
} from '../src/core/balances'

function balancesOf(totals: Record<string, number>): Balances {
  const balances: Balances = {}
  for (const [id, total] of Object.entries(totals)) balances[id] = { paid: 0, paidFor: 0, total }
  return balances
}

/** Applies the transfers and returns what each participant is still owed. */
function apply(totals: Record<string, number>, reimbursements: Reimbursement[]) {
  const left = { ...totals }
  for (const { from, to, amount } of reimbursements) {
    expect(amount).toBeGreaterThan(0)
    expect(Number.isInteger(amount)).toBe(true)
    left[from] += amount
    left[to] -= amount
  }
  return left
}

function expectSettled(totals: Record<string, number>, reimbursements: Reimbursement[]) {
  for (const value of Object.values(apply(totals, reimbursements))) expect(value).toBe(0)
}

/** The true minimum, by trying every way to cut the balances into zero-sum groups. */
function bruteForceMinimum(values: number[]): number {
  const nonZero = values.filter((v) => v !== 0)
  let mostGroups = 0
  const search = (rest: number[], groups: number) => {
    if (rest.length === 0) {
      mostGroups = Math.max(mostGroups, groups)
      return
    }
    // The first remaining balance starts a group; try every subset of the others with it.
    const [head, ...others] = rest
    for (let mask = 0; mask < 1 << others.length; mask++) {
      let sum = head
      for (let i = 0; i < others.length; i++) if (mask & (1 << i)) sum += others[i]
      if (sum !== 0) continue
      search(others.filter((_, i) => !(mask & (1 << i))), groups + 1)
    }
  }
  search(nonZero, 0)
  return nonZero.length - mostGroups
}

function makeRandom(seed: number) {
  let state = seed >>> 0
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % max
  }
}

/** Random balances summing to zero, built from small amounts so zero-sum subgroups are common. */
function randomTotals(random: (max: number) => number, count: number, spread: number) {
  const totals: Record<string, number> = {}
  let sum = 0
  for (let i = 0; i < count - 1; i++) {
    const value = random(2 * spread + 1) - spread
    totals[`p${String(i).padStart(2, '0')}`] = value
    sum += value
  }
  totals[`p${String(count - 1).padStart(2, '0')}`] = 0 - sum
  return totals
}

describe('fewest reimbursements', () => {
  it('settles two independent sub-groups separately', () => {
    // {a, c, d} and {b, e, f} each sum to zero: 4 transfers, where pairing
    // largest debtor with largest creditor needs 5.
    const totals = { a: 600, b: 500, c: -200, d: -400, e: -300, f: -200 }
    const reimbursements = getSuggestedReimbursements(balancesOf(totals))

    expect(reimbursements).toHaveLength(4)
    expectSettled(totals, reimbursements)
  })

  it('pays exact opposite balances directly', () => {
    const totals = { alice: 1234, bob: -1234, carol: 50, dave: -20, erin: -30 }
    const reimbursements = getSuggestedReimbursements(balancesOf(totals))

    expect(reimbursements).toContainEqual({ from: 'bob', to: 'alice', amount: 1234 })
    expect(reimbursements).toHaveLength(3)
    expectSettled(totals, reimbursements)
  })

  it('suggests nothing when everyone is settled', () => {
    expect(getSuggestedReimbursements(balancesOf({ a: 0, b: 0 }))).toEqual([])
    expect(getSuggestedReimbursements({})).toEqual([])
  })

  it('matches the brute-force minimum on random groups', () => {
    const random = makeRandom(20261115)
    for (let run = 0; run < 400; run++) {
      const totals = randomTotals(random, 2 + random(8), 1 + random(12))
      const reimbursements = getSuggestedReimbursements(balancesOf(totals))

      expectSettled(totals, reimbursements)
      expect(reimbursements.length).toBe(bruteForceMinimum(Object.values(totals)))
    }
  })

  it('gives the same suggestions whatever order the balances arrive in', () => {
    const random = makeRandom(7)
    for (let run = 0; run < 100; run++) {
      const totals = randomTotals(random, 3 + random(10), 1 + random(9))
      const entries = Object.entries(totals)
      const shuffled = [...entries]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = random(i + 1)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }

      expect(getSuggestedReimbursements(balancesOf(Object.fromEntries(shuffled)))).toEqual(
        getSuggestedReimbursements(balancesOf(Object.fromEntries(entries))),
      )
    }
  })

  it('stays exact at the size limit and quick enough for a phone', () => {
    const random = makeRandom(99)
    // Distinct magnitudes so no exact pairs shrink the search.
    const values = Array.from({ length: EXACT_SETTLEMENT_LIMIT - 1 }, (_, i) => (i % 2 ? -1 : 1) * (1000 + 37 * i + random(30)))
    const totals: Record<string, number> = {}
    values.forEach((v, i) => (totals[`p${String(i).padStart(2, '0')}`] = v))
    totals.last = -values.reduce((s, v) => s + v, 0)

    const started = performance.now()
    const reimbursements = getSuggestedReimbursements(balancesOf(totals))
    const elapsed = performance.now() - started

    expectSettled(totals, reimbursements)
    expect(reimbursements.length).toBeLessThanOrEqual(EXACT_SETTLEMENT_LIMIT - 1)
    expect(elapsed).toBeLessThan(2000)
  })

  it('falls back to greedy pairing above the limit and still settles everything', () => {
    const random = makeRandom(3)
    const totals = randomTotals(random, EXACT_SETTLEMENT_LIMIT + 15, 100000)
    const reimbursements = getSuggestedReimbursements(balancesOf(totals))

    expectSettled(totals, reimbursements)
    expect(reimbursements.length).toBeLessThan(Object.keys(totals).length)
  })
})
