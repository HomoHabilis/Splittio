/**
 * Tiny i18n: the English text is the key; fr/it dictionaries are lazy-loaded.
 * The language follows the browser (navigator.languages) unless the user picked one.
 */
export const LANGUAGES = { en: 'English', fr: 'Français', it: 'Italiano' } as const
export type Lang = keyof typeof LANGUAGES

let dict: Record<string, string> = {}
export let lang: Lang = 'en'

const STORAGE_KEY = 'splittio.lang'

export function storedLanguage(): Lang | null {
  try {
    const l = localStorage.getItem(STORAGE_KEY)
    return l && l in LANGUAGES ? (l as Lang) : null
  } catch {
    return null
  }
}

/** First supported language in the browser's preference list, else English. */
export function browserLanguage(langs: readonly string[] = navigator.languages ?? [navigator.language]): Lang {
  for (const l of langs) {
    const base = l.toLowerCase().split('-')[0]
    if (base in LANGUAGES) return base as Lang
  }
  return 'en'
}

export async function setLanguage(l: Lang | null): Promise<void> {
  try {
    if (l) localStorage.setItem(STORAGE_KEY, l)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode */
  }
  await loadLanguage(l ?? browserLanguage())
}

export async function loadLanguage(l: Lang = storedLanguage() ?? browserLanguage()): Promise<void> {
  dict = l === 'fr' ? (await import('./fr')).default : l === 'it' ? (await import('./it')).default : {}
  lang = l
  document.documentElement.lang = l
}

export function t(s: string, vars?: Record<string, string | number>): string {
  let r = dict[s] ?? s
  if (vars) for (const k in vars) r = r.split(`{${k}}`).join(String(vars[k]))
  return r
}

/** BCP-47 locale for Intl formatting: the browser's own if it matches the UI language. */
export function intlLocale(): string {
  const nav = navigator.languages?.find((l) => l.toLowerCase().startsWith(lang))
  return nav ?? lang
}
