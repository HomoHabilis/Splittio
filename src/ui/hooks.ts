import { useEffect, useState } from 'preact/hooks'
import { app } from '../app/app'

/** Re-renders whenever the app state changes. */
export function useApp(): number {
  const [v, setV] = useState(app.version)
  useEffect(() => app.subscribe(() => setV(app.version)), [])
  return v
}

export function useRoute(): string[] {
  const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const on = () => {
      setRoute(read())
      window.scrollTo(0, 0)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return route
}

export function go(path: string, replace = false): void {
  const h = '#/' + path.replace(/^\/+/, '')
  if (replace) {
    history.replaceState(null, '', h)
    dispatchEvent(new HashChangeEvent('hashchange'))
  } else location.hash = h
}

/** iOS (incl. iPadOS that reports as Mac with touch). */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
}

export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
}

export function download(name: string, data: string | Blob, type = 'application/json'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s)
    return true
  } catch {
    return false
  }
}
