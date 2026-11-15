import type { Plugin } from 'vite'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

/**
 * Emits sw.js with a precache list of every built file, versioned by a hash of
 * the list, so the app opens offline and updates on the next launch.
 */
export function swPlugin(): Plugin {
  return {
    name: 'splittio-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'))
      const assets = ['./', ...files.map((f) => './' + f), './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg']
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12)
      const src = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace('__VERSION__', version)
        .replace('__ASSETS__', JSON.stringify(assets))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src })
    },
  }
}
