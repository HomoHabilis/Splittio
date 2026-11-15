import { useState } from 'preact/hooks'
import { app } from '../app/app'
import { decodeInvite, inviteLink } from '../app/invite'
import { uuid } from '../core/util'
import { t } from '../i18n'
import { copyText, go, isIOS, isStandalone, useApp } from './hooks'

export function Join({ payload }: { payload: string }) {
  const inv = decodeInvite(payload)
  const [safari, setSafari] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!inv)
    return (
      <main class="page">
        <h1>{t('Invalid invite link')}</h1>
        <p>{t('This is not a valid Splittio invite link.')}</p>
        <a class="btn" href="#/">
          {t('Go to my groups')}
        </a>
      </main>
    )
  if (inv.expires && inv.expires < Date.now())
    return (
      <main class="page">
        <h1>{t('This invite has expired')}</h1>
        <p>{t('Ask a member of the group for a new link.')}</p>
        <a class="btn" href="#/">
          {t('Go to my groups')}
        </a>
      </main>
    )
  if (app.groups.has(inv.groupId)) {
    queueMicrotask(() => go(`g/${inv.groupId}`, true))
    return null
  }

  // iOS: a Home Screen app has separate storage from Safari and never receives links.
  if (isIOS() && !isStandalone() && !safari) {
    const link = inviteLink(inv)
    return (
      <main class="page">
        <h1>{t('Join “{name}”', { name: inv.name })}</h1>
        <div class="card">
          <h3>{t('Install Splittio first')}</h3>
          <ol class="steps">
            <li>{t('Tap Copy link below.')}</li>
            <li>{t('Tap the Share button in Safari, then “Add to Home Screen”.')}</li>
            <li>{t('Open Splittio from your Home Screen and paste the link in “Join with a link”.')}</li>
          </ol>
          <button
            class="btn primary"
            onClick={async () => {
              setCopied(await copyText(link))
            }}
          >
            {copied ? t('Link copied ✓') : t('Copy link')}
          </button>
          {!copied && <textarea class="mono small" readOnly rows={3} value={link} onFocus={(e) => e.currentTarget.select()} />}
        </div>
        <button class="btn ghost" onClick={() => setSafari(true)}>
          {t('Continue in Safari anyway')}
        </button>
        <p class="muted small">{t('Safari may delete the group from this phone after 7 days without a visit.')}</p>
      </main>
    )
  }

  const join = async () => {
    setBusy(true)
    const id = await app.joinGroup(inv)
    // Strip the key from the address bar, history and synced tabs.
    go(`g/${id}/who`, true)
  }

  return (
    <main class="page">
      <h1>{t('Join “{name}”', { name: inv.name })}</h1>
      <div class="card">
        <p>{t('You were invited to share expenses in this group.')}</p>
        <p class="muted small">{t('The link is the group’s password: anyone who has it can read the group and act as any member. Share it privately.')}</p>
        <button class="btn primary" onClick={join} disabled={busy}>
          {t('Join group')}
        </button>
      </div>
    </main>
  )
}

export function WhoAreYou({ groupId }: { groupId: string }) {
  useApp()
  const view = app.view(groupId)
  const [name, setName] = useState('')
  if (!view) return null
  const people = view.state.participants.filter((p) => !p.deleted)
  const pick = async (pid: string) => {
    await app.setMe(groupId, pid)
    go(`g/${groupId}`, true)
  }
  const addMe = async (e: Event) => {
    e.preventDefault()
    if (!name.trim()) return
    const pid = uuid()
    await app.apply(groupId, [app.factory(groupId).op('participant', pid, { name: name.trim() })])
    await pick(pid)
  }
  return (
    <main class="page">
      <h1>{view.state.group.name || view.record.name}</h1>
      <h2>{t('Who are you?')}</h2>
      {people.length === 0 && (
        <p class="muted">
          <span class="spinner" /> {t('Fetching the group from relays…')}
        </p>
      )}
      <ul class="list">
        {people.map((p) => (
          <li key={p.id}>
            <button class={'list-item' + (view.record.me === p.id ? ' selected' : '')} onClick={() => pick(p.id)}>
              {p.name}
            </button>
          </li>
        ))}
      </ul>
      <form class="card" onSubmit={addMe}>
        <label>
          {t('Not in the list? Add yourself')}
          <div class="row">
            <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('Your name')} />
            <button class="btn" type="submit" disabled={!name.trim()}>
              {t('Add')}
            </button>
          </div>
        </label>
      </form>
      <button class="btn ghost" onClick={() => go(`g/${groupId}`, true)}>
        {t('Skip for now')}
      </button>
    </main>
  )
}
