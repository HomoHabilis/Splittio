import type { Recurrence } from './types'

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate() // m is 1-based here
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * The next due date after `date`. Monthly and yearly series keep the anchor's
 * day of month: a 31st clamps to the 30th or the 28th/29th, then returns to the
 * 31st in the following month (as in Spliit).
 */
export function nextDate(date: string, rule: Exclude<Recurrence, 'none'>, anchorDay: number): string {
  const [y, m, d] = date.split('-').map(Number)
  switch (rule) {
    case 'daily':
    case 'weekly': {
      const t = new Date(Date.UTC(y, m - 1, d + (rule === 'daily' ? 1 : 7)))
      return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
    }
    case 'monthly': {
      const ny = m === 12 ? y + 1 : y
      const nm = m === 12 ? 1 : m + 1
      return fmt(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)))
    }
    case 'yearly':
      return fmt(y + 1, m, Math.min(anchorDay, daysInMonth(y + 1, m)))
  }
}
