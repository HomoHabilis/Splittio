export type EntityKind = 'group' | 'participant' | 'expense' | 'device'

/** An immutable change. The app state is a deterministic fold of all known ops. */
export type Op = {
  opId: string
  groupId: string
  entity: EntityKind
  entityId: string
  set: Record<string, unknown>
  hlc: string
  /** Device public key (hex). Taken from the Nostr signature for remote ops. */
  author: string
}

export type SplitMode = 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE' | 'BY_AMOUNT'

export type PaidFor = { participantId: string; shares: number }

/**
 * Amount, currency, conversion and split are one atomic field so that a split
 * always belongs to the amount it was made for. Amounts are integer cents.
 * BY_PERCENTAGE shares are basis points (10000 = 100%), BY_AMOUNT shares are
 * cents, BY_SHARES shares are any positive integer (Spliit uses 100 per share).
 */
export type Money = {
  amount: number
  currency: string
  originalAmount?: number
  originalCurrency?: string
  rate?: number
  splitMode: SplitMode
  paidFor: PaidFor[]
}

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export type Expense = {
  id: string
  title: string
  /** YYYY-MM-DD */
  date: string
  category: number
  notes: string
  paidBy: string
  money: Money
  isReimbursement: boolean
  recurrence: Recurrence
  deleted: boolean
  /** Set on occurrences derived from a recurring template. */
  recurringFrom?: string
  /** The split doesn't add up (old/buggy client or import); shares are applied pro rata. */
  inconsistent?: boolean
  /** HLC of the latest write to this expense. */
  updated: string
  /** HLC and device of the first write. */
  created: string
  createdBy: string
}

export type Participant = { id: string; name: string; deleted: boolean }

export type Device = { pubkey: string; participantId?: string; label?: string; firstSeen: string }

export type GroupMeta = {
  id: string
  name: string
  currency: string
  information: string
  relays: string[]
  /** Set when the group was re-keyed into a new group. */
  movedOn?: number
}

export type Register = { value: unknown; hlc: string; author: string; opId: string }

export type GroupState = {
  group: GroupMeta
  participants: Participant[]
  /** All expenses including deleted ones (filter on `deleted`). */
  expenses: Expense[]
  devices: Device[]
  /** Ops whose clock is more than an hour ahead; applied once ours catches up. */
  held: Op[]
}
