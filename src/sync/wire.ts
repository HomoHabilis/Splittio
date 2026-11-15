import { encrypt, decrypt } from 'nostr-tools/nip44'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { finalizeEvent, generateSecretKey, verifyEvent, type Event } from 'nostr-tools/pure'
import { isValidOp } from '../core/fold'
import type { Op } from '../core/types'
import { b64Decode, b64Encode, bytesToHex, hexToBytes, hmacBytes, hmacHex, randomHex } from '../core/util'

export const KIND = 30078
/** Max NIP-44 plaintext per event: keeps events ≈45 KB, under common 64 KB relay caps. */
export const MAX_PLAINTEXT = 32_000

export type GroupCrypto = {
  opsTag: string
  snapTag: string
  convKey: Uint8Array
}

export function groupCrypto(groupKey: Uint8Array): GroupCrypto {
  return {
    opsTag: hmacHex(groupKey, 'splittio/ops/v1').slice(0, 32),
    snapTag: hmacHex(groupKey, 'splittio/snap/v1').slice(0, 32),
    convKey: hmacBytes(groupKey, 'splittio/nip44/v1'),
  }
}

/** Inflated size caps: a tiny "zip bomb" from a member must not freeze everyone's app. */
export const MAX_INFLATED_OPS = 4_000_000
export const MAX_INFLATED_SNAPSHOT = 64_000_000

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, max = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new Error('payload too large')
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let off = 0
  for (const p of parts) out.set(p, off), (off += p.byteLength)
  return out
}

export async function compress(s: string): Promise<string> {
  return b64Encode(await pipe(new TextEncoder().encode(s), new CompressionStream('deflate-raw')))
}

export async function decompress(b64: string, max = MAX_INFLATED_OPS): Promise<string> {
  return new TextDecoder().decode(await pipe(b64Decode(b64), new DecompressionStream('deflate-raw'), max))
}

/** Ops on the wire omit groupId (implied by the tag/key) and author (the batch's device key). */
type WireOp = Omit<Op, 'groupId' | 'author'>

/**
 * v1: the author is the outer event's pubkey (the device key). Still accepted from old clients.
 * v2: the outer event is signed by a throwaway key, so relays can't link a device across
 * groups or batches. The device key `a` and its Schnorr signature `s` over the ops travel
 * inside the encrypted content, so members still know (and can verify) which device wrote them.
 */
export type OpsPayload = { t: 'ops'; v: 1; ops: WireOp[] } | { t: 'ops'; v: 2; a: string; s: string; ops: WireOp[] }
export type SnapChunkPayload = { t: 'snap'; v: 1; id: string; i: number; n: number; hash: string; at: number; data: string }
export type Payload = OpsPayload | SnapChunkPayload

export async function encodePlaintext(p: Payload): Promise<string> {
  // Snapshot chunks carry already-compressed data.
  return p.t === 'snap' ? 'j:' + JSON.stringify(p) : 'z:' + (await compress(JSON.stringify(p)))
}

export async function decodePlaintext(s: string): Promise<Payload> {
  if (s.startsWith('j:')) return JSON.parse(s.slice(2))
  if (s.startsWith('z:')) return JSON.parse(await decompress(s.slice(2)))
  throw new Error('unknown payload encoding')
}

/**
 * Splits ops into batches whose encoded plaintext stays under `cap` bytes.
 * Returns the encoded plaintexts.
 */
export type Signer = { sk: Uint8Array; pubkey: string }

/**
 * What the device key signs: a domain string, the group's ops tag (so a signed batch
 * can't be replayed into another group) and the ops as serialized JSON. JSON.stringify
 * of JSON.parse output reproduces the same string, so receivers re-serialize to verify.
 */
function innerMessage(gc: GroupCrypto, ops: WireOp[]): Uint8Array {
  return sha256(new TextEncoder().encode(`splittio/ops-sig/v1\n${gc.opsTag}\n${JSON.stringify(ops)}`))
}

