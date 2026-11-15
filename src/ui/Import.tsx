import { useState } from 'preact/hooks'
import { importAsNewGroup, readBackup, restoreBackup } from '../app/data'
import { t } from '../i18n'
import { go } from './hooks'

async function readFile(input: HTMLInputElement): Promise<string | null> {
  const f = input.files?.[0]
  return f ? await f.text() : null
}

export function ImportPage() {
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg('')
    try {
      await fn()
    } catch (e) {
      setMsg(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main class="page">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1>{t('Import and restore')}</h1>
      </header>
      <div class="card">
        <h3>{t('Restore an encrypted backup')}</h3>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(e) => {
            const input = e.currentTarget
            void run(async () => {
              const text = await readFile(input)
              if (!text) return
              const pass = prompt(t('Backup passphrase:'))
              if (!pass) return
              const ids = await restoreBackup(await readBackup(text, pass))
              go(ids.length === 1 ? `g/${ids[0]}` : '', true)
            })
          }}
        />
      </div>
      <div class="card">
        <h3>{t('Create a group from an export')}</h3>
        <p class="small muted">{t('Accepts a Splittio CSV or JSON export, or a Spliit JSON export (in Spliit: group settings → Export → JSON). A new group is created with the same participants and expenses.')}</p>
        <input
          type="file"
          accept=".json,.csv,application/json,text/csv"
          disabled={busy}
          onChange={(e) => {
            const input = e.currentTarget
            void run(async () => {
              const text = await readFile(input)
              if (!text) return
              const file = input.files?.[0]
              const id = await importAsNewGroup(text, file?.name, file?.name.replace(/\.[^.]+$/, ''))
              go(`g/${id}/who`, true)
            })
          }}
        />
      </div>
      {busy && (
        <p>
          <span class="spinner" /> {t('Working…')}
        </p>
      )}
      {msg && <p class="error">{msg}</p>}
    </main>
  )
}

export function About() {
  return (
    <main class="page prose">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1>{t('How it works')}</h1>
      </header>
      <p>{t('Splittio has no server and no accounts. Your groups live on your devices; changes travel between members through public Nostr relays, encrypted end to end with the group key.')}</p>
      <p>{t('The invite link contains the group key. Anyone who has it can read the group, act as any member, and edit or delete anything. Share it privately. If it leaks, use “Re-key group” in the group settings.')}</p>
      <p>{t('Every change is saved on your phone first, then sent. Each phone keeps the full signed history and re-sends what relays have lost, so the group survives relays forgetting old data.')}</p>
      <p>{t('Relays can see that some devices post encrypted data under an opaque tag, and when. They cannot read names, amounts or the group name.')}</p>
      <p class="small muted">
        {t('Open source, MIT licence.')} <a href="https://github.com/HomoHabilis/Splittio">github.com/HomoHabilis/Splittio</a>
      </p>
    </main>
  )
}
