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

export function getSuggestedReimbursements(balances: Balances): Reimbursement[] {
  const balancesArray = Object.entries(balances)
    .map(([participantId, { total }]) => ({ participantId, total }))
    .filter((b) => b.total !== 0)
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
  return reimbursements.filter(({ amount }) => Math.round(amount) + 0 !== 0)
}
