import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Event } from 'nostr-tools/pure'
import type { Op } from '../core/types'

export type GroupRecord = {
  id: string
  /** 32-byte group key, hex. The only credential. */
  key: string
  name: string
  /** Relays from the invite; the group-meta `relays` field overrides once known. */
  relays: string[]
  /** Participant this device acts as. */
  me?: string
  joinedAt: number
  lastOpened: number
  favorite?: boolean
  /** Set when the device joined from a snapshot: history before this time isn't local. */
  historyFrom?: number
  /** Number of ops when the last snapshot was published or seen. */
  lastSnapshotOps?: number
}

export type StoredEvent = {
  id: string
  groupId: string
  kind: 'ops' | 'snap'
  event: Event
  /** Relays known to hold this event (accepted it or sent it to us). */
  relays: string[]
  receivedAt: number
  /**
   * Published by this device. Events are signed with throwaway keys, so the pubkey no
   * longer tells; events stored before that fall back to comparing with the device key.
   */
  mine?: boolean
}

export type StoredOp = Op & { eventId?: string }

export type Cursor = { key: string; since: number; lastReconcile: number }

interface Schema extends DBSchema {
  meta: { key: string; value: unknown }
  groups: { key: string; value: GroupRecord }
  events: { key: string; value: StoredEvent; indexes: { group: string } }
  ops: { key: string; value: StoredOp; indexes: { group: string } }
  outbox: { key: string; value: Op; indexes: { group: string } }
  cursors: { key: string; value: Cursor }
}

export type DB = IDBPDatabase<Schema>

export function openStore(name = 'splittio'): Promise<DB> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('meta')
      db.createObjectStore('groups', { keyPath: 'id' })
      db.createObjectStore('events', { keyPath: 'id' }).createIndex('group', 'groupId')
      db.createObjectStore('ops', { keyPath: 'opId' }).createIndex('group', 'groupId')
      db.createObjectStore('outbox', { keyPath: 'opId' }).createIndex('group', 'groupId')
      db.createObjectStore('cursors', { keyPath: 'key' })
    },
  })
}

/** Thin data-access layer over IndexedDB. */
export class Store {
  constructor(readonly db: DB) {}

  static async open(name?: string): Promise<Store> {
    return new Store(await openStore(name))
  }

  getMeta<T>(key: string): Promise<T | undefined> {
    return this.db.get('meta', key) as Promise<T | undefined>
  }
  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.put('meta', value, key)
  }

  listGroups(): Promise<GroupRecord[]> {
    return this.db.getAll('groups')
  }
  getGroup(id: string): Promise<GroupRecord | undefined> {
    return this.db.get('groups', id)
  }
  async putGroup(g: GroupRecord): Promise<void> {
    await this.db.put('groups', g)
  }
  async updateGroup(id: string, patch: Partial<GroupRecord>): Promise<GroupRecord | undefined> {
    const tx = this.db.transaction('groups', 'readwrite')
    const g = await tx.store.get(id)
    if (g) await tx.store.put({ ...g, ...patch })
    await tx.done
    return g && { ...g, ...patch }
  }

  /** Removes a group and everything stored for it from this device. */
  async deleteGroup(id: string): Promise<void> {
    const tx = this.db.transaction(['groups', 'events', 'ops', 'outbox', 'cursors'], 'readwrite')
    await tx.objectStore('groups').delete(id)
    for (const s of ['events', 'ops', 'outbox'] as const) {
      const idx = tx.objectStore(s).index('group')
      for (let c = await idx.openCursor(id); c; c = await c.continue()) await c.delete()
    }
    const cs = tx.objectStore('cursors')
    for (let c = await cs.openCursor(); c; c = await c.continue()) if (c.key.startsWith(id + '|')) await c.delete()
    await tx.done
  }

  groupOps(groupId: string): Promise<StoredOp[]> {
    return this.db.getAllFromIndex('ops', 'group', groupId)
  }
  groupEvents(groupId: string): Promise<StoredEvent[]> {
    return this.db.getAllFromIndex('events', 'group', groupId)
  }
  getEvent(id: string): Promise<StoredEvent | undefined> {
    return this.db.get('events', id)
  }
  outbox(groupId: string): Promise<Op[]> {
    return this.db.getAllFromIndex('outbox', 'group', groupId)
  }

  /** Saves local ops: into the op log and the outbox, atomically. */
  async addLocalOps(ops: Op[]): Promise<void> {
    const tx = this.db.transaction(['ops', 'outbox'], 'readwrite')
    for (const op of ops) {
      await tx.objectStore('ops').put(op)
      await tx.objectStore('outbox').put(op)
    }
    await tx.done
  }

  /** Records a signed event built from outbox ops and removes them from the outbox. */
  async commitOutboxEvent(ev: StoredEvent, ops: Op[]): Promise<void> {
    const tx = this.db.transaction(['events', 'ops', 'outbox'], 'readwrite')
    await tx.objectStore('events').put(ev)
    for (const op of ops) {
      await tx.objectStore('outbox').delete(op.opId)
      await tx.objectStore('ops').put({ ...op, eventId: ev.id })
    }
    await tx.done
  }

  /**
   * Stores a received event and its ops. Returns the ops that were new.
   * Existing ops are kept (an op's content never changes).
   */
  async ingestEvent(ev: StoredEvent, ops: Op[]): Promise<Op[]> {
    const tx = this.db.transaction(['events', 'ops'], 'readwrite')
    const existing = await tx.objectStore('events').get(ev.id)
    if (existing) {
      const relays = [...new Set([...existing.relays, ...ev.relays])]
      if (relays.length !== existing.relays.length) await tx.objectStore('events').put({ ...existing, relays })
    } else {
      await tx.objectStore('events').put(ev)
    }
    const fresh: Op[] = []
    for (const op of ops) {
      if (await tx.objectStore('ops').getKey(op.opId)) continue
      await tx.objectStore('ops').put({ ...op, eventId: ev.id })
      fresh.push(op)
    }
    await tx.done
    return fresh
  }

  /** Stores ops that don't come from a stored event (snapshot registers, imports). */
  async putOps(ops: StoredOp[]): Promise<void> {
    const tx = this.db.transaction('ops', 'readwrite')
    for (const op of ops) if (!(await tx.store.getKey(op.opId))) await tx.store.put(op)
    await tx.done
  }

  async addEventRelays(id: string, relays: string[]): Promise<void> {
    const tx = this.db.transaction('events', 'readwrite')
    const ev = await tx.store.get(id)
    if (ev) {
      const merged = [...new Set([...ev.relays, ...relays])]
      if (merged.length !== ev.relays.length) await tx.store.put({ ...ev, relays: merged })
    }
    await tx.done
  }

  async getCursor(groupId: string, relay: string): Promise<Cursor> {
    const key = groupId + '|' + relay
    return (await this.db.get('cursors', key)) ?? { key, since: 0, lastReconcile: 0 }
  }
  async putCursor(c: Cursor): Promise<void> {
    await this.db.put('cursors', c)
  }
}
