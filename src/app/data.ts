import type { Event } from 'nostr-tools/pure'
import { CATEGORIES, categoryByName } from '../core/categories'
import { getExpenseShares } from '../core/shares'
import type { Money, Recurrence, SplitMode } from '../core/types'
import { b64Decode, b64Encode, uuid } from '../core/util'
import type { GroupRecord, StoredOp } from '../store/db'
import { app, type GroupView } from './app'

// ---------- CSV / JSON export ----------

/** Text starting with these is run as a formula by Excel, Sheets and LibreOffice. */
const FORMULA_START = /^[=+\-@\t\r]/
const NUMBER = /^-?\d+(\.\d+)?$/

function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v)
  // A member could title an expense "=HYPERLINK(…)": prefix ' so spreadsheets show it as text.
  if (FORMULA_START.test(s) && !NUMBER.test(s)) s = "'" + s
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function exportCsv(view: GroupView): string {
  const { state } = view
  const people = state.participants
  const names = new Map(people.map((p) => [p.id, p.name]))
  const header = ['Date', 'Title', 'Category', 'Amount', 'Currency', 'Original amount', 'Original currency', 'Rate', 'Paid by', 'Reimbursement', 'Split mode', 'Notes', ...people.map((p) => p.name)]
  const rows = state.expenses
    .filter((e) => !e.deleted)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => {
      const shares = getExpenseShares({ id: e.id, amount: e.money.amount, splitMode: e.money.splitMode, paidFor: e.money.paidFor })
      return [
        e.date,
        e.title,
        CATEGORIES.find((c) => c.id === e.category)?.name ?? '',
        (e.money.amount / 100).toFixed(2),
        state.group.currency,
        e.money.originalAmount !== undefined ? (e.money.originalAmount / 100).toFixed(2) : '',
        e.money.originalCurrency ?? '',
        e.money.rate ?? '',
        names.get(e.paidBy) ?? '',
        e.isReimbursement ? 'yes' : '',
        e.money.splitMode,
        e.notes,
        ...people.map((p) => (shares.has(p.id) ? (shares.get(p.id)! / 100).toFixed(2) : '')),
      ]
    })
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

export function exportJson(view: GroupView): string {
  const { state } = view
  return JSON.stringify(
    {
      app: 'splittio',
      exportedAt: new Date().toISOString(),
      group: state.group,
      participants: state.participants,
      expenses: state.expenses,
    },
    null,
    2,
  )
}

// ---------- Encrypted backup (passphrase, PBKDF2 + AES-GCM) ----------

type BackupGroup = { record: GroupRecord; events: Event[]; ops: StoredOp[] }
type BackupContent = { app: 'splittio-backup'; v: 1; createdAt: number; groups: BackupGroup[] }

const ITERATIONS = 600_000

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/**
 * Full backup of the chosen groups: keys, every signed event (byte for byte, so
 * they can be re-published) and ops that aren't in an event yet (outbox, snapshot).
 */
export async function makeBackup(groupIds: string[], passphrase: string): Promise<string> {
  const groups: BackupGroup[] = []
  for (const id of groupIds) {
    const record = await app.store.getGroup(id)
    if (!record) continue
    const events = (await app.store.groupEvents(id)).map((e) => e.event)
    const ops = (await app.store.groupOps(id)).filter((o) => !o.eventId)
    groups.push({ record, events, ops })
  }
  const content: BackupContent = { app: 'splittio-backup', v: 1, createdAt: Date.now(), groups }
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(content))))
  return JSON.stringify({ app: 'splittio-backup', v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64Encode(salt), iv: b64Encode(iv), data: b64Encode(ct) })
}

export async function readBackup(text: string, passphrase: string): Promise<BackupContent> {
  const o = JSON.parse(text)
  if (o.app !== 'splittio-backup') throw new Error('not a Splittio backup')
  const key = await deriveKey(passphrase, b64Decode(o.salt))
  let plain: ArrayBuffer
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64Decode(o.iv) as BufferSource }, key, b64Decode(o.data) as BufferSource)
  } catch {
    throw new Error('wrong passphrase')
  }
  return JSON.parse(new TextDecoder().decode(plain))
}

