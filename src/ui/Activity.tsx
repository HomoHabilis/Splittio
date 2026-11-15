import { useState } from 'preact/hooks'
import { app, type GroupView } from '../app/app'
import { hlcPhysical } from '../core/hlc'
import type { Op } from '../core/types'
import { t } from '../i18n'
import { formatMoney, formatTime } from './format'

const FIELD_LABELS: Record<string, string> = {
  title: 'title',
  date: 'date',
  category: 'category',
  notes: 'notes',
  paidBy: 'paid by',
  money: 'amount/split',
  recurrence: 'repeat',
  isReimbursement: 'reimbursement',
  name: 'name',
  currency: 'currency',
  relays: 'relays',
  information: 'information',
  participantId: 'participant',
  label: 'label',
}

export function Activity({ view }: { view: GroupView }) {
  const [limit, setLimit] = useState(100)
  const [loading, setLoading] = useState(false)
  const { state, ops, record } = view
  const filter = new URLSearchParams(location.hash.split('?')[1] ?? '').get('e')
  const names = new Map(state.participants.map((p) => [p.id, p.name]))
  const devices = new Map(state.devices.map((d) => [d.pubkey, d]))
  const expenses = new Map(state.expenses.map((e) => [e.id, e]))
  const real = ops.filter((o) => !o.opId.startsWith('snap:'))
  // First op of each device: "new device" badge.
  const firstByAuthor = new Map<string, string>()
  for (const o of real) {
    const f = firstByAuthor.get(o.author)
    if (!f || o.hlc < f) firstByAuthor.set(o.author, o.hlc)
  }
  const list = real.filter((o) => !filter || o.entityId === filter).sort((a, b) => (a.hlc < b.hlc ? 1 : -1))

  const who = (o: Op) => {
    const d = devices.get(o.author)
    const person = d?.participantId ? names.get(d.participantId) : undefined
    const label = d?.label ?? o.author.slice(0, 8)
    return { person: person ?? t('Unknown member'), label, mine: o.author === app.device.pubkey }
  }

  const describe = (o: Op): string => {
    const fields = Object.keys(o.set)
    if (o.entity === 'expense') {
      const e = expenses.get(o.entityId)
      const title = (o.set.title as string) ?? e?.title ?? '?'
      if (o.set.deleted === true) return t('deleted “{title}”', { title })
      if (o.set.deleted === false && fields.length === 1) return t('restored “{title}”', { title })
      if ('deleted' in o.set && 'money' in o.set && 'title' in o.set) {
        const m = o.set.money as { amount?: number }
        return t('added “{title}” ({amount})', { title, amount: formatMoney(m?.amount ?? 0, state.group.currency) })
      }
      return t('edited “{title}”: {fields}', { title, fields: fields.map((f) => t(FIELD_LABELS[f] ?? f)).join(', ') })
    }
    if (o.entity === 'participant') {
      if (o.set.deleted === true) return t('removed participant {name}', { name: names.get(o.entityId) ?? '?' })
      return t('set participant name to {name}', { name: String(o.set.name ?? names.get(o.entityId) ?? '?') })
    }
    if (o.entity === 'device') return t('joined with this device as {name}', { name: names.get(String(o.set.participantId)) ?? '?' })
    return t('changed group settings: {fields}', { fields: fields.map((f) => t(FIELD_LABELS[f] ?? f)).join(', ') })
  }

  return (
    <div>
      {record.historyFrom && (
        <div class="notice small">
          {t('History before {date} is not on this device.', { date: formatTime(record.historyFrom) })}{' '}
          <button
            class="link"
            disabled={loading}
            onClick={async () => {
              setLoading(true)
              await app.sync(state.group.id)?.loadFullHistory()
              setLoading(false)
            }}
          >
            {loading ? t('Loading…') : t('Fetch older history')}
          </button>
        </div>
      )}
      {filter && (
        <p class="small">
          <a href={`#/g/${state.group.id}/activity`}>{t('Show all activity')}</a>
        </p>
      )}
      {list.length === 0 && <p class="empty">{t('No activity yet.')}</p>}
      <ul class="activity">
        {list.slice(0, limit).map((o) => {
          const w = who(o)
          const e = o.entity === 'expense' ? expenses.get(o.entityId) : undefined
          return (
            <li key={o.opId}>
              <div>
                <strong>{w.person}</strong> <span class="muted small">({w.mine ? t('this device') : w.label})</span>
                {firstByAuthor.get(o.author) === o.hlc && !w.mine && <span class="badge">{t('new device')}</span>} {describe(o)}
              </div>
              <div class="muted small">
                {formatTime(hlcPhysical(o.hlc))}
                {o.set.deleted === true && e?.deleted && (
                  <>
                    {' · '}
                    <button class="link" onClick={() => app.setDeleted(state.group.id, o.entityId, false)}>
                      {t('Restore')}
                    </button>
                  </>
                )}
                {e && !e.deleted && o.set.deleted === undefined && (
                  <>
                    {' · '}
                    <a href={`#/g/${state.group.id}/e/${o.entityId}`}>{t('Open')}</a>
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {list.length > limit && (
        <button class="btn ghost" onClick={() => setLimit(limit + 200)}>
          {t('Show more')}
        </button>
      )}
    </div>
  )
}
