import { useEffect, useState } from 'preact/hooks'
import { app, type GroupView } from '../app/app'
import { exportCsv, exportJson, importIntoGroup, makeBackup, parseImport, rekeyGroup } from '../app/data'
import { getBalances, toLedger } from '../core/balances'
import { uuid } from '../core/util'
import { LANGUAGES, lang, setLanguage, storedLanguage, t, type Lang } from '../i18n'
import { normalizeRelayUrl } from '../sync/relays'
import { CurrencySelect, Section } from './components'
import { formatTime } from './format'
import { download, go } from './hooks'
import { InviteCard } from './InviteCard'

export function Settings({ view }: { view: GroupView }) {
  const { state } = view
  const gid = state.group.id
  return (
    <div>
      <InviteCard view={view} />
      <MeSection view={view} />
      <GroupSection view={view} />
      <Participants view={view} />
      <SyncSection view={view} />
      <Section title={t('Devices')}>
        <ul class="list compact">
          {state.devices.map((d) => (
            <li key={d.pubkey} class="list-item">
              <span class="grow">
                {state.participants.find((p) => p.id === d.participantId)?.name ?? t('Unknown member')} · {d.label ?? '?'}
                {d.pubkey === app.device.pubkey && <span class="badge">{t('this device')}</span>}
              </span>
              <span class="mono small muted">{d.pubkey.slice(0, 8)}</span>
            </li>
          ))}
        </ul>
        <p class="muted small">{t('Every change is signed by the device that made it. Signatures show which device changed what, but anyone with the link can claim to be any member.')}</p>
      </Section>
      <DataSection view={view} />
      <Section title={t('Security')}>
        <p class="small">{t('If the link leaked, or someone must lose access, re-key the group: a new group with a new link is created with the current expenses. Share the new link with the people who should stay.')}</p>
        <button
          class="btn"
          onClick={async () => {
            if (!confirm(t('Create a new group with a new key and the current expenses?'))) return
            const id = await rekeyGroup(view)
            go(`g/${id}/invite`)
          }}
        >
          {t('Re-key group')}
        </button>
        <hr />
        <button
          class="btn danger"
          onClick={async () => {
            if (!confirm(t('Remove “{name}” from this device? Other members keep it.', { name: state.group.name }))) return
            await app.leaveGroup(gid)
            go('', true)
          }}
        >
          {t('Remove group from this device')}
        </button>
      </Section>
    </div>
  )
}

function MeSection({ view }: { view: GroupView }) {
  const { state, record } = view
  const me = state.participants.find((p) => p.id === record.me)
  const [l, setL] = useState<Lang | ''>(storedLanguage() ?? '')
  return (
    <Section title={t('You')}>
      <p>
        {me ? t('You are {name} in this group.', { name: me.name }) : t('You haven’t said who you are yet.')}{' '}
        <a href={`#/g/${state.group.id}/who`}>{t('Change')}</a>
      </p>
      <label>
        {t('Language')}
        <select
          value={l}
          onChange={async (e) => {
            const v = e.currentTarget.value as Lang | ''
            setL(v)
            await setLanguage(v || null)
            void app.refold(state.group.id)
          }}
        >
          <option value="">{t('Automatic (browser: {lang})', { lang: LANGUAGES[lang] })}</option>
          {(Object.keys(LANGUAGES) as Lang[]).map((k) => (
            <option key={k} value={k}>
              {LANGUAGES[k]}
            </option>
          ))}
        </select>
      </label>
    </Section>
  )
}

