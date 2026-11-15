// Adapted from Spliit src/lib/balances.ts (MIT, Copyright (c) 2023 Sebastien Castiel).
import { getExpenseShares, type ShareInput } from './shares'
import type { Expense } from './types'

export type Balances = Record<string, { paid: number; paidFor: number; total: number }>

export type Reimbursement = { from: string; to: string; amount: number }

/** The minimal expense shape the calculations need. */
export type LedgerExpense = {
  id?: string | null
  amount: number
  paidBy: string
  splitMode: ShareInput['splitMode']
  paidFor: ShareInput['paidFor']
  isReimbursement?: boolean
}

export function toLedger(e: Expense): LedgerExpense {
  return {
    id: e.id,
    amount: e.money.amount,
    paidBy: e.paidBy,
    splitMode: e.money.splitMode,
    paidFor: e.money.paidFor,
    isReimbursement: e.isReimbursement,
  }
}

export function getBalances(expenses: LedgerExpense[]): Balances {
  const balances: Balances = {}

  for (const expense of expenses) {
    const paidBy = expense.paidBy
    if (!balances[paidBy]) balances[paidBy] = { paid: 0, paidFor: 0, total: 0 }
    balances[paidBy].paid += expense.amount

    const dividedAmounts = getExpenseShares(expense)
    dividedAmounts.forEach((dividedAmount, participantId) => {
      if (!balances[participantId]) balances[participantId] = { paid: 0, paidFor: 0, total: 0 }
      balances[participantId].paidFor += dividedAmount
    })
  }

  for (const participantId in balances) {
    // add +0 to avoid negative zeros
    balances[participantId].paidFor = Math.round(balances[participantId].paidFor) + 0
    balances[participantId].paid = Math.round(balances[participantId].paid) + 0
    balances[participantId].total = balances[participantId].paid - balances[participantId].paidFor
  }
  return balances
}

/**
 * A comparator that is stable across reimbursements, so executing a suggested
 * reimbursement does not produce completely new suggestions.
 */
function compareBalancesForReimbursements(
  b1: { participantId: string; total: number },
  b2: { participantId: string; total: number },
): number {
  if (b1.total > 0 && 0 > b2.total) return -1
  if (b2.total > 0 && 0 > b1.total) return 1
  return b1.participantId < b2.participantId ? -1 : 1
}

type Entry = { participantId: string; total: number }

/**
 * Spliit's greedy settle-up: repeatedly pairs the first creditor with the last
 * debtor. It needs at most n - 1 transfers for n non-zero balances, which is
 * optimal when the balances cannot be split into smaller groups that settle
 * among themselves, and is used as-is for each such group.
 */
function greedyReimbursements(entries: Entry[]): Reimbursement[] {
  const balancesArray = entries.map((b) => ({ ...b }))
  balancesArray.sort(compareBalancesForReimbursements)
  const reimbursements: Reimbursement[] = []
  while (balancesArray.length > 1) {
    const first = balancesArray[0]
    const last = balancesArray[balancesArray.length - 1]
    const amount = first.total + last.total
    if (first.total > -last.total) {
      reimbursements.push({ from: last.participantId, to: first.participantId, amount: -last.total })
      first.total = amount
      balancesArray.pop()
    } else {
      reimbursements.push({ from: last.participantId, to: first.participantId, amount: first.total })
      last.total = amount
      balancesArray.shift()
    }
  }
  return reimbursements
}

/** How many search steps `settleWithoutTinyTransfers` may take per group. */
export const SETTLE_SEARCH_BUDGET = 20000

/**
 * Settles a group that has no smaller zero-sum subgroup, so every way of
 * settling it one person at a time takes the same k - 1 transfers. Among those,
 * looks for the one whose smallest transfer is the largest, so a 0.66 € top-up
 * is avoided when the same number of transfers can be made with larger ones.
 * Since only the smallest transfer is compared, this follows the size of the
 * amounts: in a group of 30 € debts it avoids 1 € transfers, in a group of
 * 3,000 € debts, 100 € ones.
 *
 * Depth-first search, starting from the most promising move and from Spliit's
 * greedy result, pruned by the smallest remaining balance (nobody can be
 * settled with transfers larger than what they still owe or are owed). The
 * step budget is counted, not timed, so every device stops at the same point
 * and shows the same suggestions.
 */
function settleWithoutTinyTransfers(group: Entry[]): Reimbursement[] {
  let best = greedyReimbursements(group)
  if (group.length <= 2) return best
  const smallest = (list: Reimbursement[]) => list.reduce((m, r) => Math.min(m, r.amount), Infinity)
  let bestMin = smallest(best)

  const ids = group.map((e) => e.participantId)
  const amounts = group.map((e) => e.total)
  const path: Reimbursement[] = []
  const seen = new Map<string, number>()
  let budget = SETTLE_SEARCH_BUDGET

  const search = (pathMin: number) => {
    if (budget-- <= 0) return
    let bound = pathMin
    let open = 0
    for (const a of amounts) if (a !== 0) (open++, (bound = Math.min(bound, Math.abs(a))))
    if (open === 0) {
      if (path.length < best.length || (path.length === best.length && pathMin > bestMin)) {
        best = path.slice()
        bestMin = pathMin
      }
      return
    }
    if (bound <= bestMin) return
    const key = amounts.join(',')
    if ((seen.get(key) ?? -1) >= pathMin) return
    seen.set(key, pathMin)

    // Try first the moves whose transfer and leftover are both large.
    const moves: { d: number; c: number; amount: number; score: number }[] = []
    for (let d = 0; d < amounts.length; d++) {
      if (amounts[d] >= 0) continue
      for (let c = 0; c < amounts.length; c++) {
        if (amounts[c] <= 0) continue
        const amount = Math.min(-amounts[d], amounts[c])
        if (amount <= bestMin) continue
        const left = Math.abs(amounts[c] + amounts[d])
        moves.push({ d, c, amount, score: left === 0 ? amount : Math.min(amount, left) })
      }
    }
    moves.sort((x, y) => y.score - x.score || y.amount - x.amount || x.d - y.d || x.c - y.c)
    for (const { d, c, amount } of moves) {
      if (amount <= bestMin || budget <= 0) continue
      amounts[d] += amount
      amounts[c] -= amount
      path.push({ from: ids[d], to: ids[c], amount })
      search(Math.min(pathMin, amount))
      path.pop()
      amounts[d] -= amount
      amounts[c] += amount
    }
  }
  search(Infinity)
  return best
}

