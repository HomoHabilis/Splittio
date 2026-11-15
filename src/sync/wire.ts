import { encrypt, decrypt } from 'nostr-tools/nip44'
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { isValidOp } from '../core/fold'
import type { Op } from '../core/types'
import { b64Decode, b64Encode, hmacBytes, hmacHex, randomHex } from '../core/util'

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

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(body).arrayBuffer())
}

export async function compress(s: string): Promise<string> {
  return b64Encode(await pipe(new TextEncoder().encode(s), new CompressionStream('deflate-raw')))
}

export async function decompress(b64: string): Promise<string> {
  return new TextDecoder().decode(await pipe(b64Decode(b64), new DecompressionStream('deflate-raw')))
}

/** Ops on the wire omit groupId (implied by the tag/key) and author (taken from the signature). */
type WireOp = Omit<Op, 'groupId' | 'author'>

export type OpsPayload = { t: 'ops'; v: 1; ops: WireOp[] }
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
export async function batchOps(ops: Op[], cap = MAX_PLAINTEXT): Promise<{ ops: Op[]; plaintext: string }[]> {
  if (ops.length === 0) return []
  const wire: OpsPayload = { t: 'ops', v: 1, ops: ops.map(({ groupId: _g, author: _a, ...w }) => w) }
  const plaintext = await encodePlaintext(wire)
  if (plaintext.length <= cap) return [{ ops, plaintext }]
  if (ops.length === 1) throw new Error('single op exceeds the event size cap')
  const mid = Math.ceil(ops.length / 2)
  return [...(await batchOps(ops.slice(0, mid), cap)), ...(await batchOps(ops.slice(mid), cap))]
}

export function signEvent(
  gc: GroupCrypto,
  kind: 'ops' | 'snap',
  plaintext: string,
  secretKey: Uint8Array,
  createdAt: number,
  dSuffix: string = 'b:' + randomHex(12),
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
    const ops = payload.ops.map((w) => ({ ...w, groupId, author: ev.pubkey }) as Op).filter(isValidOp)
    return { kind: 'ops', ops }
  }
  if (payload.t === 'snap' && z === gc.snapTag) return { kind: 'snap', chunk: payload }
  throw new Error('payload does not match tag')
}
