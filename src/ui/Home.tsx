import { useState } from 'preact/hooks'
import { app } from '../app/app'
import { parseInviteInput } from '../app/invite'
import { t } from '../i18n'
import { go, isIOS, isStandalone, useApp } from './hooks'
import { InstallBanner } from './Install'

export function JoinBox() {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const submit = (e: Event) => {
    e.preventDefault()
    const inv = parseInviteInput(text)
    if (!inv) return setErr(t('This is not a valid Splittio invite link.'))
    setErr('')
    go('join/' + text.trim().replace(/^.*#\/join\//, ''))
  }
  return (
    <form class="card join-box" onSubmit={submit}>
      <label for="join-link">
        <strong>{t('Join with a link')}</strong>
      </label>
      <p class="muted small">{t('Paste the invite link someone shared with you.')}</p>
      <div class="row">
        <input id="join-link" value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder="https://…#/join/…" autocomplete="off" />
        <button type="submit" class="btn" disabled={!text.trim()}>
          {t('Join')}
        </button>
      </div>
      {err && <p class="error">{err}</p>}
    </form>
  )
}

export function Home() {
  useApp()
  const groups = [...app.groups.values()].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || b.lastOpened - a.lastOpened)
  return (
    <main class="page">
      <header class="hero">
        <img src="./icon.svg" alt="" width="56" height="56" />
        <div>
          <h1>Splittio</h1>
          <p class="muted">{t('Share expenses with friends. No account, no server, end-to-end encrypted.')}</p>
        </div>
      </header>
      {!isStandalone() && <InstallBanner />}
      <section>
        <div class="section-head">
          <h2>{t('Your groups')}</h2>
          <a class="btn" href="#/new">
            + {t('New group')}
          </a>
        </div>
        {groups.length === 0 && <p class="empty">{t('No groups yet. Create one, or join with an invite link.')}</p>}
        <ul class="list">
          {groups.map((g) => (
            <li key={g.id}>
              <a class="list-item" href={`#/g/${g.id}`}>
                <span class="grow">{g.name || t('Loading group…')}</span>
                <button
                  class={'star' + (g.favorite ? ' on' : '')}
                  aria-label={g.favorite ? t('Remove from favorites') : t('Add to favorites')}
                  onClick={(e) => {
                    e.preventDefault()
                    void app.updateRecord(g.id, { favorite: !g.favorite })
                  }}
                >
                  ★
                </button>
              </a>
            </li>
          ))}
        </ul>
      </section>
      <JoinBox />
      {isIOS() && !isStandalone() && <p class="muted small">{t('On iPhone, add Splittio to your Home Screen first: groups joined in Safari don’t appear in the installed app.')}</p>}
      <footer class="muted small footer">
        <a href="#/import">{t('Restore a backup or import expenses')}</a> · <a href="#/about">{t('How it works and privacy')}</a>
      </footer>
    </main>
  )
}
