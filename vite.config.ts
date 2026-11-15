import { defineConfig } from 'vitest/config'
import preact from '@preact/preset-vite'
import { swPlugin } from './scripts/sw-plugin.ts'
import { cspPlugin } from './scripts/csp-plugin.ts'

export default defineConfig({
  // Relative base: works on a GitHub project page (/Splittio/), a user page or any other static host.
  base: './',
  plugins: [preact(), swPlugin(), cspPlugin()],
  build: { target: 'es2022', modulePreload: { polyfill: false } },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
})
