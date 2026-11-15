// Checks the size budget: JS + CSS gzipped, first load vs. lazy chunks (icons not counted).
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const dir = 'dist/assets'
const html = readFileSync('dist/index.html', 'utf8')
let first = 0
let lazy = 0
const rows = []
for (const f of readdirSync(dir).filter((f) => /\.(js|css)$/.test(f))) {
  const gz = gzipSync(readFileSync(`${dir}/${f}`), { level: 9 }).length
  const initial = html.includes(f)
  if (initial) first += gz
  else lazy += gz
  rows.push(`${initial ? 'first' : 'lazy '}  ${(gz / 1024).toFixed(1).padStart(6)} KB  ${f}`)
}
console.log(rows.sort().join('\n'))
console.log(`\nFirst load: ${(first / 1024).toFixed(1)} KB gzipped (target 55-75 KB)`)
console.log(`Total JS + CSS: ${((first + lazy) / 1024).toFixed(1)} KB gzipped (budget < 100 KB)`)
if (first + lazy > 100 * 1024) {
  console.error('Size budget exceeded')
  process.exit(1)
}