function GroupSection({ view }: { view: GroupView }) {
  const { state } = view
  const [name, setName] = useState(state.group.name)
  const [currency, setCurrency] = useState(state.group.currency)
  const [info, setInfo] = useState(state.group.information)
  const changed = name.trim() !== state.group.name || currency !== state.group.currency || info !== state.group.information
  const save = async (e: Event) => {
    e.preventDefault()
    const set: Record<string, unknown> = {}
    if (name.trim() !== state.group.name) set.name = name.trim()
    if (currency !== state.group.currency) set.currency = currency
    if (info !== state.group.information) set.information = info
    await app.apply(state.group.id, [app.factory(state.group.id).op('group', state.group.id, set)])
  }
  return (
    <Section title={t('Group')}>
      {state.group.movedOn && <p class="notice small">{t('This group was re-keyed on {date}. Ask a member for the new link.', { date: formatTime(state.group.movedOn) })}</p>}
      <form class="form" onSubmit={save}>
        <label>
          {t('Group name')}
          <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        <label>
          {t('Currency')}
          <CurrencySelect value={currency} onChange={setCurrency} />
        </label>
        <label>
          {t('Information')}
          <textarea rows={2} value={info} onInput={(e) => setInfo(e.currentTarget.value)} />
        </label>
        <button class="btn" disabled={!changed || !name.trim()}>
          {t('Save')}
        </button>
      </form>
    </Section>
  )
}

