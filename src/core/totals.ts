// Adapted from Spliit src/lib/totals.ts (MIT, Copyright (c) 2023 Sebastien Castiel).
import { getExpenseShares, getParticipantShare } from './shares'
import { toLedger } from './balances'
import type { Expense, Recurrence } from './types'

type E = Pick<Expense, 'id' | 'title' | 'date' | 'category' | 'paidBy' | 'money' | 'isReimbursement'> & {
  recurrence?: Recurrence
}

export function filterExpensesByDateRange<T extends { date: string }>(expenses: T[], from?: string, to?: string): T[] {
  if (!from && !to) return expenses
  return expenses.filter((e) => !((from && e.date < from) || (to && e.date > to)))
}

export function getTotalGroupSpending(expenses: E[]): number {
  return expenses.reduce((t, e) => (e.isReimbursement ? t : t + e.money.amount), 0)
}

export function getTotalActiveUserPaidFor(activeUserId: string | null, expenses: E[]): number {
  return expenses.reduce((t, e) => (e.paidBy === activeUserId && !e.isReimbursement ? t + e.money.amount : t), 0)
}

/** A participant's share of one expense. Reimbursements count as zero here. */
export function calculateShare(participantId: string | null, expense: E): number {
  if (expense.isReimbursement) return 0
  return getParticipantShare(participantId, toLedger(expense as Expense))
}

export function getTotalActiveUserShare(activeUserId: string | null, expenses: E[]): number {
  return expenses.reduce((sum, e) => sum + calculateShare(activeUserId, e), 0)
}

export type CategorySpending = { categoryId: number; total: number }

export function getSpendingByCategory(expenses: E[]): CategorySpending[] {
  const byCategory = new Map<number, CategorySpending>()
  for (const e of expenses) {
    if (e.isReimbursement) continue
    const id = e.category ?? 0
    const existing = byCategory.get(id)
    if (existing) existing.total += e.money.amount
    else byCategory.set(id, { categoryId: id, total: e.money.amount })
  }
  return [...byCategory.values()].filter((c) => c.total !== 0).sort((a, b) => b.total - a.total)
}

export type ParticipantSpending = { participantId: string; name: string; paid: number; paidCount: number; share: number }

export function getSpendingByParticipant(participants: { id: string; name: string }[], expenses: E[]): ParticipantSpending[] {
  const totals = new Map<string, { paid: number; paidCount: number; share: number }>()
  for (const p of participants) totals.set(p.id, { paid: 0, paidCount: 0, share: 0 })
  for (const e of expenses) {
    if (e.isReimbursement) continue
    const payer = totals.get(e.paidBy)
    if (payer) {
      payer.paid += e.money.amount
      payer.paidCount += 1
    }
    for (const [pid, share] of getExpenseShares(toLedger(e as Expense))) {
      const entry = totals.get(pid)
      if (entry) entry.share += share
    }
  }
  return participants
    .map((p) => ({ participantId: p.id, name: p.name, ...totals.get(p.id)! }))
    .sort((a, b) => b.paid - a.paid)
}

export type MonthlySpending = { month: string; total: number }

export function getSpendingOverTime(expenses: E[]): MonthlySpending[] {
  const totals = new Map<string, number>()
  for (const e of expenses) {
    if (e.isReimbursement) continue
    const month = e.date.slice(0, 7)
    totals.set(month, (totals.get(month) ?? 0) + e.money.amount)
  }
  if (totals.size === 0) return []
  const months = [...totals.keys()].sort()
  const [fy, fm] = months[0].split('-').map(Number)
  const [ly, lm] = months[months.length - 1].split('-').map(Number)
  const result: MonthlySpending[] = []
  let y = fy
  let m = fm
  while (y < ly || (y === ly && m <= lm)) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    result.push({ month: key, total: totals.get(key) ?? 0 })
    if (++m > 12) {
      m = 1
      y++
    }
  }
  return result
}

export type SpendingSummary = {
  expenseCount: number
  totalSpending: number
  averageExpense: number
  largestExpense: { title: string; amount: number } | null
  firstDate: string | null
  lastDate: string | null
}

export function getSpendingSummary(expenses: E[]): SpendingSummary {
  const relevant = expenses.filter((e) => !e.isReimbursement)
  const expenseCount = relevant.length
  const totalSpending = relevant.reduce((t, e) => t + e.money.amount, 0)
  let largestExpense: SpendingSummary['largestExpense'] = null
  for (const e of relevant)
    if (!largestExpense || e.money.amount > largestExpense.amount)
      largestExpense = { title: e.title, amount: e.money.amount }
  const dates = relevant.map((e) => e.date).sort()
  return {
    expenseCount,
    totalSpending,
    averageExpense: expenseCount ? Math.round(totalSpending / expenseCount) : 0,
    largestExpense,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  }
}

const PERIOD_FACTORS: Record<Exclude<Recurrence, 'none'>, { perMonth: number; perYear: number }> = {
  daily: { perMonth: 365.25 / 12, perYear: 365.25 },
  weekly: { perMonth: 365.25 / 12 / 7, perYear: 365.25 / 7 },
  monthly: { perMonth: 1, perYear: 12 },
  yearly: { perMonth: 1 / 12, perYear: 1 },
}

export type RecurringSpending = {
  count: number
  byPeriod: { period: Exclude<Recurrence, 'none'>; count: number; total: number }[]
  estimatedMonthly: number
  estimatedYearly: number
}

export function getRecurringSpending(expenses: E[]): RecurringSpending {
  const byPeriod = (Object.keys(PERIOD_FACTORS) as Exclude<Recurrence, 'none'>[]).map((period) => {
    const matching = expenses.filter((e) => !e.isReimbursement && e.recurrence === period)
    return { period, count: matching.length, total: matching.reduce((s, e) => s + e.money.amount, 0) }
  })
  const estimate = (f: 'perMonth' | 'perYear') =>
    Math.round(byPeriod.reduce((s, { period, total }) => s + total * PERIOD_FACTORS[period][f], 0))
  return {
    count: byPeriod.reduce((s, { count }) => s + count, 0),
    byPeriod: byPeriod.filter(({ count }) => count > 0),
    estimatedMonthly: estimate('perMonth'),
    estimatedYearly: estimate('perYear'),
  }
}
