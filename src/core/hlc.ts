/**
 * Hybrid Logical Clock.
 *
 * Encoded as a fixed-width string "PPPPPPPPPPPPP:CCCC:DDDDDDDDDDDDDDDD" (13-digit
 * physical milliseconds, 4-digit counter, 16-hex device id), so plain string
 * comparison gives the total order, and the device id breaks ties.
 */

export const RESERVED_DEVICE = '0000000000000000'
const MAX_COUNTER = 9999

export type HlcParts = { pt: number; c: number; device: string }

export function encodeHlc({ pt, c, device }: HlcParts): string {
  return `${String(pt).padStart(13, '0')}:${String(c).padStart(4, '0')}:${device}`
}

export function decodeHlc(hlc: string): HlcParts {
  const [pt, c, device] = hlc.split(':')
  return { pt: Number(pt), c: Number(c), device }
}

export function hlcPhysical(hlc: string): number {
  return Number(hlc.slice(0, 13))
}

export function isValidHlc(hlc: unknown): hlc is string {
  return typeof hlc === 'string' && /^\d{13}:\d{4}:[0-9a-f]{16}$/.test(hlc)
}

/** The lowest possible HLC at a given physical time (used for derived values). */
export function baseHlc(pt: number): string {
  return encodeHlc({ pt, c: 0, device: RESERVED_DEVICE })
}

export class Clock {
  private pt = 0
  private c = 0
  constructor(
    readonly device: string,
    private now: () => number = Date.now,
  ) {
    if (!/^[0-9a-f]{16}$/.test(device) || device === RESERVED_DEVICE)
      throw new Error('invalid HLC device id')
  }

  /** A new timestamp for a local event. */
  tick(): string {
    const wall = this.now()
    if (wall > this.pt) {
      this.pt = wall
      this.c = 0
    } else {
      this.c++
    }
    if (this.c > MAX_COUNTER) {
      this.pt++
      this.c = 0
    }
    return encodeHlc({ pt: this.pt, c: this.c, device: this.device })
  }

  /**
   * Merge a remote timestamp. Remote clocks that are more than `maxAheadMs`
   * ahead of ours are ignored here (their ops are held by the fold instead),
   * so one wrong phone can't drag every clock into the future.
   */
  receive(hlc: string, maxAheadMs = 60 * 60 * 1000): void {
    const r = decodeHlc(hlc)
    const wall = this.now()
    if (r.pt > wall + maxAheadMs) return
    if (r.pt > this.pt) {
      this.pt = r.pt
      this.c = r.c
    } else if (r.pt === this.pt && r.c > this.c) {
      this.c = r.c
    }
  }
}
