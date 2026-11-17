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
  const points = [
    { title: t('No server, no account'), text: t('Your groups live on your phones. There is no Splittio server, and nothing to sign up for.'), tech: t('Splittio is a static web app, served from GitHub Pages as plain files. All data stays in the browser’s IndexedDB: signed events, the operation log, the outbox and a sync cursor per relay. Nothing is sent to the site that serves the app.') },
    { title: t('Locked before it leaves your phone'), text: t('Every change is locked with the group’s key on your phone before it is sent. Only people in the group can unlock it.'), tech: t('Changes are grouped into batches, compressed (deflate) and encrypted with NIP-44 v2 (ChaCha20 with an HMAC-SHA256 check). The encryption key is derived from the group’s 256-bit key with HMAC. Each batch is published as a Nostr event of kind 30078.') },
    { title: t('Relays are shared mailboxes'), text: t('Changes travel through a few public relays, mailboxes run by volunteers. They pass along sealed envelopes they can’t open. Several are used at once, so one going down doesn’t matter.'), tech: t('Relays speak the Nostr protocol (NIP-01). Each event goes to all of the group’s relays, and to fallback relays when fewer than two accept it. Phones subscribe by an opaque tag (an HMAC of the group key) and catch up by comparing event ids with each relay, using NIP-77 (negentropy) or paged queries.') },
    { title: t('The invite link is the key'), text: t('The invite link contains the group’s key. Whoever has it can see and edit the group, so share it like a password. If it leaks, “Re-key group” moves the group to a new key.'), tech: t('The key sits in the URL fragment (after #), which browsers never send to the web server, and it is removed from the address bar after joining. Re-keying creates a new group with a new key and relay tag and copies everything into it; you then share the new link with the people who should stay.') },
    { title: t('Works offline, merges by itself'), text: t('Add expenses without a connection: they are saved on your phone and sent later. If two people edit at the same time, each field keeps the latest edit, and every phone ends up with the same result.'), tech: t('Each change is an operation that sets some fields of one item, stamped with a hybrid logical clock (time, counter and device). Phones combine all operations with a per-field “last writer wins” rule (a CRDT), so the order they arrive in doesn’t matter. Amount, currency and split form a single field so they never get mixed. Changes dated more than an hour in the future wait until the local clock catches up.') },
    { title: t('Hard to trace'), text: t('Relays can’t read names, amounts or the group name. Each batch of changes is signed with a brand-new key, so the signature doesn’t reveal which phone sent it.'), tech: t('Every event is signed by a throwaway key made for that one event. The device’s own key and its signature over the batch travel inside the encrypted content, so members still see which device made each change. Relays still see the group’s opaque tag, when changes are sent, and the internet address of each phone that connects, which could let a relay guess that several changes came from the same phone.') },
    { title: t('Nothing gets lost'), text: t('Each phone keeps the whole history and quietly re-sends anything a relay has forgotten. You can also save an encrypted backup.'), tech: t('Phones regularly compare their event ids with each relay and re-publish what a relay is missing, a few at a time. Every 200 changes, a phone publishes a snapshot of the group so new members don’t need the full history. Backups are encrypted with your password (PBKDF2 with 600,000 rounds, then AES-GCM).') },
    { title: t('Members trust each other'), text: t('Like a shared notebook, anyone in the group can edit or delete anything. The activity log shows who changed what, from which device, and lets you undo it.'), tech: t('Batches carry a device signature that every member checks, so each change can be traced to a device. But anyone with the key can create a new device and claim to be any participant: signatures make changes traceable, they don’t prevent impersonation. The activity log flags devices it hasn’t seen before.') },
  ]
  return (
    <main class="page prose about">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1>{t('How it works')}</h1>
      </header>
      <p>{t('Splittio is built so that no company, including us, ever holds your group’s data. Tap “Technical details” under any point for the full picture.')}</p>
      <figure class="flow">
        <svg viewBox="0 0 340 120" role="img" aria-labelledby="flow-cap">
          <rect x="2" y="34" width="86" height="52" rx="10" class="node" />
          <text x="45" y="64" class="label">{t('Your phone')}</text>
          <rect x="252" y="34" width="86" height="52" rx="10" class="node" />
          <text x="295" y="64" class="label">{t('Their phone')}</text>
          {[18, 54, 90].map((y) => (
            <g key={y}>
              <rect x="138" y={y - 12} width="64" height="24" rx="6" class="relay" />
              <path d={`M88 60 L138 ${y}`} class="wire" />
              <path d={`M202 ${y} L252 60`} class="wire" />
            </g>
          ))}
          <text x="170" y="58" class="label small">{t('Relays')}</text>
          <text x="170" y="116" class="label small muted">🔒 {t('locked with the group key')}</text>
        </svg>
        <figcaption id="flow-cap" class="small muted">
          {t('How a change travels: locked on your phone, passed on by several relays that can’t read it, unlocked on the other members’ phones.')}
        </figcaption>
      </figure>
      <ul class="points">
        {points.map((p) => (
          <li key={p.title}>
            <strong>{p.title}.</strong> {p.text}
            <details>
              <summary class="small">{t('Technical details')}</summary>
              <p class="small">{p.tech}</p>
            </details>
          </li>
        ))}
      </ul>
      <p class="small muted">
        {t('Open source, MIT licence.')} <a href="https://github.com/HomoHabilis/Splittio">github.com/HomoHabilis/Splittio</a>
      </p>
    </main>
  )
}
