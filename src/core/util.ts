import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

export function sha256Hex(s: string): string {
  return bytesToHex(sha256(utf8ToBytes(s)))
}

export function hmacHex(key: Uint8Array, msg: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(msg)))
}

export function hmacBytes(key: Uint8Array, msg: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(msg))
}

export function randomHex(bytes = 16): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function uuid(): string {
  return crypto.randomUUID()
}

export function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

export function b64Encode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function b64Decode(s: string): Uint8Array {
  const b = atob(s)
  const out = new Uint8Array(b.length)
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

/** Today's date (YYYY-MM-DD) in the device's local time zone. */
export function localToday(now = Date.now()): string {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Milliseconds of UTC midnight for a YYYY-MM-DD date. */
export function dateToUtcMs(date: string): number {
  return Date.parse(date + 'T00:00:00Z')
}

/** Stable JSON: object keys sorted, so equal values serialise identically. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const o = v as Record<string, unknown>
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
      .join(',') +
    '}'
  )
}
