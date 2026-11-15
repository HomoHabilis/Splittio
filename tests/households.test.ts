import { describe, expect, it } from 'vitest'
import { getBalances, type LedgerExpense } from '../src/core/balances'
import { getHouseholdReimbursements, householdBalances, householdMembers, resolveHouseholds } from '../src/core/households'

function evenly(id: string, paidBy: string, amount: number, paidFor: string[]): LedgerExpense {
  return { id, amount, paidBy, splitMode: 'EVENLY', paidFor: paidFor.map((p) => ({ participantId: p, shares: 100 })) }
}

describe('resolveHouseholds', () => {
  it('maps members to their representative and everyone else to themselves', () => {
    const reps = resolveHouseholds([{ id: 'alice' }, { id: 'bob', household: 'alice' }, { id: 'carol' }])
    expect(Object.fromEntries(reps)).toEqual({ alice: 'alice', bob: 'alice', carol: 'carol' })
  })

  it('ignores unknown representatives and chains, so concurrent edits cannot loop', () => {
    const reps = resolveHouseholds([
      { id: 'a', household: 'b' },
      { id: 'b', household: 'a' },
      { id: 'c', household: 'ghost' },
      { id: 'd', household: 'e' },
      { id: 'e', household: 'f' },
      { id: 'f' },
    ])
    expect(Object.fromEntries(reps)).toEqual({ a: 'a', b: 'b', c: 'c', d: 'd', e: 'f', f: 'f' })
  })

  it('lists the members of households with more than one person', () => {
    const members = householdMembers([{ id: 'a' }, { id: 'b', household: 'a' }, { id: 'c' }])
    expect(Object.fromEntries(members)).toEqual({ a: ['a', 'b'] })
  })
})

describe('household reimbursements', () => {
  // Dinner for 6: Alice paid 120, Dave paid 60. Alice & Bob are a couple, so are Carol & Dave.
  const people = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
  const expenses = [evenly('e1', 'alice', 12000, people), evenly('e2', 'dave', 6000, people)]
  const participants = [
    { id: 'alice' },
    { id: 'bob', household: 'alice' },
    { id: 'carol', household: 'dave' },
    { id: 'dave' },
    { id: 'erin' },
    { id: 'frank' },
  ]

  it('keeps one share per person', () => {
    const balances = getBalances(expenses)
    for (const id of people) expect(balances[id].paidFor).toBe(3000)
  })

  it('adds up each household under its representative', () => {
    const grouped = householdBalances(getBalances(expenses), resolveHouseholds(participants))
    expect(grouped.alice.total).toBe(12000 - 6000)
    expect(grouped.dave.total).toBe(6000 - 6000)
    expect(grouped.bob).toBeUndefined()
    expect(Object.values(grouped).reduce((s, b) => s + b.total, 0)).toBe(0)
  })

  it('settles each household with one transfer at most, between representatives', () => {
    const reimbursements = getHouseholdReimbursements(getBalances(expenses), participants)

    // Carol & Dave are already even as a household; Erin and Frank each owe 30 to the Alice household.
    expect(reimbursements).toHaveLength(2)
    expect(reimbursements).toContainEqual({ from: 'erin', to: 'alice', amount: 3000 })
    expect(reimbursements).toContainEqual({ from: 'frank', to: 'alice', amount: 3000 })
  })

  it('needs no more transfers once the representatives book them', () => {
    const settled = [
      ...expenses,
      ...getHouseholdReimbursements(getBalances(expenses), participants).map(({ from, to, amount }, i) => ({
        ...evenly(`s${i}`, from, amount, [to]),
        isReimbursement: true,
      })),
    ]
    expect(getHouseholdReimbursements(getBalances(settled), participants)).toEqual([])
  })

  it('is the plain per-person settle-up when nobody is in a household', () => {
    const reimbursements = getHouseholdReimbursements(getBalances(expenses), people.map((id) => ({ id })))
    // Alice +90, Dave +30 and four people at −30: Dave takes one of them, Alice the rest.
    expect(reimbursements).toHaveLength(4)
  })
})
