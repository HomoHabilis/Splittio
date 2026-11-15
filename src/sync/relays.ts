/**
 * Relay lists from SplitFree's RelayDefaults. Provisional until the M0 survey
 * (scripts/relay-survey.mjs) has confirmed which relays accept and keep our events.
 */
export const DEFAULT_RELAYS = [
  'wss://purplerelay.com',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://offchain.pub',
]

export const FALLBACK_RELAYS = ['wss://nostr.data.haus', 'wss://nostr.oxtr.dev', 'wss://relay.nostr.wirednet.jp']

export const EXTRA_RELAYS = [
  'wss://nostr-pub.wellorder.net',
  'wss://nostr.sathoarder.com',
  'wss://nostr.bitcoiner.social',
  'wss://nostr.mom',
]

/** Fixed order used by the invite link's relay bitmap. Append only; never reorder. */
export const KNOWN_RELAYS = [...DEFAULT_RELAYS, ...FALLBACK_RELAYS, ...EXTRA_RELAYS]

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