/**
 * Above this many balances (left after exact pairs are taken out) the exact
 * search is skipped. Its cost is about n·2^n steps and 9·2^n bytes, so 20
 * means roughly 20 million steps and 9 MB: well under a second on a phone.
 */
export const EXACT_SETTLEMENT_LIMIT = 20

/**
 * Splits balances that sum to zero into the largest possible number of
 * disjoint groups that each sum to zero. A group of k people settles in k - 1
 * transfers, so n balances in g groups need n - g transfers, and maximising g
 * gives the fewest transfers possible.
 *
 * Dynamic programming over subsets: best[mask] is the most zero-sum groups the
 * members of `mask` can be cut into along a chain of removals, plus one when
 * `mask` itself sums to zero. Ties are always broken toward the lowest index,
 * so the same input gives the same groups on every device.
 */
function zeroSumGroups(entries: Entry[]): Entry[][] {
  const n = entries.length
  const size = 1 << n
  const sums = new Float64Array(size)
  const best = new Uint8Array(size)
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask
    sums[mask] = sums[mask ^ low] + entries[31 - Math.clz32(low)].total
    let most = 0
    for (let rest = mask; rest !== 0; rest &= rest - 1) {
      const value = best[mask ^ (rest & -rest)]
      if (value > most) most = value
    }
    best[mask] = most + (sums[mask] === 0 ? 1 : 0)
  }

  // Walk back down the chain, cutting a group off each time the remaining
  // members sum to zero again.
  const groups: Entry[][] = []
  let current: Entry[] = []
  let mask = size - 1
  while (mask !== 0) {
    const target = best[mask] - (sums[mask] === 0 ? 1 : 0)
    let rest = mask
    let bit = rest & -rest
    while (best[mask ^ bit] !== target) {
      rest ^= bit
      bit = rest & -rest
    }
    current.push(entries[31 - Math.clz32(bit)])
    mask ^= bit
    if (sums[mask] === 0) {
      groups.push(current)
      current = []
    }
  }
  return groups
}

/**
 * Suggests the fewest transfers that settle every balance.
 *
 * 1. A debtor who owes exactly what a creditor is owed pays them directly; some
 *    optimal solution always does this, and it shrinks the search.
 * 2. The rest is split into as many zero-sum groups as possible (exactly while
 *    at most EXACT_SETTLEMENT_LIMIT balances remain).
 * 3. Each group is settled in its k - 1 transfers, choosing the plan whose
 *    smallest transfer is the largest. Above the limit, Spliit's greedy
 *    pairing settles the rest as before.
 *
 * Amounts are integer minor units. Everything is ordered by participant id
 * with plain code-unit comparison, so every phone computes the same list.
 */
export function getSuggestedReimbursements(balances: Balances): Reimbursement[] {
  const entries: Entry[] = Object.entries(balances)
    .map(([participantId, { total }]) => ({ participantId, total }))
    .filter((b) => b.total !== 0)
    .sort((a, b) => (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))

  const total = entries.reduce((sum, b) => sum + b.total, 0)
  // Balances always sum to zero; if they somehow don't, keep the old behaviour.
  if (total !== 0) return clean(greedyReimbursements(entries))

  const reimbursements: Reimbursement[] = []

  // 1. Exact opposite pairs, matched in id order.
  const waiting = new Map<number, Entry[]>()
  const unmatched: Entry[] = []
  for (const entry of entries) {
    const partners = waiting.get(-entry.total)
    if (partners && partners.length > 0) {
      const partner = partners.shift()!
      const [debtor, creditor] = entry.total < 0 ? [entry, partner] : [partner, entry]
      reimbursements.push({ from: debtor.participantId, to: creditor.participantId, amount: creditor.total })
      unmatched.splice(unmatched.indexOf(partner), 1)
    } else {
      const list = waiting.get(entry.total) ?? []
      list.push(entry)
      waiting.set(entry.total, list)
      unmatched.push(entry)
    }
  }

  // 2. Largest number of zero-sum groups, each settled greedily.
  if (unmatched.length <= EXACT_SETTLEMENT_LIMIT) {
    for (const group of zeroSumGroups(unmatched)) reimbursements.push(...settleWithoutTinyTransfers(group))
  } else {
    reimbursements.push(...greedyReimbursements(unmatched))
  }

  return clean(reimbursements)
}

function clean(reimbursements: Reimbursement[]): Reimbursement[] {
  return reimbursements.filter(({ amount }) => Math.round(amount) + 0 !== 0)
}
