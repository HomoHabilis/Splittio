import { compareOps, fold } from '../core/fold'
import type { Op } from '../core/types'
import { canonicalJson, sha256Hex } from '../core/util'
import { compress, decompress, MAX_PLAINTEXT, type SnapChunkPayload } from './wire'

/** Publish a snapshot every this many ops. */
export const SNAPSHOT_EVERY = 200

/** [entity, entityId, field, value, hlc, author] */
type RegisterRow = [string, string, string, unknown, string, string]

export type Snapshot = {
  v: 1
  groupId: string
  /** Highest HLC per device covered by the snapshot. */
  frontier: Record<string, string>
  /** Creation time (ms) of the newest op covered. */
  at: number
  /** Winning value of every field, with its HLC and author: late ops still merge correctly. */
  registers: RegisterRow[]
  /** Full ops kept verbatim: recurring templates (their history drives occurrences) and held ops. */
  ops: Op[]
}

export function buildSnapshot(groupId: string, ops: Op[], now = Date.now()): Snapshot {
  const state = fold(groupId, ops, { now })
  const frontier: Record<string, string> = {}
  for (const op of ops) {
    const dev = op.hlc.slice(19)
    if (!frontier[dev] || op.hlc > frontier[dev]) frontier[dev] = op.hlc
  }
  const registers: RegisterRow[] = []
  for (const [key, fields] of state.registers) {
    const i = key.indexOf('|')
    for (const [field, r] of fields) {
      if (r.opId === '') continue // derived recurring values are recomputed by the fold
      registers.push([key.slice(0, i), key.slice(i + 1), field, r.value, r.hlc, r.author])
    }
  }
  registers.sort((a, b) => (a[0] + a[1] + a[2] < b[0] + b[1] + b[2] ? -1 : 1))
  const kept: Op[] = []
  for (const [, list] of state.expenseOps)
    if (list.some((op) => typeof op.set.recurrence === 'string' && op.set.recurrence !== 'none')) kept.push(...list)
  kept.push(...state.held)
  kept.sort(compareOps)
  let at = 0
  for (const hlc of Object.values(frontier)) at = Math.max(at, Number(hlc.slice(0, 13)))
  return { v: 1, groupId, frontier, at, registers, ops: kept }
}

/** Same frontier → same id, so devices that snapshot the same state agree. */
export function snapshotId(s: Snapshot): string {
  return sha256Hex(canonicalJson(s.frontier)).slice(0, 32)
}

/** Expands a snapshot into ops that fold to the same state as the log it came from. */
export function snapshotOps(s: Snapshot): Op[] {
  const out: Op[] = s.registers.map(([entity, entityId, field, value, hlc, author]) => ({
    opId: 'snap:' + sha256Hex(`${entity}|${entityId}|${field}|${hlc}`).slice(0, 32),
    groupId: s.groupId,
    entity: entity as Op['entity'],
    entityId,
    set: { [field]: value },
    hlc,
    author,
  }))
  return out.concat(s.ops.map((op) => ({ ...op, groupId: s.groupId })))
}

export async function chunkSnapshot(s: Snapshot, cap = MAX_PLAINTEXT): Promise<SnapChunkPayload[]> {
  const data = await compress(JSON.stringify(s))
  const hash = sha256Hex(data)
  const id = snapshotId(s)
  const part = cap - 400 // room for the JSON wrapper
  const n = Math.max(1, Math.ceil(data.length / part))
  return Array.from({ length: n }, (_, i) => ({
    t: 'snap' as const,
    v: 1 as const,
    id,
    i,
    n,
    hash,
    at: s.at,
    data: data.slice(i * part, (i + 1) * part),
  }))
}

/** Reassembles a snapshot from its chunks; null if incomplete or the hash doesn't match. */
export async function assembleSnapshot(chunks: SnapChunkPayload[]): Promise<Snapshot | null> {
  if (chunks.length === 0) return null
  const { n, hash } = chunks[0]
  const parts: string[] = []
  for (const c of chunks) if (c.n === n && c.hash === hash && c.i >= 0 && c.i < n) parts[c.i] = c.data
  for (let i = 0; i < n; i++) if (typeof parts[i] !== 'string') return null
  const data = parts.join('')
  if (sha256Hex(data) !== hash) return null
  try {
    const s = JSON.parse(await decompress(data)) as Snapshot
    return s.v === 1 && Array.isArray(s.registers) && Array.isArray(s.ops) ? s : null
  } catch {
    return null
  }
}

/** Picks the newest snapshot whose chunks are all present and valid. */
export async function newestCompleteSnapshot(chunks: SnapChunkPayload[]): Promise<Snapshot | null> {
  const byId = new Map<string, SnapChunkPayload[]>()
  for (const c of chunks) byId.set(c.id + c.hash, [...(byId.get(c.id + c.hash) ?? []), c])
  const groups = [...byId.values()].sort((a, b) => b[0].at - a[0].at)
  for (const g of groups) {
    const s = await assembleSnapshot(g)
    if (s) return s
  }
  return null
}
