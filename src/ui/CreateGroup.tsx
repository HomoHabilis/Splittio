import { useState } from 'preact/hooks'
import { app } from '../app/app'
import { t } from '../i18n'
import { CurrencySelect } from './components'
import { go } from './hooks'

function defaultCurrency(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region
    const map: Record<string, string> = { US: 'USD', GB: 'GBP', CH: 'CHF', CA: 'CAD', AU: 'AUD', JP: 'JPY', SE: 'SEK', NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', IN: 'INR', BR: 'BRL', MX: 'MXN' }
    return (region && map[region]) || 'EUR'
  } catch {
    return 'EUR'
  }
}

export function CreateGroup() {
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState(defaultCurrency)
  const [people, setPeople] = useState(['', ''])
  const [me, setMe] = useState(0)
  const [busy, setBusy] = useState(false)
  const names = people.map((p) => p.trim())
  const valid = name.trim() && names.filter(Boolean).length >= 1

  const submit = async (e: Event) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    const list = names.filter(Boolean)
    const meName = names[me]
    const id = await app.createGroup({ name: name.trim(), currency, participants: list, me: Math.max(0, list.indexOf(meName)) })
    go(`g/${id}/invite`, true)
  }

  return (
    <main class="page">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1>{t('New group')}</h1>
      </header>
      <form onSubmit={submit} class="form">
        <label>
          {t('Group name')}
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('e.g. Raclette 2026')} required autofocus />
        </label>
        <label>
          {t('Currency')}
          <CurrencySelect value={currency} onChange={setCurrency} />
        </label>
        <fieldset>
          <legend>{t('Participants')}</legend>
          {people.map((p, i) => (
            <div class="row" key={i}>
              <input
                value={p}
                placeholder={t('Name')}
                aria-label={t('Participant {n}', { n: i + 1 })}
                onInput={(e) => setPeople(people.map((x, j) => (j === i ? e.currentTarget.value : x)))}
              />
              <label class="radio" title={t('This is me')}>
                <input type="radio" name="me" checked={me === i} onChange={() => setMe(i)} /> {t('Me')}
              </label>
              {people.length > 1 && (
                <button type="button" class="icon-btn" aria-label={t('Remove')} onClick={() => setPeople(people.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button type="button" class="btn ghost" onClick={() => setPeople([...people, ''])}>
            + {t('Add participant')}
          </button>
        </fieldset>
        <button class="btn primary" type="submit" disabled={!valid || busy}>
          {t('Create group')}
        </button>
      </form>
    </main>
  )
}
