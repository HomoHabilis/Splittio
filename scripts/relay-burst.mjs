// Burst test: does signing every batch with a brand-new key make relays reject or
// throttle Splittio more than signing with one stable device key?
//
// For each relay, sends ROUNDS of N Splittio-shaped events (kind 30078, d + z tags,
// ~3 KB of NIP-44 ciphertext) back to back on one connection, waiting for each OK,
// which is what a flush or a self-healing repair burst does. Rounds alternate
// between "stable" (one key for the whole round) and "fresh" (a new key per
// event), in the order stable, fresh, fresh, stable so per-IP limits hit both
// modes equally. After a pause, every accepted event is read back by id.
//
//   node scripts/relay-burst.mjs            # writes relay-burst.json, prints a Markdown table
//   N=20 PAUSE_MS=60000 node scripts/relay-burst.mjs
//
// Needs Node 22+ (global WebSocket).
import { writeFileSync } from 'node:fs'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { encrypt } from 'nostr-tools/nip44'

const RELAYS = [
  'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.bitcoiner.social', 'wss://nostr.data.haus',
  'wss://nostr.oxtr.dev', 'wss://relay.nostr.wirednet.jp', 'wss://nostr.mom',
  'wss://purplerelay.com', 'wss://nostr.sathoarder.com', 'wss://offchain.pub',
]
const N = Number(process.env.N ?? 20)
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 60000)
const ORDER = (process.env.ORDER ?? 'stable,fresh,fresh,stable').split(',')
const hex = (b) => Buffer.from(b).toString('hex')
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n))

function open(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let ws
    const t = setTimeout(() => resolve(null), timeoutMs)
    try {
      ws = new WebSocket(url)
    } catch {
      return resolve(null)
    }
    ws.onopen = () => (clearTimeout(t), resolve(ws))
    ws.onerror = () => (clearTimeout(t), resolve(null))
  })
}

function rpc(ws, send, match, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const out = []
    const t = setTimeout(() => done({ timeout: true, out }), timeoutMs)
    const done = (v) => {
      clearTimeout(t)
      ws.removeEventListener('message', on)
      resolve(v)
    }
    const on = (m) => {
      let msg
      try {
        msg = JSON.parse(m.data)
      } catch {
        return
      }
      const r = match(msg, out)
      if (r) done(r)
    }
    ws.addEventListener('message', on)
    try {
      ws.send(JSON.stringify(send))
    } catch (e) {
      done({ error: String(e) })
    }
  })
}

function probe(sk, groupKey, tag) {
  const plaintext = 'z:' + Buffer.from(rnd(2200)).toString('base64')
  return finalizeEvent(
    { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', `${tag}:b:${hex(rnd(12))}`], ['z', tag]], content: encrypt(plaintext, groupKey) },
    sk,
  )
}

async function round(url, mode) {
  const ws = await open(url)
  if (!ws) return { mode, connected: false, sent: 0, ok: 0, messages: {}, ids: [], ms: 0 }
  const groupKey = rnd(32)
  const tag = hex(rnd(16))
  const stableKey = generateSecretKey()
  const messages = {}
  const ids = []
  let ok = 0
  let sent = 0
  const log = []
  const t0 = Date.now()
  for (let i = 0; i < N; i++) {
    if (ws.readyState !== WebSocket.OPEN) {
      messages['connection closed'] = (messages['connection closed'] ?? 0) + (N - i)
      break
    }
    const ev = probe(mode === 'stable' ? stableKey : generateSecretKey(), groupKey, tag)
    sent++
    const r = await rpc(ws, ['EVENT', ev], (msg) => {
      if (msg[0] === 'OK' && msg[1] === ev.id) return { ok: msg[2], message: msg[3] ?? '' }
      if (msg[0] === 'NOTICE') messages['NOTICE: ' + String(msg[1]).slice(0, 60)] = (messages['NOTICE: ' + String(msg[1]).slice(0, 60)] ?? 0) + 1
    })
    log.push(!!r.ok)
    if (r.ok) ok++, ids.push(ev.id)
    else {
      const m = r.timeout ? 'no OK (timeout)' : r.error ? r.error : String(r.message).slice(0, 70)
      messages[m] = (messages[m] ?? 0) + 1
    }
  }
  const ms = Date.now() - t0
  const firstReject = ids.length < sent ? log.findIndex((x) => !x) : -1
  ws.close()
  return { mode, connected: true, sent, ok, firstReject, messages, ids, ms }
}

async function readBack(url, ids) {
  if (!ids.length) return 0
  const ws = await open(url)
  if (!ws) return null
  const sub = 'r' + Math.random().toString(36).slice(2, 8)
  const r = await rpc(ws, ['REQ', sub, { ids, limit: ids.length }], (msg, out) => {
    if (msg[0] === 'EVENT' && msg[1] === sub) out.push(msg[2].id)
    if ((msg[0] === 'EOSE' || msg[0] === 'CLOSED') && msg[1] === sub) return { out }
  })
  ws.close()
  return new Set((r.out ?? []).filter((id) => ids.includes(id))).size
}

const results = await Promise.all(
  RELAYS.map(async (url) => {
    const rounds = []
    for (const mode of ORDER) rounds.push(await round(url, mode))
    console.error(`${url}: ${rounds.map((r) => `${r.mode} ${r.ok}/${r.sent}`).join(', ')}`)
    return { url, rounds }
  }),
)
await new Promise((r) => setTimeout(r, PAUSE_MS))
for (const res of results) for (const r of res.rounds) r.found = await readBack(res.url, r.ids)
writeFileSync('relay-burst.json', JSON.stringify({ at: new Date().toISOString(), n: N, pauseMs: PAUSE_MS, results }, null, 2))

const sum = (rs, k) => rs.reduce((a, r) => a + (r[k] ?? 0), 0)
console.log(`Burst of ${N} events per round, rounds ${ORDER.join(', ')}; read back after ${PAUSE_MS / 1000} s.\n`)
console.log('| Relay | Stable key: accepted | Stable: read back | Fresh keys: accepted | Fresh: read back | Rejections (stable) | Rejections (fresh) |')
console.log('|---|---|---|---|---|---|---|')
const details = []
for (const { url, rounds } of results) {
  const s = rounds.filter((r) => r.mode === 'stable')
  const f = rounds.filter((r) => r.mode === 'fresh')
  const msgs = (rs) => {
    const m = {}
    for (const r of rs) for (const [k, v] of Object.entries(r.messages)) m[k] = (m[k] ?? 0) + v
    for (const r of rs) if (!r.connected) m['no connection'] = (m['no connection'] ?? 0) + 1
    return Object.entries(m).map(([k, v]) => `${v}× ${k.replace(/\|/g, '/')}`).join('; ') || '–'
  }
  details.push(`- ${url}: ${rounds.map((r) => `${r.mode} ${r.ok}/${r.sent}${r.firstReject >= 0 ? ` (first rejection at #${r.firstReject + 1})` : ''}`).join(', ')}`)
  console.log(`| ${url} | ${sum(s, 'ok')}/${N * s.length} | ${sum(s, 'found')} | ${sum(f, 'ok')}/${N * f.length} | ${sum(f, 'found')} | ${msgs(s)} | ${msgs(f)} |`)
}
console.log('\nRounds in order:\n')
console.log(details.join('\n'))
