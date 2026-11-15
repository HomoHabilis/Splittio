import { getSuggestedReimbursements, type Balances, type Reimbursement } from './balances'
import type { Participant } from './types'

/**
 * Maps every participant to the one who settles up for them: their
 * household's representative, or themselves.
 *
 * Only one level is followed: a participant joins a household only if the
 * participant they point to is known and doesn't point anywhere themselves.
 * Two phones editing at once can create a chain or a loop (A → B while B → A);
 * this rule still gives every phone the same answer, with no loop to follow.
 */
export function resolveHouseholds(participants: Pick<Participant, 'id' | 'household'>[]): Map<string, string> {
  const pointsTo = new Map(participants.map((p) => [p.id, p.household]))
  const result = new Map<string, string>()
  for (const p of participants) {
    const rep = p.household
    const valid = rep !== undefined && rep !== p.id && pointsTo.has(rep) && pointsTo.get(rep) === undefined
    result.set(p.id, valid ? rep : p.id)
  }
  return result
}

/** Adds up the balances of each household under its representative's id. */
export function householdBalances(balances: Balances, reps: Map<string, string>): Balances {
  const grouped: Balances = {}
  for (const [id, b] of Object.entries(balances)) {
    const rep = reps.get(id) ?? id
    const g = (grouped[rep] ??= { paid: 0, paidFor: 0, total: 0 })
    g.paid += b.paid
    g.paidFor += b.paidFor
    g.total += b.total
  }
  return grouped
}

/**
 * The fewest transfers that settle the group, with every household paying or
 * receiving once, through its representative.
 */
export function getHouseholdReimbursements(
  balances: Balances,
  participants: Pick<Participant, 'id' | 'household'>[],
): Reimbursement[] {
  return getSuggestedReimbursements(householdBalances(balances, resolveHouseholds(participants)))
}

/** The members of each household with more than one person, keyed by representative. */
export function householdMembers(participants: Pick<Participant, 'id' | 'household'>[]): Map<string, string[]> {
  const reps = resolveHouseholds(participants)
  const members = new Map<string, string[]>()
  for (const p of participants) {
    const rep = reps.get(p.id)!
    const list = members.get(rep) ?? []
    list.push(p.id)
    members.set(rep, list)
  }
  for (const [rep, list] of members) if (list.length < 2) members.delete(rep)
  return members
}
