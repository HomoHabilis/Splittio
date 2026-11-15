import type { GroupView } from '../app/app'
import { getBalances, getSuggestedReimbursements, toLedger } from '../core/balances'
import { getTotalActiveUserPaidFor, getTotalActiveUserShare, getTotalGroupSpending } from '../core/totals'
import { t } from '../i18n'
import { Bar, Section } from './components'
import { formatMoney } from './format'

export function Balances({ view }: { view: GroupView }) {
  const { state, record } = view
  const currency = state.group.currency
  const live = state.expenses.filter((e) => !e.deleted)
  const balances = getBalances(live.map(toLedger))
  const reimbursements = getSuggestedReimbursements(balances)
  const names = new Map(state.participants.map((p) => [p.id, p.name]))
  const people = state.participants.filter((p) => !p.deleted || (balances[p.id]?.total ?? 0) !== 0)
  const max = Math.max(1, ...people.map((p) => Math.abs(balances[p.id]?.total ?? 0)))
  const gid = state.group.id
  const flagged = live.filter((e) => e.inconsistent).length
  return (
    <div>
      <Section title={t('Balances')}>
        {flagged > 0 && <p class="notice small">⚠ {t('{n} expenses have a split that doesn’t add up; they are applied proportionally.', { n: flagged })}</p>}
        <ul class="balances">
          {people.map((p) => {
            const total = balances[p.id]?.total ?? 0
            return (
              <li key={p.id} class={p.id === record.me ? 'me' : ''}>
                <span class="name">
                  {p.name}
                  {p.id === record.me && <span class="muted small"> ({t('me')})</span>}
                </span>
                <span class={'value ' + (total > 0 ? 'pos' : total < 0 ? 'neg' : '')}>{formatMoney(total, currency)}</span>
                <Bar value={total} max={max} tone={total >= 0 ? 'pos' : 'neg'} />
              </li>
            )
          })}
        </ul>
      </Section>
      <Section title={t('Suggested reimbursements')}>
        {reimbursements.length === 0 && <p class="empty">{t('Everyone is settled up. 🎉')}</p>}
        <ul class="list">
          {reimbursements.map((r) => (
            <li key={r.from + r.to} class="list-item">
              <span class="grow">
                {t('{from} owes {to}', { from: names.get(r.from) ?? '?', to: names.get(r.to) ?? '?' })}
                <strong class="block">{formatMoney(r.amount, currency)}</strong>
              </span>
              <a class="btn small" href={`#/g/${gid}/e/new?from=${r.from}&to=${r.to}&amount=${r.amount}`}>
                {t('Mark as paid')}
              </a>
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t('Totals')}>
        <dl class="totals">
          <dt>{t('Total group spending')}</dt>
          <dd>{formatMoney(getTotalGroupSpending(live), currency)}</dd>
          {record.me && (
            <>
              <dt>{t('Paid by me')}</dt>
              <dd>{formatMoney(getTotalActiveUserPaidFor(record.me, live), currency)}</dd>
              <dt>{t('My share')}</dt>
              <dd>{formatMoney(getTotalActiveUserShare(record.me, live), currency)}</dd>
            </>
          )}
        </dl>
      </Section>
    </div>
  )
}
