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

const CIPHER = 'x9#Qm…T4f'

/** Step-by-step scenario: Ann adds an expense, Bob receives it through relays that can't read it. */
function Journey() {
  const [step, setStep] = useState(0)
  const steps = [
    t('Ann and Bob share a group. Ann adds an expense: pizza, 24 €, paid by her.'),
    t('Before it leaves, Ann’s phone locks it with the group key. Outside the group it is just noise.'),
    t('The sealed envelope goes to several relays. They store it but can’t open it.'),
    t('Bob’s phone fetches it from any relay that is up. One being down doesn’t matter.'),
    t('Bob’s phone unlocks it with the same key. Both phones now show the same balances.'),
  ]
  const last = steps.length - 1
  const card = (x: number, y: number) => (
    <g class="j-card">
      <rect x={x} y={y} width="76" height="30" rx="5" />
      <text x={x + 38} y={y + 13}>🍕 Pizza · 24 €</text>
      <text x={x + 38} y={y + 24} class="j-sub">
        {t('paid by Ann')}
      </text>
    </g>
  )
  const envelope = (x: number, y: number, dim = false) => (
    <g class={'j-env' + (dim ? ' dim' : '')}>
      <rect x={x} y={y} width="62" height="22" rx="4" />
      <text x={x + 31} y={y + 14}>🔒 {CIPHER}</text>
    </g>
  )
  const relayY = [22, 70, 118]
  return (
    <figure class="journey">
      <svg viewBox="0 0 340 170" role="img" aria-label={steps[step]}>
        <rect x="2" y="6" width="96" height="150" rx="12" class="j-phone" />
        <text x="50" y="22" class="j-name">Ann</text>
        <rect x="242" y="6" width="96" height="150" rx="12" class="j-phone" />
        <text x="290" y="22" class="j-name">Bob</text>
        <text x="170" y="12" class="j-name small">{t('Relays')}</text>
        {relayY.map((y, i) => (
          <g key={y} class={'j-relay' + (step >= 3 && i === 0 ? ' down' : '')}>
            <rect x="136" y={y} width="68" height="34" rx="6" />
            {step >= 2 && !(step >= 3 && i === 0) && envelope(139, y + 6, true)}
            {step >= 3 && i === 0 && <text x="170" y={y + 21}>✕ {t('offline')}</text>}
            {step === 2 && <path d={`M98 100 L136 ${y + 17}`} class="j-wire" />}
            {step === 3 && i === 1 && <path d={`M204 ${y + 17} L242 100`} class="j-wire" />}
          </g>
        ))}
        {card(12, 34)}
        {step >= 1 && step <= 2 && (
          <text x="50" y="82" class="j-key">
            ↓ 🔑 {t('group key')}
          </text>
        )}
        {step >= 1 && step <= 2 && envelope(19, 90)}
        {step >= 3 && envelope(259, 90, step >= 4)}
        {step >= 4 && card(252, 34)}
        {step >= 4 && (
          <text x="290" y="82" class="j-key">
            ↑ 🔑 {t('group key')}
          </text>
        )}
        {step >= 4 &&
          [50, 290].map((x) => (
            <text key={x} x={x} y="140" class="j-sub strong">
              {t('Bob owes Ann 12 €')}
            </text>
          ))}
      </svg>
      <figcaption>
        <p class="small">
          <strong>
            {step + 1}/{steps.length}
          </strong>{' '}
          {steps[step]}
        </p>
        <div class="row">
          <button class="btn small" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
            {t('Back')}
          </button>
          <button class="btn small primary" onClick={() => setStep(step === last ? 0 : step + 1)}>
            {step === last ? t('Replay') : t('Next')}
          </button>
        </div>
      </figcaption>
    </figure>
  )
}

export function About() {
  const points = [
    { title: t('No server, no account'), text: t('Your groups live only on your phones.'), tech: t('Splittio is a static web app, served from GitHub Pages as plain files. All data stays in the browser’s IndexedDB: signed events, the operation log, the outbox and a sync cursor per relay. Nothing is sent to the site that serves the app.') },
    { title: t('Locked before it leaves your phone'), text: t('Each change is encrypted on your phone. Only group members can read it.'), tech: t('Changes are grouped into batches, compressed (deflate) and encrypted with NIP-44 v2 (ChaCha20 with an HMAC-SHA256 check). The encryption key is derived from the group’s 256-bit key with HMAC. Each batch is published as a Nostr event of kind 30078.') },
    { title: t('Relays are shared mailboxes'), text: t('Public relays pass along sealed envelopes they can’t open. Several are used, in case one is down.'), tech: t('Relays speak the Nostr protocol (NIP-01). Each event goes to all of the group’s relays, and to fallback relays when fewer than two accept it. Phones subscribe by an opaque tag (an HMAC of the group key) and catch up by comparing event ids with each relay, using NIP-77 (negentropy) or paged queries.') },
    { title: t('The invite link is the key'), text: t('Share it like a password. If it leaks, re-key the group.'), tech: t('The key sits in the URL fragment (after #), which browsers never send to the web server, and it is removed from the address bar after joining. Re-keying creates a new group with a new key and relay tag and copies everything into it; you then share the new link with the people who should stay.') },
    { title: t('Works offline, merges by itself'), text: t('Changes are sent once you’re back online, and edits merge by themselves.'), tech: t('Each change is an operation that sets some fields of one item, stamped with a hybrid logical clock (time, counter and device). Phones combine all operations with a per-field “last writer wins” rule (a CRDT), so the order they arrive in doesn’t matter. Amount, currency and split form a single field so they never get mixed. Changes dated more than an hour in the future wait until the local clock catches up.') },
    { title: t('Hard to trace'), text: t('Each batch is signed with a new key, so relays can’t tell which phone sent it.'), tech: t('Every event is signed by a throwaway key made for that one event. The device’s own key and its signature over the batch travel inside the encrypted content, so members still see which device made each change. Relays still see the group’s opaque tag, when changes are sent, and the internet address of each phone that connects, which could let a relay guess that several changes came from the same phone.') },
    { title: t('Nothing gets lost'), text: t('Every phone keeps the full history and re-sends what relays forget.'), tech: t('Phones regularly compare their event ids with each relay and re-publish what a relay is missing, a few at a time. Every 200 changes, a phone publishes a snapshot of the group so new members don’t need the full history. Backups are encrypted with your password (PBKDF2 with 600,000 rounds, then AES-GCM).') },
    { title: t('Members trust each other'), text: t('Anyone in the group can edit anything. The activity log shows who did what.'), tech: t('Batches carry a device signature that every member checks, so each change can be traced to a device. But anyone with the key can create a new device and claim to be any participant: signatures make changes traceable, they don’t prevent impersonation. The activity log flags devices it hasn’t seen before.') },
  ]
  return (
    <main class="page prose about">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1>{t('How it works')}</h1>
      </header>
      <p>{t('No company, us included, ever holds your group’s data.')}</p>
      <Journey />
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
