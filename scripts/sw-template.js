// Splittio service worker: precaches the whole app so it opens offline.
// A new version is installed in the background and used on the next launch.
const VERSION = '__VERSION__'
const ASSETS = __ASSETS__
const CACHE = 'splittio-' + VERSION

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('splittio-') && k !== CACHE).map((k) => caches.delete(k)))),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin) return
  // Navigations always get the cached shell (the URL fragment never reaches us anyway).
  const key = req.mode === 'navigate' ? './' : req
  e.respondWith(
    caches.open(CACHE).then(async (c) => (await c.match(key, { ignoreSearch: true })) || fetch(req)),
  )
})
