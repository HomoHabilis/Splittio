import { intlLocale } from '../i18n'

const fmtCache = new Map<string, Intl.NumberFormat>()

export function formatMoney(cents: number, currency: string): string {
  const key = intlLocale() + currency
  let f = fmtCache.get(key)
  if (!f) {
    try {
      f = new Intl.NumberFormat(intlLocale(), { style: 'currency', currency: currency || 'EUR' })
    } catch {
      f = new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }
    fmtCache.set(key, f)
  }
  return f.format(cents / 100)
}

/** Parses "12,50" / "12.50" / "1 234,5" into cents. */
export function parseAmount(s: string): number | null {
  const clean = s.replace(/[\s ']/g, '')
  if (!clean) return null
  // The last separator is the decimal one if followed by 1-2 digits.
  const m = clean.match(/^(-?)([\d.,]*?)(?:[.,](\d{1,2}))?$/)
  if (!m) return null
  const int = m[2].replace(/[.,]/g, '') || '0'
  if (!/^\d+$/.test(int)) return null
  const dec = (m[3] ?? '').padEnd(2, '0')
  const v = Number(int) * 100 + Number(dec || 0)
  return m[1] ? -v : v
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2)
}

export function formatDate(date: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  const d = new Date(date + 'T12:00:00')
  return isNaN(+d) ? date : d.toLocaleDateString(intlLocale(), opts)
}

export function formatMonth(month: string): string {
  return formatDate(month + '-15', { month: 'long', year: 'numeric' })
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

export const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'MAD', 'BRL', 'MXN', 'INR', 'CNY', 'NZD', 'ZAR', 'THB']

export function allCurrencies(): string[] {
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency')
    if (all?.length) return [...COMMON_CURRENCIES, ...all.filter((c) => !COMMON_CURRENCIES.includes(c))]
  } catch {
    /* older browsers */
  }
  return COMMON_CURRENCIES
}

export function currencyName(code: string): string {
  try {
    return new Intl.DisplayNames([intlLocale()], { type: 'currency' }).of(code) ?? code
  } catch {
    return code
  }
}
