import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import fr from '../src/i18n/fr'
import it_ from '../src/i18n/it'
import { browserLanguage } from '../src/i18n'
import { CATEGORIES } from '../src/core/categories'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}

const keys = new Set<string>()
for (const f of files('src')) for (const m of readFileSync(f, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"))
for (const c of CATEGORIES) keys.add(c.name), keys.add(c.grouping)

describe('i18n', () => {
  it.each([['fr', fr], ['it', it_]] as const)('%s translates every UI string with the same placeholders', (_, dict) => {
    const missing = [...keys].filter((k) => !(k in dict))
    expect(missing).toEqual([])
    for (const k of keys) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
      expect(ph(dict[k]), k).toBe(ph(k))
    }
  })

  it('picks the first supported browser language, English otherwise', () => {
    expect(browserLanguage(['fr-CH', 'en-US'])).toBe('fr')
    expect(browserLanguage(['de-DE', 'it-IT'])).toBe('it')
    expect(browserLanguage(['de-DE', 'es'])).toBe('en')
    expect(browserLanguage([])).toBe('en')
  })
})
