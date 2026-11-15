// M0 relay survey. Probes every listed relay from a brand-new key with no profile:
// NIP-11 (NIP-77 support, max_message_length, payment/auth), does it accept a
// kind-30078 event shaped like Splittio's (z + d tags, ~20 KB of NIP-44 ciphertext),
// and does it return it again later.
//
//   node scripts/relay-survey.mjs            # publish + immediate read-back; writes relay-survey.json
//   node scripts/relay-survey.mjs --recheck  # re-query the saved events (run after 24 h and after 7 days)
//
// Needs Node 22+ (global WebSocket and fetch).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { encrypt } from 'nostr-tools/nip44'

const RELAYS = [
  'wss://purplerelay.com', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://offchain.pub',
  'wss://nostr.data.haus', 'wss://nostr.oxtr.dev', 'wss://relay.nostr.wirednet.jp',
  'wss://nostr-pub.wellorder.net', 'wss://nostr.sathoarder.com', 'wss://nostr.bitcoiner.social', 'wss://nostr.mom',
]
const FILE = process.env.SURVEY_FILE ?? 'relay-survey.json'
const hex = (b) => Buffer.from(b).toString('hex')

async function nip11(url) {
  try {
    const res = await fetch(url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    const lim = j.limitation ?? {}
    return {
      ok: true,
      nip77: (j.supported_nips ?? []).map(Number).includes(77),
      maxMessageLength: lim.max_message_length ?? null,
      maxLimit: lim.max_limit ?? null,
      payment: !!lim.payment_required,
      auth: !!lim.auth_required,
      software: j.software ?? null,
    }
  } catch (e) {
    return { ok: false, error: String(e.message ?? e) }
  }
}

function session(url, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let ws
    const t = setTimeout(() => resolve(null), timeoutMs)
    try {
      ws = new WebSocket(url)
    } catch {
      return resolve(null)
    }
    ws.onopen = () => {
      clearTimeout(t)
      resolve(ws)
    }
    ws.onerror = () => {
      clearTimeout(t)
      resolve(null)
    }
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
    ws.send(JSON.stringify(send))
  })
}

async function fetchById(ws, id) {
  const sub = 'q' + Math.random().toString(36).slice(2, 8)
  const r = await rpc(ws, ['REQ', sub, { ids: [id] }], (msg, out) => {
    if (msg[0] === 'EVENT' && msg[1] === sub) out.push(msg[2])
    if ((msg[0] === 'EOSE' || msg[0] === 'CLOSED') && msg[1] === sub) return { out, reason: msg[2] }
  })
  ws.send(JSON.stringify(['CLOSE', sub]))
  return (r.out ?? []).some((e) => e.id === id)
}

async function publishProbe(url, sk) {
  const groupKey = crypto.getRandomValues(new Uint8Array(32))
  const tag = hex(crypto.getRandomValues(new Uint8Array(16)))
  const plaintext = 'z:' + Buffer.from(crypto.getRandomValues(new Uint8Array(15000))).toString('base64')
  const ev = finalizeEvent(
    { kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', `${tag}:b:${hex(crypto.getRandomValues(new Uint8Array(12)))}`], ['z', tag]], content: encrypt(plaintext, groupKey) },
    sk,
  )
  const ws = await session(url)
  if (!ws) return { connected: false }
  const ok = await rpc(ws, ['EVENT', ev], (msg) => (msg[0] === 'OK' && msg[1] === ev.id ? { ok: msg[2], message: msg[3] } : null))
  const readBack = ok.ok ? await fetchById(ws, ev.id) : false
  // Does the relay index the single-letter z tag?
  let byTag = false
  if (ok.ok) {
    const sub = 't' + Math.random().toString(36).slice(2, 8)
    const r = await rpc(ws, ['REQ', sub, { kinds: [30078], '#z': [tag] }], (msg, out) => {
      if (msg[0] === 'EVENT' && msg[1] === sub) out.push(msg[2])
      if ((msg[0] === 'EOSE' || msg[0] === 'CLOSED') && msg[1] === sub) return { out }
    })
    byTag = (r.out ?? []).some((e) => e.id === ev.id)
  }
  ws.close()
  return { connected: true, accepted: !!ok.ok, message: ok.message ?? (ok.timeout ? 'no OK (timeout)' : ''), readBack, byTag, eventId: ev.id, size: JSON.stringify(ev).length }
}

async function survey() {
  const sk = generateSecretKey()
  const results = []
  await Promise.all(
    RELAYS.map(async (url) => {
      const info = await nip11(url)
      const pub = await publishProbe(url, sk)
      results.push({ url, info, pub, at: new Date().toISOString(), checks: [] })
      console.error(`${url}: ${pub.connected ? (pub.accepted ? 'accepted' : 'rejected: ' + pub.message) : 'no connection'}`)
    }),
  )
  results.sort((a, b) => RELAYS.indexOf(a.url) - RELAYS.indexOf(b.url))
  writeFileSync(FILE, JSON.stringify(results, null, 2))
  report(results)
}

async function recheck() {
  if (!existsSync(FILE)) throw new Error(`${FILE} not found: run the survey first`)
  const results = JSON.parse(readFileSync(FILE, 'utf8'))
  await Promise.all(
    results.map(async (r) => {
      if (!r.pub.accepted) return
      const ws = await session(r.url)
      const found = ws ? await fetchById(ws, r.pub.eventId) : null
      ws?.close()
      r.checks.push({ at: new Date().toISOString(), found })
    }),
  )
  writeFileSync(FILE, JSON.stringify(results, null, 2))
  report(results)
}

function report(results) {
  const age = (r, c) => Math.round((Date.parse(c.at) - Date.parse(r.at)) / 3600000) + ' h'
  console.log('| Relay | Accepts 30078 | Read back | #z indexed | NIP-77 | max_message_length | Paid/auth | Later checks |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    const p = r.pub
    console.log(
      `| ${r.url} | ${!p.connected ? 'no connection' : p.accepted ? 'yes' : 'no (' + (p.message || '').slice(0, 40) + ')'} | ${p.readBack ? 'yes' : 'no'} | ${p.byTag ? 'yes' : 'no'} | ${r.info.ok ? (r.info.nip77 ? 'yes' : 'no') : '?'} | ${r.info.maxMessageLength ?? '?'} | ${r.info.ok ? (r.info.payment || r.info.auth ? 'yes' : 'no') : '?'} | ${r.checks.map((c) => `${age(r, c)}: ${c.found === null ? 'offline' : c.found ? 'kept' : 'gone'}`).join(', ')} |`,
    )
  }
}

if (process.argv.includes('--recheck')) await recheck()
else await survey()
