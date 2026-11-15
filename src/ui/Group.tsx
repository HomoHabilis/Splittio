import { useEffect, useMemo, useState } from 'preact/hooks'
import { app, type GroupView } from '../app/app'
import { calculateShare } from '../core/totals'
import type { Expense } from '../core/types'
import { t } from '../i18n'
import { Activity } from './Activity'
import { Balances } from './Balances'
import { categoryIcon, categoryName, CategorySelect, syncSummary } from './components'
import { formatDate, formatMoney, formatMonth } from './format'
import { go, useApp } from './hooks'
import { Settings } from './Settings'
import { Stats } from './Stats'

const TABS = ['expenses', 'balances', 'activity', 'stats', 'settings'] as const
type Tab = (typeof TABS)[number]

export function Group({ groupId, tab }: { groupId: string; tab?: string }) {
  useApp()
  const view = app.view(groupId)
  const current: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'expenses'
  useEffect(() => {
    if (view) void app.store.updateGroup(groupId, { lastOpened: Date.now() })
  }, [groupId])
  if (!view)
    return (
      <main class="page">
        <p>{t('Group not found on this device.')}</p>
        <a class="btn" href="#/">
          {t('Go to my groups')}
        </a>
      </main>
    )
  const labels: Record<Tab, string> = {
    expenses: t('Expenses'),
    balances: t('Balances'),
    activity: t('Activity'),
    stats: t('Stats'),
    settings: t('Settings'),
  }
  const sync = syncSummary(view.status, view.state.group.relays.length ? view.state.group.relays : view.record.relays)
  return (
    <main class="page group">
      <header class="bar">
        <a href="#/" class="icon-btn" aria-label={t('Back')}>
          ←
        </a>
        <h1 class="grow">{view.state.group.name || view.record.name}</h1>
        <a class={'sync-badge ' + sync.tone} href={`#/g/${groupId}/settings`} title={sync.text}>
          <span class="dot" />
          <span class="sync-text">{sync.text}</span>
        </a>
        <a class="btn small invite-btn" href={`#/g/${groupId}/invite`}>
          {t('Invite')}
        </a>
      </header>
      {view.state.held.length > 0 && (
        <p class="notice small">{t('{n} changes waiting: the sender’s clock is ahead of yours.', { n: view.state.held.length })}</p>
      )}
      {!view.record.me && view.state.participants.length > 0 && (
        <a class="notice small" href={`#/g/${groupId}/who`}>
          {t('Tell the group who you are →')}
        </a>
      )}
      <nav class="tabs" role="tablist">
        {TABS.map((tb) => (
          <a key={tb} role="tab" aria-selected={tb === current} class={tb === current ? 'active' : ''} href={`#/g/${groupId}/${tb}`}>
            {labels[tb]}
          </a>
        ))}
      </nav>
      {current === 'expenses' && <Expenses view={view} />}
      {current === 'balances' && <Balances view={view} />}
      {current === 'activity' && <Activity view={view} />}
      {current === 'stats' && <Stats view={view} />}
      {current === 'settings' && <Settings view={view} />}
      {current === 'expenses' && (
        <a class="fab" href={`#/g/${groupId}/e/new`} aria-label={t('Add expense')}>
          +
        </a>
      )}
    </main>
  )
}