/** Restores groups from a backup. Events are verified and decrypted like relay events. */
export async function restoreBackup(content: BackupContent): Promise<string[]> {
  const ids: string[] = []
  for (const g of content.groups) {
    if (!app.groups.has(g.record.id)) {
      await app.store.putGroup({ ...g.record, historyFrom: undefined })
      await app.joinGroup({ v: 1, groupId: g.record.id, key: g.record.key, relays: g.record.relays, name: g.record.name })
    }
    const sync = app.sync(g.record.id)
    for (const ev of g.events) await sync?.receive(null, ev)
    await app.store.putOps(g.ops)
    await app.refold(g.record.id)
    void sync?.reconcileAll(true) // re-publishes whatever relays lost
    ids.push(g.record.id)
  }
  return ids
}

// ---------- Import (Splittio CSV/JSON exports, Spliit JSON) ----------

/** A source-neutral expense row, with people referred to by name. */
export type ImportRow = {
  date: string
  title: string
  category: number
  amount: number
  originalAmount?: number
  originalCurrency?: string
  rate?: number
  paidBy: string
  isReimbursement: boolean
  splitMode: SplitMode
  notes: string
  /** Participant name → shares (in the unit of the split mode). */
  shares: [string, number][]
}

export type ParsedImport = { name?: string; currency?: string; information?: string; participants: string[]; rows: ImportRow[] }

const SPLIT_MODES: SplitMode[] = ['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT']

/** RFC 4180-ish CSV parser; detects "," or ";" as the delimiter. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '')
  const firstLine = src.split(/\r?\n/, 1)[0]
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (q) {
      if (c === '"' && src[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === delim) row.push(cell), (cell = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) row.push(cell), rows.push(row)
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function toCents(s: string | undefined): number | undefined {
  if (s === undefined || s.trim() === '') return undefined
  const n = Number(s.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? Math.round(n * 100) : undefined
}

function categoryFrom(v: unknown): number {
  if (typeof v === 'number') return CATEGORIES.some((c) => c.id === v) ? v : 0
  const s = String(v ?? '').trim().toLowerCase()
  return CATEGORIES.find((c) => c.name.toLowerCase() === s)?.id ?? 0
}

/** Undoes csvCell's formula guard. */
const unguard = (s: string) => (s.startsWith("'") && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s)