export function signOps(gc: GroupCrypto, ops: WireOp[], signer: Signer): OpsPayload {
  return { t: 'ops', v: 2, a: signer.pubkey, s: bytesToHex(schnorr.sign(innerMessage(gc, ops), signer.sk)), ops }
}

/** Returns the device key that wrote the batch, or throws if a v2 inner signature is missing or bad. */
export function opsAuthor(gc: GroupCrypto, p: OpsPayload, outerPubkey: string): string {
  if (p.v === 1) return outerPubkey
  if (p.v !== 2 || typeof p.a !== 'string' || typeof p.s !== 'string' || !/^[0-9a-f]{64}$/.test(p.a) || !/^[0-9a-f]{128}$/.test(p.s))
    throw new Error('bad ops payload')
  let ok = false
  try {
    ok = schnorr.verify(hexToBytes(p.s), innerMessage(gc, p.ops), hexToBytes(p.a))
  } catch {
    ok = false
  }
  if (!ok) throw new Error('bad device signature')
  return p.a
}

export async function batchOps(gc: GroupCrypto, ops: Op[], signer: Signer, cap = MAX_PLAINTEXT): Promise<{ ops: Op[]; plaintext: string }[]> {
  if (ops.length === 0) return []
  const wire = signOps(
    gc,
    ops.map(({ groupId: _g, author: _a, ...w }) => w),
    signer,
  )
  const plaintext = await encodePlaintext(wire)
  if (plaintext.length <= cap) return [{ ops, plaintext }]
  if (ops.length === 1) throw new Error('single op exceeds the event size cap')
  const mid = Math.ceil(ops.length / 2)
  return [...(await batchOps(gc, ops.slice(0, mid), signer, cap)), ...(await batchOps(gc, ops.slice(mid), signer, cap))]
}

/**
 * Wraps a plaintext in an event signed by a brand-new key, used once and thrown away:
 * relays see unrelated pubkeys, not the device. Who wrote ops is inside the content.
 */
export function signEvent(
  gc: GroupCrypto,
  kind: 'ops' | 'snap',
  plaintext: string,
  createdAt: number,
  dSuffix: string = 'b:' + randomHex(12),
  secretKey: Uint8Array = generateSecretKey(),
): Event {
  const tag = kind === 'ops' ? gc.opsTag : gc.snapTag
  return finalizeEvent(
    {
      kind: KIND,
      created_at: createdAt,
      tags: [
        ['d', `${tag}:${dSuffix}`],
        ['z', tag],
      ],
      content: encrypt(plaintext, gc.convKey),
    },
    secretKey,
  )
}

export type Decoded =
  | { kind: 'ops'; ops: Op[] }
  | { kind: 'snap'; chunk: SnapChunkPayload }

/** Verifies, decrypts and decodes an event of this group. Throws on anything invalid. */
export async function openEvent(gc: GroupCrypto, groupId: string, ev: Event): Promise<Decoded> {
  if (ev.kind !== KIND) throw new Error('wrong kind')
  const z = ev.tags.find((t) => t[0] === 'z')?.[1]
  if (z !== gc.opsTag && z !== gc.snapTag) throw new Error('not this group')
  if (!verifyEvent({ id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, kind: ev.kind, tags: ev.tags, content: ev.content, sig: ev.sig }))
    throw new Error('bad signature')
  if (ev.content.length > 200_000) throw new Error('too large')
  const payload = await decodePlaintext(decrypt(ev.content, gc.convKey))
  if (payload.t === 'ops' && z === gc.opsTag) {
    if (!Array.isArray(payload.ops)) throw new Error('bad ops payload')
    const author = opsAuthor(gc, payload, ev.pubkey)
    const ops = payload.ops.map((w) => ({ ...w, groupId, author }) as Op).filter(isValidOp)
    return { kind: 'ops', ops }
  }
  if (payload.t === 'snap' && z === gc.snapTag) return { kind: 'snap', chunk: payload }
  throw new Error('payload does not match tag')
}
