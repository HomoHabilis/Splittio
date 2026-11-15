import { render } from 'preact'
import { app } from './app/app'
import { loadLanguage, t } from './i18n'
import { Root } from './ui/Root'
import './style.css'

async function start() {
  const root = document.getElementById('app')!
  try {
    await Promise.all([loadLanguage(), app.init()])
    render(<Root />, root)
    ;(globalThis as unknown as { splittio: unknown }).splittio = app // for debugging from the console
    // Ask the browser not to evict our data (most important on iOS/Safari).
    void navigator.storage?.persist?.().catch(() => {})
  } catch (e) {
    console.error(e)
    root.innerHTML = `<main class="page"><h1>Splittio</h1><p class="error">${t('This browser cannot store data for Splittio (private mode?).')}</p></main>`
  }
  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
}

void start()
