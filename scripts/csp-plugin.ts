import type { Plugin } from 'vite'

/**
 * Content-Security-Policy for the built app. GitHub Pages can't send headers,
 * so it goes in a <meta> tag. Only the build gets it: the dev server injects
 * inline scripts for hot reload.
 *
 * - script-src 'self': injected markup can't run code, and no remote script loads.
 * - connect-src: relays (any wss:/ws: URL a group chooses), their NIP-11 info
 *   over https:, and the currency-rate API. https: is broad because relays are
 *   user-chosen; script and image exfiltration routes stay closed. Plain http
 *   is allowed to localhost only, for a local test relay's NIP-11 info.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss: ws: https: http://localhost:* http://127.0.0.1:*",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function cspPlugin(): Plugin {
  return {
    name: 'splittio-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
    },
  }
}
