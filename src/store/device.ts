import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '../core/util'
import type { Store } from './db'

export type DeviceIdentity = {
  sk: Uint8Array
  /** Nostr public key (hex). */
  pubkey: string
  /** HLC device id: first 16 hex chars of the public key. */
  hlcId: string
}

export function deviceFromSecret(skHex: string): DeviceIdentity {
  const sk = hexToBytes(skHex)
  const pubkey = getPublicKey(sk)
  let hlcId = pubkey.slice(0, 16)
  if (/^0+$/.test(hlcId)) hlcId = '0000000000000001' // never collide with the reserved id
  return { sk, pubkey, hlcId }
}

/** The device's Nostr keypair, generated in the browser on first use. */
export async function getDevice(store: Store): Promise<DeviceIdentity> {
  let skHex = await store.getMeta<string>('deviceKey')
  if (!skHex) {
    skHex = bytesToHex(generateSecretKey())
    await store.setMeta('deviceKey', skHex)
  }
  return deviceFromSecret(skHex)
}
