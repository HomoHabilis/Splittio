// A small in-memory Nostr relay for development and tests: NIP-01, NIP-11 and
// (optionally) NIP-77. Run with `npm run relay` (port 7447 by default).
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { verifyEvent } from 'nostr-tools/pure'
import { Negentropy, NegentropyStorageVector } from '../src/vendor/negentropy.js'

function matches(f, ev) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.since !== undefined && ev.created_at < f.since) return false
  if (f.until !== undefined && ev.created_at > f.until) return false
  for (const k of Object.keys(f)) {
    if (k[0] !== '#') continue
    const vals = f[k]
    if (!ev.tags.some((t) => t[0] === k.slice(1) && vals.includes(t[1]))) return false
  }
  return true
}

/**
 * @param {{ port?: number, nip77?: boolean, maxLimit?: number, reject?: boolean, silent?: boolean, quiet?: boolean }} opts
 */
export function startRelay(opts = {}) {
  const { nip77 = true, maxLimit = 500 } = opts
  /** @type {Map<string, any>} */
  const events = new Map()
  const sockets = new Set()
  const state = { reject: !!opts.reject, silent: !!opts.silent, nip77 }

  const http = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/nostr+json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
    })
    res.end(JSON.stringify({
      name: 'splittio-dev-relay',
      supported_nips: state.nip77 ? [1, 11, 77] : [1, 11],
      limitation: { max_message_length: 128000, max_limit: maxLimit },
    }))
  })
  const wss = new WebSocketServer({ server: http })

  function query(filters) {
    const out = []
    for (const f of filters) {
      const limit = Math.min(f.limit ?? maxLimit, maxLimit)
      const m = [...events.values()]
        .filter((ev) => matches(f, ev))
        .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
        .slice(0, limit)
      out.push(...m)
    }
    return [...new Map(out.map((e) => [e.id, e])).values()]
  }

  wss.on('connection', (ws) => {
    sockets.add(ws)
    const subs = new Map()
    const negs = new Map()
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m))
    ws.on('close', () => sockets.delete(ws))
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return send(['NOTICE', 'bad json'])
      }
      const [type, a, ...rest] = msg
      if (process.env.RELAY_DEBUG) console.log('relay <-', type, typeof a === 'string' ? a.slice(0, 12) : a?.id?.slice(0, 12), JSON.stringify(rest).slice(0, 150))
      if (type === 'EVENT') {
        const ev = a
        if (state.reject) return send(['OK', ev.id, false, 'blocked: test relay rejects'])
        if (!verifyEvent({ ...ev })) return send(['OK', ev.id, false, 'invalid: bad signature'])
        // NIP-33 addressable replacement (kind 30000-39999 by pubkey + d)
        if (ev.kind >= 30000 && ev.kind < 40000) {
          const d = ev.tags.find((t) => t[0] === 'd')?.[1] ?? ''
          for (const [id, old] of events)
            if (old.kind === ev.kind && old.pubkey === ev.pubkey && (old.tags.find((t) => t[0] === 'd')?.[1] ?? '') === d)
              events.delete(id)
        }
        const dup = events.has(ev.id)
        events.set(ev.id, ev)
        // silent: stores the event but the OK and the live echo never arrive (lost on a flaky network).
        if (state.silent) return
        send(['OK', ev.id, true, dup ? 'duplicate:' : ''])
        if (!dup)
          for (const s of sockets) s.emit('broadcast', ev)
      } else if (type === 'REQ') {
        subs.set(a, rest)
        for (const ev of query(rest)) send(['EVENT', a, ev])
        send(['EOSE', a])
      } else if (type === 'CLOSE') {
        subs.delete(a)
      } else if (type === 'NEG-OPEN') {
        if (!state.nip77) return send(['NOTICE', 'NEG not supported'])
        const [filter, initial] = rest
        const storage = new NegentropyStorageVector()
        for (const ev of [...events.values()].filter((e) => matches(filter, e))) storage.insert(ev.created_at, ev.id)
        storage.seal()
        const neg = new Negentropy(storage, 60000)
        neg.isServer = true
        negs.set(a, neg)
        try {
          send(['NEG-MSG', a, neg.reconcile(initial) ?? '61'])
        } catch (e) {
          send(['NEG-ERR', a, 'error: ' + e.message])
        }
      } else if (type === 'NEG-MSG') {
        const neg = negs.get(a)
        if (!neg) return send(['NEG-ERR', a, 'closed: unknown'])
        try {
          send(['NEG-MSG', a, neg.reconcile(rest[0]) ?? '61'])
        } catch (e) {
          send(['NEG-ERR', a, 'error: ' + e.message])
        }
      } else if (type === 'NEG-CLOSE') {
        negs.delete(a)
      }
    })
    ws.on('broadcast', (ev) => {
      for (const [id, filters] of subs) if (filters.some((f) => matches({ ...f, since: undefined, limit: undefined }, ev) && (f.since === undefined || ev.created_at >= f.since))) send(['EVENT', id, ev])
    })
  })

  return new Promise((resolve) => {
    http.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = http.address().port
      if (!opts.quiet) console.log(`dev relay on ws://127.0.0.1:${port} (NIP-77 ${nip77 ? 'on' : 'off'})`)
      resolve({
        url: `ws://127.0.0.1:${port}`,
        port,
        events,
        state,
        /** Turn the silent mode on or off. */
        setSilent(v) {
          state.silent = v
        },
        /** Forget events (simulates a relay dropping history). */
        drop(ids) {
          for (const id of ids ?? [...events.keys()]) events.delete(id)
        },
        /** Drops every open connection (simulates a network blip). */
        disconnectAll() {
          for (const s of sockets) s.terminate()
        },
        close() {
          for (const s of sockets) s.terminate()
          wss.close()
          return new Promise((r) => http.close(() => r(undefined)))
        },
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 7447)
  startRelay({ port, nip77: process.env.NIP77 !== '0' })
}
