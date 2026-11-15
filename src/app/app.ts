import { Clock } from '../core/hlc'
import { fold, type FoldResult } from '../core/fold'
import { OpFactory } from '../core/ops'
import type { Expense, Op } from '../core/types'
import { bytesToHex, uuid } from '../core/util'
import { Store, type GroupRecord, type StoredOp } from '../store/db'
import { getDevice, type DeviceIdentity } from '../store/device'
import { GroupSync, type SyncStatus } from '../sync/engine'
import { defaultRelays, fallbackRelays } from '../sync/relays'
import type { Invite } from './invite'

export type GroupView = {
  record: GroupRecord
  state: FoldResult
  ops: StoredOp[]
  /** Entity ids with changes not yet confirmed by any relay. */
  pending: Set<string>
  status: SyncStatus
}

type Listener = () => void

export function deviceLabel(ua = navigator.userAgent): string {
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) {
    const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)
    return m && !/^K$/.test(m[1]) ? m[1].trim() : 'Android'
  }
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Linux/.test(ua)) return 'Linux'
  return 'Browser'
}

/** Owns the store, the device identity, one sync engine per group and the folded states. */
export class App {
  store!: Store
  device!: DeviceIdentity
  clock!: Clock
  groups = new Map<string, GroupRecord>()
  private syncs = new Map<string, GroupSync>()
  private views = new Map<string, GroupView>()
  private listeners = new Set<Listener>()
  private refoldTimers = new Map<string, ReturnType<typeof setTimeout>>()
  version = 0

