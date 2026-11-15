/**
 * Relay lists, starting from SplitFree's RelayDefaults and adjusted by the M0
 * survey (15 Nov 2026, fresh key with no profile, Splittio-shaped kind-30078 event):
 * - offchain.pub rejects unknown keys ("not in our web of trust"): dropped from the defaults;
 * - purplerelay.com accepted but did not return the event: moved to the extras;
 * - nostr-pub.wellorder.net was unreachable;
 * - every other relay accepted, returned the event and indexed the `z` tag.
 * Retention after 24 h and 7 days is re-checked by the "Relay survey" workflow.
 */
export const DEFAULT_RELAYS = [
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.data.haus',
]

export const FALLBACK_RELAYS = ['wss://nostr.oxtr.dev', 'wss://relay.nostr.wirednet.jp', 'wss://nostr.mom']

export const EXTRA_RELAYS = [
  'wss://purplerelay.com',
  'wss://nostr.sathoarder.com',
  'wss://offchain.pub',
  'wss://nostr-pub.wellorder.net',
]

/** Fixed order used by the invite link's relay bitmap. Append only; never reorder. */
export const KNOWN_RELAYS = [
  'wss://purplerelay.com',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
  'wss://nostr.data.haus',
  'wss://nostr.oxtr.dev',
  'wss://relay.nostr.wirednet.jp',
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.sathoarder.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
]

export function normalizeRelayUrl(u: string): string | null {
  let s = u.trim()
  if (!s) return null
  if (!/^wss?:\/\//i.test(s)) s = 'wss://' + s
  try {
    const url = new URL(s)
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return null
    return (url.protocol + '//' + url.host + url.pathname).replace(/\/+$/, '')
  } catch {
    return null
  }
}

export type RelayInfo = {
  nip77: boolean
  maxMessageLength?: number
  maxLimit?: number
  paymentRequired: boolean
  authRequired: boolean
  name?: string
}

const infoCache = new Map<string, Promise<RelayInfo | null>>()

/** NIP-11 probe. Returns null when the relay doesn't answer. */
export function relayInfo(url: string, timeoutMs = 5000): Promise<RelayInfo | null> {
  let p = infoCache.get(url)
  if (!p) {
    p = (async () => {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), timeoutMs)
        const res = await fetch(url.replace(/^ws/, 'http'), {
          headers: { Accept: 'application/nostr+json' },
          signal: ctrl.signal,
        })
        clearTimeout(t)
        const j = await res.json()
        const lim = j.limitation ?? {}
        return {
          nip77: Array.isArray(j.supported_nips) && j.supported_nips.map(Number).includes(77),
          maxMessageLength: Number(lim.max_message_length) || undefined,
          maxLimit: Number(lim.max_limit) || undefined,
          paymentRequired: lim.payment_required === true,
          authRequired: lim.auth_required === true,
          name: typeof j.name === 'string' ? j.name : undefined,
        }
      } catch {
        return null
      }
    })()
    infoCache.set(url, p)
  }
  return p
}

function override(key: string): string[] | null {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null
  } catch {
    return null
  }
}

/**
 * Relays for new groups. Self-hosters and tests can override them with
 * localStorage "splittio.defaultRelays" / "splittio.fallbackRelays" (JSON arrays).
 */
export function defaultRelays(): string[] {
  return override('splittio.defaultRelays') ?? DEFAULT_RELAYS
}

export function fallbackRelays(): string[] {
  return override('splittio.fallbackRelays') ?? FALLBACK_RELAYS
}
