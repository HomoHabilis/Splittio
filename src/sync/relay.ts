import type { Event } from 'nostr-tools/pure'

export type Filter = {
  ids?: string[]
  kinds?: number[]
  authors?: string[]
  since?: number
  until?: number
  limit?: number
  [tag: `#${string}`]: string[] | undefined
}

export type RelayStatus = 'idle' | 'connecting' | 'open' | 'closed'

type Sub = {
  filters: Filter[]
  onEvent: (ev: Event) => void
  onEose?: () => void
  onClosed?: (reason: string) => void
}

type NegHandler = { onMsg: (msg: string) => void; onErr: (reason: string) => void }

export type PublishResult = { ok: boolean; message: string }

let subCounter = 0

/**
 * A minimal NIP-01 relay connection with reconnect/backoff, OK tracking,
 * one-shot queries and NIP-77 message plumbing. Subscriptions survive
 * reconnects (they are re-sent on open).
 */
export class Relay {
  status: RelayStatus = 'idle'
  lastError = ''
  private ws: WebSocket | null = null
  private subs = new Map<string, Sub>()
  private pendingOk = new Map<string, (r: PublishResult) => void>()
  private neg = new Map<string, NegHandler>()
  private backoff = 1000
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private wanted = false
  private openWaiters: (() => void)[] = []
  onStatus: (s: RelayStatus) => void = () => {}

  constructor(
    readonly url: string,
    private WS: typeof WebSocket = globalThis.WebSocket,
  ) {}

  connect(): void {
    this.wanted = true
    if (this.ws || !this.WS) return
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new this.WS(this.url)
    } catch (e) {
      this.lastError = String(e)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    const connectTimer = setTimeout(() => {
      if (this.ws === ws && this.status === 'connecting') {
        this.drop(ws)
        this.setStatus('closed')
        this.scheduleReconnect()
      }
    }, 10_000)
    ws.onopen = () => {
      clearTimeout(connectTimer)
      this.backoff = 1000
      this.setStatus('open')
      for (const [id, s] of this.subs) this.send(['REQ', id, ...s.filters])
      const w = this.openWaiters
      this.openWaiters = []
      w.forEach((f) => f())
    }
    ws.onmessage = (m) => this.onMessage(typeof m.data === 'string' ? m.data : '')
    ws.onerror = () => {
      this.lastError = 'connection error'
    }
    ws.onclose = () => {
      clearTimeout(connectTimer)
      this.ws = null
      for (const [, resolve] of this.pendingOk) resolve({ ok: false, message: 'connection closed' })
      this.pendingOk.clear()
      for (const [, h] of this.neg) h.onErr('connection closed')
      this.neg.clear()
      this.setStatus('closed')
      if (this.wanted) this.scheduleReconnect()
    }
  }

  close(): void {
    this.wanted = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
    this.setStatus('closed')
  }

  /** Reconnect now (e.g. when the browser comes back online). */
  kick(): void {
    if (this.status === 'open') return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.backoff = 1000
    if (this.ws) {
      // A connection attempt started while offline can hang: drop it and retry now.
      this.drop(this.ws)
    }
    this.connect()
  }

  private drop(ws: WebSocket) {
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    if (this.ws === ws) this.ws = null
  }

  /** Resolves when open, or false after `ms`. */
  waitOpen(ms = 8000): Promise<boolean> {
    if (this.status === 'open') return Promise.resolve(true)
    this.connect()
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      this.openWaiters.push(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.wanted) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 60_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(s: RelayStatus) {
    if (this.status === s) return
    this.status = s
    this.onStatus(s)
  }

  private send(msg: unknown[]): boolean {
    if (!this.ws || this.status !== 'open') return false
    try {
      this.ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  private onMessage(data: string) {
    let msg: unknown[]
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!Array.isArray(msg)) return
    const [type, a, b, c] = msg as [string, string, unknown, unknown]
    switch (type) {
      case 'EVENT':
        this.subs.get(a)?.onEvent(b as Event)
        break
      case 'EOSE':
        this.subs.get(a)?.onEose?.()
        break
      case 'CLOSED': {
        const s = this.subs.get(a)
        this.subs.delete(a)
        s?.onClosed?.(String(b ?? ''))
        break
      }
      case 'OK': {
        const resolve = this.pendingOk.get(a)
        if (resolve) {
          this.pendingOk.delete(a)
          resolve({ ok: b === true, message: String(c ?? '') })
        }
        break
      }
      case 'NEG-MSG':
        this.neg.get(a)?.onMsg(String(b))
        break
      case 'NEG-ERR': {
        const h = this.neg.get(a)
        this.neg.delete(a)
        h?.onErr(String(b))
        break
      }
    }
  }

  publish(ev: Event, timeoutMs = 10_000): Promise<PublishResult> {
    return new Promise((resolve) => {
      if (!this.send(['EVENT', ev])) return resolve({ ok: false, message: 'not connected' })
      const t = setTimeout(() => {
        this.pendingOk.delete(ev.id)
        resolve({ ok: false, message: 'timeout' })
      }, timeoutMs)
      this.pendingOk.set(ev.id, (r) => {
        clearTimeout(t)
        resolve(r)
      })
    })
  }

  subscribe(filters: Filter[], sub: Omit<Sub, 'filters'>, id = `s${++subCounter}`): { id: string; close: () => void } {
    this.subs.set(id, { ...sub, filters })
    this.send(['REQ', id, ...filters])
    return {
      id,
      close: () => {
        if (this.subs.delete(id)) this.send(['CLOSE', id])
      },
    }
  }

  /** REQ until EOSE (or timeout), then CLOSE. */
  query(filters: Filter[], timeoutMs = 15_000): Promise<{ events: Event[]; complete: boolean }> {
    return new Promise((resolve) => {
      const events: Event[] = []
      let done = false
      const finish = (complete: boolean) => {
        if (done) return
        done = true
        clearTimeout(t)
        s.close()
        resolve({ events, complete })
      }
      const t = setTimeout(() => finish(false), timeoutMs)
      const s = this.subscribe(filters, {
        onEvent: (ev) => events.push(ev),
        onEose: () => finish(true),
        onClosed: () => finish(false),
      })
      if (this.status !== 'open') finish(false)
    })
  }

  negOpen(filter: Filter, initial: string, h: NegHandler): { id: string; send: (msg: string) => void; close: () => void } {
    const id = `n${++subCounter}`
    this.neg.set(id, h)
    if (!this.send(['NEG-OPEN', id, filter, initial])) {
      this.neg.delete(id)
      queueMicrotask(() => h.onErr('not connected'))
    }
    return {
      id,
      send: (msg) => void this.send(['NEG-MSG', id, msg]),
      close: () => {
        if (this.neg.delete(id)) this.send(['NEG-CLOSE', id])
      },
    }
  }
}
