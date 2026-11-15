import { useEffect, useState } from 'preact/hooks'
import { t } from '../i18n'
import { isIOS } from './hooks'

type BIPEvent = Event & { prompt: () => Promise<void> }
let deferred: BIPEvent | null = null
const listeners = new Set<() => void>()
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as BIPEvent
  listeners.forEach((f) => f())
})

/** "Install to Home Screen": native prompt on Android/desktop Chrome, instructions on iOS. */
export function InstallBanner() {
  const [, force] = useState(0)
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('splittio.installDismissed') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    const f = () => force((n) => n + 1)
    listeners.add(f)
    return () => void listeners.delete(f)
  }, [])
  if (hidden || (!deferred && !isIOS())) return null
  const dismiss = () => {
    setHidden(true)
    try {
      localStorage.setItem('splittio.installDismissed', '1')
    } catch {
      /* ignore */
    }
  }
  return (
    <div class="card install">
      <div class="grow">
        <strong>{t('Install Splittio')}</strong>
        {isIOS() ? (
          <p class="small">{t('In Safari, tap Share, then “Add to Home Screen”. Installed apps keep their data; Safari may delete it after 7 days without a visit.')}</p>
        ) : (
          <p class="small">{t('Open it like an app, offline too.')}</p>
        )}
      </div>
      {deferred && (
        <button
          class="btn"
          onClick={async () => {
            await deferred?.prompt()
            deferred = null
            force((n) => n + 1)
          }}
        >
          {t('Install')}
        </button>
      )}
      <button class="icon-btn" aria-label={t('Dismiss')} onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