  async init(): Promise<void> {
    this.store = await Store.open()
    this.device = await getDevice(this.store)
    this.clock = new Clock(this.device.hlcId)
    for (const g of await this.store.listGroups()) this.groups.set(g.id, g)
    for (const g of this.groups.values()) await this.startGroup(g)
    addEventListener('online', () => this.syncs.forEach((s) => s.kick()))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.syncs.forEach((s) => (s.kick(), void s.reconcileAll()))
    })
    // Held ops, recurring occurrences and "today" depend on the clock.
    setInterval(() => this.groups.forEach((_, id) => this.scheduleRefold(id, 0)), 60_000)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    this.version++
    this.listeners.forEach((f) => f())
  }

  view(groupId: string): GroupView | undefined {
    return this.views.get(groupId)
  }

  sync(groupId: string): GroupSync | undefined {
    return this.syncs.get(groupId)
  }

  private async startGroup(g: GroupRecord) {
    const sync = new GroupSync({ store: this.store, group: g, device: this.device, clock: this.clock, fallbackRelays: fallbackRelays() })
    this.syncs.set(g.id, sync)
    sync.onChange = () => this.scheduleRefold(g.id)
    sync.onStatus = () => this.scheduleRefold(g.id, 150)
    await this.refold(g.id)
    await sync.start()
  }

  private scheduleRefold(id: string, delay = 30) {
    if (this.refoldTimers.has(id)) return
    this.refoldTimers.set(
      id,
      setTimeout(() => {
        this.refoldTimers.delete(id)
        void this.refold(id)
      }, delay),
    )
  }

  async refold(id: string): Promise<void> {
    const record = (await this.store.getGroup(id)) ?? this.groups.get(id)
    const sync = this.syncs.get(id)
    if (!record || !sync) return
    this.groups.set(id, record)
    const ops = await this.store.groupOps(id)
    const state = fold(id, ops)
    // Pending = in the outbox, or in an event no relay has confirmed.
    const pending = new Set<string>()
    for (const op of await this.store.outbox(id)) pending.add(op.entityId)
    const unconfirmed = new Set((await this.store.groupEvents(id)).filter((e) => e.relays.length === 0).map((e) => e.id))
    for (const op of ops) if (op.eventId && unconfirmed.has(op.eventId)) pending.add(op.entityId)
    if (state.group.relays.length) sync.setRelays(state.group.relays)
    if (state.group.name && state.group.name !== record.name) {
      record.name = state.group.name
      await this.store.updateGroup(id, { name: state.group.name })
    }
    this.views.set(id, { record, state, ops, pending, status: sync.status() })
    this.emit()
  }

  factory(groupId: string): OpFactory {
    return new OpFactory(groupId, this.clock, this.device.pubkey)
  }

  async apply(groupId: string, ops: Op[]): Promise<void> {
    if (ops.length) await this.syncs.get(groupId)?.addLocal(ops)
  }

  // ---------- groups ----------

  async createGroup(o: { name: string; currency: string; participants: string[]; me: number; information?: string; relays?: string[] }): Promise<string> {
    const id = uuid()
    const key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
    const relays = o.relays ?? defaultRelays()
    const record: GroupRecord = { id, key, name: o.name, relays, joinedAt: Date.now(), lastOpened: Date.now() }
    const f = new OpFactory(id, this.clock, this.device.pubkey)
    const pids = o.participants.map(() => uuid())
    const ops = [
      f.op('group', id, { name: o.name, currency: o.currency, relays, information: o.information ?? '' }),
      ...o.participants.map((name, i) => f.op('participant', pids[i], { name })),
    ]
    if (pids[o.me]) {
      record.me = pids[o.me]
      ops.push(f.op('device', this.device.pubkey, { participantId: pids[o.me], label: deviceLabel() }))
    }
    await this.store.putGroup(record)
    this.groups.set(id, record)
    await this.store.addLocalOps(ops)
    await this.startGroup(record)
    return id
  }

  async joinGroup(inv: Invite): Promise<string> {
    const existing = this.groups.get(inv.groupId)
    if (existing) return existing.id
    const record: GroupRecord = {
      id: inv.groupId,
      key: inv.key,
      name: inv.name,
      relays: inv.relays.length ? inv.relays : defaultRelays(),
      joinedAt: Date.now(),
      lastOpened: Date.now(),
    }
    await this.store.putGroup(record)
    this.groups.set(record.id, record)
    await this.startGroup(record)
    return record.id
  }

  /** "Who are you?": pick a participant and announce this device. */
  async setMe(groupId: string, participantId: string): Promise<void> {
    await this.store.updateGroup(groupId, { me: participantId })
    await this.apply(groupId, [this.factory(groupId).op('device', this.device.pubkey, { participantId, label: deviceLabel() })])
  }

  async updateRecord(groupId: string, patch: Partial<GroupRecord>): Promise<void> {
    await this.store.updateGroup(groupId, patch)
    await this.refold(groupId)
  }

  /** Removes the group and all its data from this device only. */
  async leaveGroup(groupId: string): Promise<void> {
    this.syncs.get(groupId)?.stop()
    this.syncs.delete(groupId)
    this.views.delete(groupId)
    this.groups.delete(groupId)
    await this.store.deleteGroup(groupId)
    this.emit()
  }

  // ---------- expenses ----------

  /**
   * Writes an expense. On edit, only changed fields are written, except `money`
   * which is always written whole (amount + currency + rate + split).
   */
  async saveExpense(groupId: string, fields: Omit<Expense, 'id' | 'deleted' | 'updated' | 'created' | 'createdBy' | 'inconsistent' | 'recurringFrom'>, prev?: Expense): Promise<string> {
    const id = prev?.id ?? uuid()
    const set: Record<string, unknown> = {}
    const all = fields as unknown as Record<string, unknown>
    for (const k of Object.keys(all)) {
      const before = prev ? (prev as unknown as Record<string, unknown>)[k] : undefined
      if (!prev || JSON.stringify(before) !== JSON.stringify(all[k])) set[k] = all[k]
    }
    if (!prev) set.deleted = false
    if (Object.keys(set).length) await this.apply(groupId, [this.factory(groupId).op('expense', id, set)])
    return id
  }

  async setDeleted(groupId: string, expenseId: string, deleted: boolean): Promise<void> {
    await this.apply(groupId, [this.factory(groupId).op('expense', expenseId, { deleted })])
  }
}

export const app = new App()
