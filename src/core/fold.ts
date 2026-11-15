import { baseHlc, hlcPhysical, isValidHlc, RESERVED_DEVICE } from './hlc'
import { nextDate } from './recurrence'
import type {
  Device,
  Expense,
  GroupMeta,
  GroupState,
  Money,
  Op,
  Participant,
  Recurrence,
  Register,
} from './types'
import { dateToUtcMs, localToday, sha256Hex } from './util'

/** Ops more than this far ahead of the local clock are held, not applied. */
export const HOLD_AHEAD_MS = 60 * 60 * 1000
/** Safety cap on derived occurrences per template (≈ 10 years of daily). */
const MAX_OCCURRENCES = 3700

const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekly', 'monthly', 'yearly']

export function compareOps(a: Op, b: Op): number {
  return a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0
}

export function isValidOp(op: unknown): op is Op {
  const o = op as Op
  return (
    !!o &&
    typeof o.opId === 'string' &&
    typeof o.groupId === 'string' &&
    ['group', 'participant', 'expense', 'device'].includes(o.entity) &&
    typeof o.entityId === 'string' &&
    !!o.set &&
    typeof o.set === 'object' &&
    !Array.isArray(o.set) &&
    isValidHlc(o.hlc) &&
    typeof o.author === 'string'
  )
}

type Fields = Map<string, Register>

function writeRegisters(fields: Fields, op: Op) {
  for (const [field, value] of Object.entries(op.set)) {
    const cur = fields.get(field)
    if (!cur || op.hlc > cur.hlc || (op.hlc === cur.hlc && op.opId > cur.opId))
      fields.set(field, { value, hlc: op.hlc, author: op.author, opId: op.opId })
  }
}

/** LWW registers of the ops whose HLC is ≤ `cutoff` (ops must be sorted). */
function asOf(sorted: Op[], cutoff: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const op of sorted) {
    if (op.hlc > cutoff) break
    Object.assign(out, op.set)
  }
  return out
}

export type FoldOptions = {
  /** Local clock, ms. */
  now?: number
  /** Local date (YYYY-MM-DD) up to which recurring occurrences exist. */
  today?: string
}

export type FoldResult = GroupState & {
  /** Per-entity, per-field registers (used for snapshots and the edit form). */
  registers: Map<string, Fields>
  /** Applied ops per expense (sorted), for activity and recurring templates. */
  expenseOps: Map<string, Op[]>
}

export const entityKey = (entity: string, id: string) => `${entity}|${id}`

/**
 * The state is a pure function of the *set* of ops: order and duplicates don't
 * matter. Ops from the future are held; recurring occurrences are derived here.
 */
export function fold(groupId: string, ops: Iterable<Op>, opts: FoldOptions = {}): FoldResult {
  const now = opts.now ?? Date.now()
  const today = opts.today ?? localToday(now)
  const seen = new Set<string>()
  const held: Op[] = []
  const registers = new Map<string, Fields>()
  const expenseOps = new Map<string, Op[]>()

  for (const op of ops) {
    if (!isValidOp(op) || op.groupId !== groupId || seen.has(op.opId)) continue
    seen.add(op.opId)
    if (hlcPhysical(op.hlc) > now + HOLD_AHEAD_MS) {
      held.push(op)
      continue
    }
    const key = entityKey(op.entity, op.entityId)
    let fields = registers.get(key)
    if (!fields) registers.set(key, (fields = new Map()))
    writeRegisters(fields, op)
    if (op.entity === 'expense') {
      let list = expenseOps.get(op.entityId)
      if (!list) expenseOps.set(op.entityId, (list = []))
      list.push(op)
    }
  }
  for (const list of expenseOps.values()) list.sort(compareOps)
  held.sort(compareOps)

  // Recurring templates → derived occurrences with a fixed, lowest-ranking HLC.
  for (const [templateId, list] of expenseOps) {
    const recStart = list.find((op) => typeof op.set.recurrence === 'string' && op.set.recurrence !== 'none')
    if (!recStart) continue
    deriveOccurrences(templateId, list, recStart, today, registers)
  }

  const val = (key: string, field: string) => registers.get(key)?.get(field)?.value
  const gk = entityKey('group', groupId)
  const relays = val(gk, 'relays')
  const group: GroupMeta = {
    id: groupId,
    name: str(val(gk, 'name')),
    currency: str(val(gk, 'currency')) || 'EUR',
    information: str(val(gk, 'information')),
    relays: Array.isArray(relays) ? relays.filter((r) => typeof r === 'string') : [],
  }
  const movedOn = val(gk, 'movedOn')
  if (typeof movedOn === 'number') group.movedOn = movedOn

  const participants: Participant[] = []
  const devices: Device[] = []
  const expenses: Expense[] = []
  for (const [key, fields] of registers) {
    const [entity, id] = splitKey(key)
    const v = (f: string) => fields.get(f)?.value
    if (entity === 'participant') {
      const household = v('household')
      participants.push({
        id,
        name: str(v('name')) || '?',
        deleted: v('deleted') === true,
        ...(typeof household === 'string' && household && household !== id ? { household } : {}),
      })
    } else if (entity === 'device') {
      let first = ''
      for (const r of fields.values()) if (!first || r.hlc < first) first = r.hlc
      devices.push({
        pubkey: id,
        participantId: typeof v('participantId') === 'string' ? (v('participantId') as string) : undefined,
        label: typeof v('label') === 'string' ? (v('label') as string) : undefined,
        firstSeen: first,
      })
    } else if (entity === 'expense') {
      const e = buildExpense(id, fields)
      if (e) expenses.push(e)
    }
  }
  participants.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
  expenses.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.created < b.created ? 1 : -1))
  devices.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : 1))

  return { group, participants, expenses, devices, held, registers, expenseOps }
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf('|')
  return [key.slice(0, i), key.slice(i + 1)]
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function occurrenceId(templateId: string, date: string): string {
  return 'r' + sha256Hex(templateId + ':' + date).slice(0, 31)
}

