import { KNOWN_RELAYS, normalizeRelayUrl } from '../sync/relays'
import { b64urlDecode, b64urlEncode, bytesToHex, hexToBytes } from '../core/util'

export type Invite = {
  v: 1
  groupId: string
  /** 32-byte group key, hex. */
  key: string
  relays: string[]
  name: string
  /** Optional expiry, ms since epoch. */
  expires?: number
}

/**
 * Payload: JSON {v, g, k, r (bitmap of KNOWN_RELAYS), c (custom relays), n, e?}, base64url.
 * It travels in the URL fragment, which browsers never send to the server.
 */
export function encodeInvite(inv: Invite): string {
  let bitmap = 0
  const custom: string[] = []
  for (const r of inv.relays) {
    const i = KNOWN_RELAYS.indexOf(r)
    if (i >= 0 && i < 31) bitmap |= 1 << i
    else custom.push(r)
  }
  const o: Record<string, unknown> = { v: 1, g: inv.groupId, k: b64urlEncode(hexToBytes(inv.key)), r: bitmap, n: inv.name }
  if (custom.length) o.c = custom
  if (inv.expires) o.e = inv.expires
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(o)))
}

export function decodeInvite(payload: string): Invite | null {
  try {
    const o = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))
    if (o.v !== 1 || typeof o.g !== 'string' || typeof o.k !== 'string') return null
    const key = bytesToHex(b64urlDecode(o.k))
    if (key.length !== 64) return null
    const relays: string[] = []
    for (let i = 0; i < KNOWN_RELAYS.length && i < 31; i++) if (o.r & (1 << i)) relays.push(KNOWN_RELAYS[i])
    for (const c of Array.isArray(o.c) ? o.c : []) {
      const n = normalizeRelayUrl(String(c))
      if (n) relays.push(n)
    }
    return { v: 1, groupId: o.g, key, relays, name: typeof o.n === 'string' ? o.n : '', expires: typeof o.e === 'number' ? o.e : undefined }
  } catch {
    return null
  }
}

/** The app's base URL (works on any static host and sub-path). */
export function appBase(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '')
}

export function inviteLink(inv: Invite, base = appBase()): string {
  return `${base}#/join/${encodeInvite(inv)}`
}

/** Accepts a full invite link, a "#/join/…" fragment or the bare payload. */
export function parseInviteInput(text: string): Invite | null {
  const s = text.trim()
  const m = s.match(/#\/join\/([A-Za-z0-9_-]+)/)
  return decodeInvite(m ? m[1] : s)
}