/** Parses Splittio's CSV export (or a spreadsheet with the same columns). */
export function parseSplittioCsv(text: string): ParsedImport {
  const [header, ...lines] = parseCsv(text)
  if (!header) throw new Error('empty file')
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
  const iDate = col('Date'), iTitle = col('Title'), iAmount = col('Amount'), iPaidBy = col('Paid by')
  if (iDate < 0 || iTitle < 0 || iAmount < 0 || iPaidBy < 0) throw new Error('CSV needs at least the columns Date, Title, Amount and Paid by')
  const known = ['date', 'title', 'category', 'amount', 'currency', 'original amount', 'original currency', 'rate', 'paid by', 'reimbursement', 'split mode', 'notes']
  const people = header.map((h, i) => [unguard(h.trim()), i] as const).filter(([h]) => h && !known.includes(h.toLowerCase()))
  const get = (l: string[], name: string) => {
    const i = col(name)
    return i >= 0 ? (l[i] ?? '').trim() : ''
  }
  const participants = new Set(people.map(([h]) => h))
  const rows: ImportRow[] = []
  for (const l of lines) {
    const amount = toCents(l[iAmount])
    const date = (l[iDate] ?? '').trim().slice(0, 10)
    if (amount === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const paidBy = unguard((l[iPaidBy] ?? '').trim())
    participants.add(paidBy)
    const shares: [string, number][] = []
    for (const [name, i] of people) {
      const v = toCents(l[i])
      if (v !== undefined) shares.push([name, v])
    }
    const mode = get(l, 'Split mode').toUpperCase() as SplitMode
    const evenly = mode === 'EVENLY' || shares.length === 0
    rows.push({
      date,
      title: unguard((l[iTitle] ?? '').trim()),
      category: categoryFrom(get(l, 'Category')),
      amount,
      originalAmount: toCents(get(l, 'Original amount')),
      originalCurrency: get(l, 'Original currency') || undefined,
      rate: Number(get(l, 'Rate')) || undefined,
      paidBy,
      isReimbursement: /^(yes|true|1|oui|sì|si)$/i.test(get(l, 'Reimbursement')),
      // Per-person amounts are exact, so anything but "evenly" comes back as "by amount".
      splitMode: evenly ? 'EVENLY' : 'BY_AMOUNT',
      notes: unguard(get(l, 'Notes')),
      shares: evenly ? (shares.length ? shares.map(([n]) => [n, 1]) : [...participants].map((n) => [n, 1])) : shares,
    })
  }
  return { participants: [...participants].filter(Boolean), rows }
}

/** Parses Splittio's JSON export or Spliit's JSON export. */
export function parseJsonExport(text: string): ParsedImport {
  const j = JSON.parse(text)
  if (j?.app === 'splittio') {
    const names = new Map<string, string>((j.participants ?? []).map((p: { id: string; name: string }) => [p.id, p.name]))
    const rows: ImportRow[] = (j.expenses ?? [])
      .filter((e: { deleted?: boolean; recurringFrom?: string }) => !e.deleted)
      .map((e: { date: string; title: string; category: number; notes: string; paidBy: string; isReimbursement: boolean; money: Money }) => ({
        date: e.date,
        title: e.title,
        category: categoryFrom(e.category),
        amount: e.money.amount,
        originalAmount: e.money.originalAmount,
        originalCurrency: e.money.originalCurrency,
        rate: e.money.rate,
        paidBy: names.get(e.paidBy) ?? '?',
        isReimbursement: !!e.isReimbursement,
        splitMode: SPLIT_MODES.includes(e.money.splitMode) ? e.money.splitMode : 'EVENLY',
        notes: e.notes ?? '',
        shares: e.money.paidFor.map((p) => [names.get(p.participantId) ?? '?', p.shares] as [string, number]),
      }))
    return {
      name: j.group?.name,
      currency: j.group?.currency,
      information: j.group?.information,
      participants: (j.participants ?? []).filter((p: { deleted?: boolean }) => !p.deleted).map((p: { name: string }) => p.name),
      rows,
    }
  }
  // Spliit export
  const s = j as SpliitExport
  if (!s || !Array.isArray(s.participants) || !Array.isArray(s.expenses)) throw new Error('not a Splittio or Spliit export')
  const names = new Map(s.participants.map((p) => [p.id, p.name]))
  return {
    name: s.name,
    currency: s.currencyCode || ({ '€': 'EUR', $: 'USD', '£': 'GBP' } as Record<string, string>)[s.currency ?? ''] || undefined,
    information: s.information ?? '',
    participants: s.participants.map((p) => p.name),
    rows: s.expenses.map((e) => ({
      date: String(e.expenseDate).slice(0, 10),
      title: e.title,
      category: categoryByName(e.category?.grouping, e.category?.name),
      amount: e.amount,
      originalAmount: e.originalAmount ?? undefined,
      originalCurrency: e.originalCurrency ?? undefined,
      rate: e.conversionRate !== null && e.conversionRate !== undefined ? Number(e.conversionRate) : undefined,
      paidBy: names.get(e.paidById) ?? '?',
      isReimbursement: !!e.isReimbursement,
      splitMode: SPLIT_MODES.includes(e.splitMode) ? e.splitMode : 'EVENLY',
      notes: e.notes ?? '',
      shares: e.paidFor.map((p) => [names.get(p.participantId) ?? '?', p.shares] as [string, number]),
    })),
  }
}

export function parseImport(text: string, fileName = ''): ParsedImport {
  const t = text.trimStart()
  if (fileName.toLowerCase().endsWith('.json') || t.startsWith('{')) return parseJsonExport(text)
  return parseSplittioCsv(text)
}

type SpliitExport = {
  name: string
  information?: string | null
  currency?: string
  currencyCode?: string | null
  participants: { id: string; name: string }[]
  expenses: {
    id: string
    expenseDate: string
    title: string
    category?: { grouping: string; name: string } | null
    amount: number
    originalAmount?: number | null
    originalCurrency?: string | null
    conversionRate?: string | number | null
    paidById: string
    paidFor: { participantId: string; shares: number }[]
    isReimbursement: boolean
    splitMode: SplitMode
    recurrenceRule?: string | null
    notes?: string | null
  }[]
}

/**
 * Adds imported expenses to a group. Participants are matched by name (missing
 * ones are created). Rows identical to an existing expense (date, title, amount,
 * payer) are skipped, so importing the same file twice adds nothing.
 */
export async function importIntoGroup(groupId: string, data: ParsedImport): Promise<{ added: number; skipped: number }> {
  await app.refold(groupId)
  const view = app.view(groupId)
  if (!view) throw new Error('group not found')
  const f = app.factory(groupId)
  const ops = []
  const byName = new Map(view.state.participants.filter((p) => !p.deleted).map((p) => [p.name.trim().toLowerCase(), p.id]))
  const pid = (name: string) => {
    const k = name.trim().toLowerCase()
    let id = byName.get(k)
    if (!id) {
      id = uuid()
      byName.set(k, id)
      ops.push(f.op('participant', id, { name: name.trim() || '?' }))
    }
    return id
  }
  for (const n of data.participants) pid(n)
  const names = new Map(view.state.participants.map((p) => [p.id, p.name.trim().toLowerCase()]))
  const key = (date: string, title: string, amount: number, payer: string) => `${date}|${title.trim().toLowerCase()}|${amount}|${payer.trim().toLowerCase()}`
  const existing = new Set(view.state.expenses.filter((e) => !e.deleted).map((e) => key(e.date, e.title, e.money.amount, names.get(e.paidBy) ?? '')))
  let added = 0
  let skipped = 0
  for (const r of data.rows) {
    const k = key(r.date, r.title, r.amount, r.paidBy)
    if (existing.has(k)) {
      skipped++
      continue
    }
    existing.add(k)
    const money: Money = {
      amount: r.amount,
      currency: view.state.group.currency,
      splitMode: r.splitMode,
      paidFor: r.shares.map(([n, shares]) => ({ participantId: pid(n), shares })),
    }
    if (r.originalCurrency && r.originalAmount !== undefined) Object.assign(money, { originalAmount: r.originalAmount, originalCurrency: r.originalCurrency, rate: r.rate })
    ops.push(
      f.op('expense', uuid(), {
        title: r.title,
        date: r.date,
        category: r.category,
        notes: r.notes,
        paidBy: pid(r.paidBy),
        money,
        isReimbursement: r.isReimbursement,
        // Recurring series were materialised by the source; never re-derive them.
        recurrence: 'none' as Recurrence,
        deleted: false,
      }),
    )
    added++
  }
  await app.apply(groupId, ops)
  return { added, skipped }
}

/** Creates a new group from a Splittio or Spliit export. Returns the new group id. */
export async function importAsNewGroup(text: string, fileName = '', fallbackName = 'Import'): Promise<string> {
  const data = parseImport(text, fileName)
  const id = await app.createGroup({
    name: data.name || fallbackName,
    currency: data.currency || 'EUR',
    participants: [],
    me: -1,
    information: data.information ?? '',
  })
  await importIntoGroup(id, data)
  return id
}

// ---------- Re-key ----------

/**
 * Creates a new group (new id, key and tags) holding the current ledger, for
 * when a link leaked or someone must lose access. History stays in the old group.
 */
export async function rekeyGroup(view: GroupView): Promise<string> {
  const { state, record } = view
  const id = await app.createGroup({
    name: state.group.name,
    currency: state.group.currency,
    participants: [],
    me: -1,
    information: state.group.information,
    relays: state.group.relays.length ? state.group.relays : record.relays,
  })
  const f = app.factory(id)
  const ops = state.participants.map((p) => f.op('participant', p.id, { name: p.name, deleted: p.deleted, ...(p.household ? { household: p.household } : {}) }))
  for (const e of state.expenses) {
    if (e.recurringFrom) continue // re-derived from the template in the new group
    ops.push(
      f.op('expense', e.id, {
        title: e.title,
        date: e.date,
        category: e.category,
        notes: e.notes,
        paidBy: e.paidBy,
        money: e.money,
        isReimbursement: e.isReimbursement,
        recurrence: e.recurrence,
        deleted: e.deleted,
      }),
    )
  }
  // Past occurrences are written out with the values they have now (incl. hand edits),
  // since the new template's history starts today.
  for (const e of state.expenses)
    if (e.recurringFrom)
      ops.push(f.op('expense', e.id, { title: e.title, notes: e.notes, paidBy: e.paidBy, money: e.money, category: e.category, deleted: e.deleted, date: e.date, recurringFrom: e.recurringFrom }))
  if (record.me) {
    await app.store.updateGroup(id, { me: record.me })
    ops.push(f.op('device', app.device.pubkey, { participantId: record.me, label: 'rekeyed' }))
  }
  await app.apply(id, ops)
  // Tell the old group (without the new key) that it moved.
  await app.apply(record.id, [app.factory(record.id).op('group', record.id, { movedOn: Date.now() })])
  return id
}