function Participants({ view }: { view: GroupView }) {
  const { state } = view
  const gid = state.group.id
  const [newName, setNewName] = useState('')
  const balances = getBalances(state.expenses.filter((e) => !e.deleted).map(toLedger))
  const op = (id: string, set: Record<string, unknown>) => app.apply(gid, [app.factory(gid).op('participant', id, set)])
  return (
    <Section title={t('Participants')}>
      <ul class="list compact">
        {state.participants.map((p) => {
          const bal = balances[p.id]?.total ?? 0
          return (
            <li key={p.id} class={'list-item' + (p.deleted ? ' muted' : '')}>
              <input
                class="grow plain"
                value={p.name}
                aria-label={t('Name')}
                onChange={(e) => {
                  const v = e.currentTarget.value.trim()
                  if (v && v !== p.name) void op(p.id, { name: v })
                }}
              />
              {p.deleted ? (
                <button class="btn small" onClick={() => op(p.id, { deleted: false })}>
                  {t('Restore')}
                </button>
              ) : (
                <button
                  class="btn small ghost"
                  disabled={bal !== 0}
                  title={bal !== 0 ? t('Settle this person’s balance before removing them.') : ''}
                  onClick={() => confirm(t('Remove {name}?', { name: p.name })) && op(p.id, { deleted: true })}
                >
                  {t('Remove')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <form
        class="row"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!newName.trim()) return
          await op(uuid(), { name: newName.trim() })
          setNewName('')
        }}
      >
        <input value={newName} onInput={(e) => setNewName(e.currentTarget.value)} placeholder={t('Name')} aria-label={t('New participant')} />
        <button class="btn" disabled={!newName.trim()}>
          {t('Add')}
        </button>
      </form>
    </Section>
  )
}

function SyncSection({ view }: { view: GroupView }) {
  const { state, record, status } = view
  const gid = state.group.id
  const relays = state.group.relays.length ? state.group.relays : record.relays
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted)
  }, [])
  const setRelays = (list: string[]) => app.apply(gid, [app.factory(gid).op('group', gid, { relays: list })])
  const statusLabel = (s: string) => ({ open: t('connected'), connecting: t('connecting…'), closed: t('offline'), idle: t('idle') })[s] ?? s
  return (
    <Section
      title={t('Sync')}
      action={
        <button
          class="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            app.sync(gid)?.kick()
            await app.sync(gid)?.reconcileAll(true)
            setBusy(false)
          }}
        >
          {busy ? t('Syncing…') : t('Sync now')}
        </button>
      }
    >
      <dl class="totals small">
        <dt>{t('Saved on this phone, not sent yet')}</dt>
        <dd>{status.outbox}</dd>
        <dt>{t('Sent, waiting for a relay to confirm')}</dt>
        <dd>{status.unconfirmed}</dd>
        <dt>{t('Events being restored to relays')}</dt>
        <dd>{status.repairQueue}</dd>
      </dl>
      <ul class="list compact">
        {status.relays.map((r) => (
          <li key={r.url} class="list-item relay">
            <span class={'dot ' + (r.status === 'open' ? 'ok' : r.status === 'connecting' ? 'warn' : 'off')} />
            <span class="grow">
              <span class="mono small">{r.url.replace(/^wss:\/\//, '')}</span>
              <span class="muted small block">
                {statusLabel(r.status)}
                {r.fallback && ' · ' + t('fallback')}
                {r.info?.nip77 && ' · NIP-77'}
                {r.lastReconcile && ' · ' + t('checked {time}', { time: formatTime(r.lastReconcile) })}
                {r.lastError && ' · ' + r.lastError}
              </span>
            </span>
            {!r.fallback && relays.length > 1 && (
              <button class="icon-btn" aria-label={t('Remove relay')} onClick={() => confirm(t('Remove this relay for everyone in the group?')) && setRelays(relays.filter((x) => x !== r.url))}>
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        class="row"
        onSubmit={async (e) => {
          e.preventDefault()
          const n = normalizeRelayUrl(url)
          if (!n || relays.includes(n)) return
          await setRelays([...relays, n])
          setUrl('')
        }}
      >
        <input value={url} onInput={(e) => setUrl(e.currentTarget.value)} placeholder="wss://relay.example.com" aria-label={t('Add relay')} />
        <button class="btn" disabled={!normalizeRelayUrl(url)}>
          {t('Add relay')}
        </button>
      </form>
      <p class="muted small">{t('Relays only store encrypted data. You can add your own relay at any time.')}</p>
      {persisted === false && (
        <p class="notice small">
          {t('This browser may clear the app’s data when storage is low.')}{' '}
          <button class="link" onClick={async () => setPersisted((await navigator.storage?.persist?.()) ?? false)}>
            {t('Ask to keep it')}
          </button>
        </p>
      )}
    </Section>
  )
}

function DataSection({ view }: { view: GroupView }) {
  const { state } = view
  const [msg, setMsg] = useState('')
  const base = (state.group.name || 'group').replace(/[^\w.-]+/g, '_')
  const date = new Date().toISOString().slice(0, 10)
  return (
    <Section title={t('Import and export')}>
      <div class="row wrap">
        <button class="btn" onClick={() => download(`${base}-${date}.csv`, exportCsv(view), 'text/csv')}>
          {t('Export CSV')}
        </button>
        <button class="btn" onClick={() => download(`${base}-${date}.json`, exportJson(view))}>
          {t('Export JSON')}
        </button>
        <button
          class="btn"
          onClick={async () => {
            const pass = prompt(t('Choose a passphrase for the backup file (you will need it to restore):'))
            if (!pass) return
            download(`splittio-backup-${base}-${date}.json`, await makeBackup([state.group.id], pass))
          }}
        >
          {t('Encrypted backup')}
        </button>
      </div>
      <p class="muted small">{t('The backup keeps the full signed history and the group key, encrypted with your passphrase. Restore it from the start screen.')}</p>
      <hr />
      <label>
        {t('Import expenses into this group (Splittio CSV or JSON, Spliit JSON)')}
        <input
          type="file"
          accept=".json,.csv,application/json,text/csv"
          onChange={async (e) => {
            const input = e.currentTarget
            const file = input.files?.[0]
            if (!file) return
            try {
              const r = await importIntoGroup(state.group.id, parseImport(await file.text(), file.name))
              setMsg(t('{added} expenses imported, {skipped} already present.', r))
            } catch (err) {
              setMsg(String((err as Error).message ?? err))
            }
            input.value = ''
          }}
        />
      </label>
      {msg && <p class="notice small">{msg}</p>}
      <p class="muted small">{t('Participants are matched by name; missing ones are added. Expenses already in the group (same date, title, amount and payer) are skipped.')}</p>
    </Section>
  )
}