function Expenses({ view }: { view: GroupView }) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState(-1)
  const [who, setWho] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const { state, record, pending } = view
  const names = useMemo(() => new Map(state.participants.map((p) => [p.id, p.name])), [state.participants])
  const ql = q.trim().toLowerCase()
  const list = state.expenses.filter(
    (e) =>
      e.deleted === showDeleted &&
      (!ql || e.title.toLowerCase().includes(ql) || e.notes.toLowerCase().includes(ql) || (names.get(e.paidBy) ?? '').toLowerCase().includes(ql)) &&
      (cat < 0 || e.category === cat) &&
      (!who || e.paidBy === who || e.money.paidFor.some((p) => p.participantId === who)),
  )
  const byMonth = new Map<string, Expense[]>()
  for (const e of list) {
    const m = e.date.slice(0, 7)
    byMonth.set(m, [...(byMonth.get(m) ?? []), e])
  }
  const currency = state.group.currency
  return (
    <div>
      <div class="filters">
        <input type="search" placeholder={t('Search')} value={q} onInput={(e) => setQ(e.currentTarget.value)} aria-label={t('Search')} />
        <details class="more-filters">
          <summary>{t('Filter')}</summary>
          <label>
            {t('Category')}
            <div class="row">
              <CategorySelect value={cat < 0 ? 0 : cat} onChange={setCat} />
              {cat >= 0 && (
                <button class="icon-btn" onClick={() => setCat(-1)} aria-label={t('Clear')}>
                  ✕
                </button>
              )}
            </div>
          </label>
          <label>
            {t('Participant')}
            <select value={who} onChange={(e) => setWho(e.currentTarget.value)}>
              <option value="">{t('Everyone')}</option>
              {state.participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.currentTarget.checked)} /> {t('Show deleted expenses')}
          </label>
        </details>
      </div>
      {list.length === 0 && (
        <div class="empty">
          <p>{state.expenses.length ? t('No matching expenses.') : t('No expenses yet. Tap + to add the first one.')}</p>
          {!state.expenses.length && (
            <a class="btn" href={`#/g/${record.id}/invite`}>
              {t('Invite people')}
            </a>
          )}
        </div>
      )}
      {[...byMonth].map(([month, items]) => (
        <section key={month}>
          <h4 class="month">{formatMonth(month)}</h4>
          <ul class="list">
            {items.map((e) => {
              const share = record.me ? calculateShare(record.me, e) : 0
              return (
                <li key={e.id}>
                  <a class="list-item expense" href={`#/g/${state.group.id}/e/${e.id}`}>
                    <span class="cat" aria-hidden="true">
                      {categoryIcon(e.category)}
                    </span>
                    <span class="grow">
                      <span class="title">
                        {e.title}
                        {e.recurrence !== 'none' && <span title={t('Recurring')}> ↻</span>}
                        {e.recurringFrom && <span title={t('Recurring occurrence')}> ↻</span>}
                        {e.inconsistent && <span class="warn" title={t('The split doesn’t add up; it is applied proportionally.')}> ⚠</span>}
                      </span>
                      <span class="muted small">
                        {e.isReimbursement
                          ? t('{from} paid back {to}', { from: names.get(e.paidBy) ?? '?', to: e.money.paidFor.map((p) => names.get(p.participantId) ?? '?').join(', ') })
                          : t('Paid by {name}', { name: names.get(e.paidBy) ?? '?' })}{' '}
                        · {formatDate(e.date, { day: 'numeric', month: 'short' })} · {categoryName(e.category)}
                      </span>
                    </span>
                    <span class="amount">
                      <span>{formatMoney(e.money.amount, currency)}</span>
                      {e.money.originalCurrency && e.money.originalCurrency !== currency && e.money.originalAmount !== undefined && (
                        <span class="muted small">{formatMoney(e.money.originalAmount, e.money.originalCurrency)}</span>
                      )}
                      {share !== 0 && <span class="muted small">{t('my share {amount}', { amount: formatMoney(share, currency) })}</span>}
                      {pending.has(e.id) && (
                        <span class="pending small" title={t('Saved on this phone, not yet confirmed by a relay')}>
                          ● {t('on this phone')}
                        </span>
                      )}
                    </span>
                  </a>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <div style={{ height: '80px' }} />
      {!showDeleted && state.expenses.some((e) => e.deleted) && (
        <button class="btn ghost small" onClick={() => setShowDeleted(true)}>
          {t('Show deleted expenses')}
        </button>
      )}
      <button class="sr-only" onClick={() => go(`g/${state.group.id}/e/new`)}>
        {t('Add expense')}
      </button>
    </div>
  )
}