function deriveOccurrences(
  templateId: string,
  list: Op[],
  recStart: Op,
  today: string,
  registers: Map<string, Fields>,
) {
  const stateAt = (date: string) => {
    const cutoff = baseHlc(dateToUtcMs(date))
    return asOf(list, cutoff > recStart.hlc ? cutoff : recStart.hlc)
  }
  const anchor = asOf(list, recStart.hlc)
  const anchorDate = anchor.date
  if (typeof anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) return
  const anchorDay = Number(anchorDate.slice(8, 10))
  let rule = anchor.recurrence as Recurrence
  if (!RECURRENCES.includes(rule) || rule === 'none') return

  let cur = anchorDate
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const next = nextDate(cur, rule as Exclude<Recurrence, 'none'>, anchorDay)
    if (next > today) break
    const st = stateAt(next)
    const stRule = st.recurrence as Recurrence
    if (RECURRENCES.includes(stRule) && stRule !== 'none' && st.deleted !== true) {
      const hlc = baseHlc(dateToUtcMs(next))
      const id = occurrenceId(templateId, next)
      const key = entityKey('expense', id)
      let fields = registers.get(key)
      if (!fields) registers.set(key, (fields = new Map()))
      const base: Record<string, unknown> = {
        title: st.title,
        category: st.category,
        notes: st.notes,
        paidBy: st.paidBy,
        money: st.money,
        isReimbursement: st.isReimbursement,
        date: next,
        recurrence: 'none',
        deleted: false,
        recurringFrom: templateId,
      }
      writeRegisters(fields, { opId: '', groupId: '', entity: 'expense', entityId: id, set: base, hlc, author: RESERVED_DEVICE })
    }
    if (RECURRENCES.includes(stRule) && stRule !== 'none') rule = stRule
    cur = next
  }
}

export function sanitizeMoney(m: unknown): Money | null {
  const o = m as Money
  if (!o || typeof o !== 'object' || !Number.isFinite(o.amount) || !Array.isArray(o.paidFor)) return null
  const splitMode = (['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'] as const).includes(o.splitMode)
    ? o.splitMode
    : 'EVENLY'
  return {
    ...o,
    amount: Math.round(o.amount),
    currency: typeof o.currency === 'string' ? o.currency : '',
    splitMode,
    paidFor: o.paidFor
      .filter((p) => p && typeof p.participantId === 'string')
      .map((p) => ({ participantId: p.participantId, shares: Number(p.shares) || 0 })),
  }
}

/** True when the stored split doesn't add up; balances then apply it pro rata. */
export function isInconsistent(m: Money): boolean {
  if (m.paidFor.length === 0) return true
  if (m.paidFor.some((p) => p.shares < 0)) return true
  const sum = m.paidFor.reduce((s, p) => s + p.shares, 0)
  if (m.splitMode === 'BY_AMOUNT') return sum !== m.amount
  if (m.splitMode === 'BY_PERCENTAGE') return sum !== 10000
  if (m.splitMode === 'BY_SHARES') return sum <= 0
  return false
}

function buildExpense(id: string, fields: Fields): Expense | null {
  const v = (f: string) => fields.get(f)?.value
  const money = sanitizeMoney(v('money'))
  const title = v('title')
  const date = v('date')
  const paidBy = v('paidBy')
  // Ops can arrive in any order; an expense is shown once its creating fields are known.
  if (!money || typeof title !== 'string' || typeof date !== 'string' || typeof paidBy !== 'string') return null
  let created = ''
  let createdBy = ''
  let updated = ''
  for (const r of fields.values()) {
    if (!created || r.hlc < created) {
      created = r.hlc
      createdBy = r.author
    }
    if (r.hlc > updated) updated = r.hlc
  }
  const rec = v('recurrence') as Recurrence
  const e: Expense = {
    id,
    title,
    date,
    category: Number(v('category')) || 0,
    notes: str(v('notes')),
    paidBy,
    money,
    isReimbursement: v('isReimbursement') === true,
    recurrence: RECURRENCES.includes(rec) ? rec : 'none',
    deleted: v('deleted') === true,
    updated,
    created,
    createdBy,
  }
  const rf = v('recurringFrom')
  if (typeof rf === 'string') e.recurringFrom = rf
  if (isInconsistent(money)) e.inconsistent = true
  return e
}
