import type { GroupView } from '../app/app'
import { getBalances, toLedger } from '../core/balances'
import { getHouseholdReimbursements, householdBalances, householdMembers, resolveHouseholds } from '../core/households'
import { getTotalActiveUserPaidFor, getTotalActiveUserShare, getTotalGroupSpending } from '../core/totals'
import { t } from '../i18n'
import { Bar, Section } from './components'
import { formatMoney } from './format'

export function Balances({ view }: { view: GroupView }) {
  const { state, record } = view
  const currency = state.group.currency
  const live = state.expenses.filter((e) => !e.deleted)
  const balances = getBalances(live.map(toLedger))
  const reimbursements = getHouseholdReimbursements(balances, state.participants)
  const reps = resolveHouseholds(state.participants)
  const grouped = householdBalances(balances, reps)
  const members = householdMembers(state.participants)
  const names = new Map(state.participants.map((p) => [p.id, p.name]))
  // A household is shown as "Rep + Member + …" in the suggestions.
  const label = (id: string) =>
    members.has(id) ? [id, ...members.get(id)!.filter((m) => m !== id)].map((m) => names.get(m) ?? '?').join(' + ') : names.get(id) ?? '?'
  const visible = (p: { id: string; deleted: boolean }) => !p.deleted || (balances[p.id]?.total ?? 0) !== 0
  const people = state.participants.filter((p) => visible(p) || (members.has(reps.get(p.id)!) && (grouped[reps.get(p.id)!]?.total ?? 0) !== 0))
  const max = Math.max(1, ...people.map((p) => Math.abs(balances[p.id]?.total ?? 0)), ...[...members.keys()].map((r) => Math.abs(grouped[r]?.total ?? 0)))
  // Keep each household's members together, where its first member would be.
  const firstAt = new Map<string, number>()
  people.forEach((p, i) => firstAt.has(reps.get(p.id)!) || firstAt.set(reps.get(p.id)!, i))
  people.sort((a, b) => firstAt.get(reps.get(a.id)!)! - firstAt.get(reps.get(b.id)!)!)
  const shown = new Set<string>()
  // Suggestions grouped by who receives, largest first; my own lines come first in each group.
  const myRep = record.me ? reps.get(record.me) ?? record.me : undefined
  const byRecipient = [...new Set(reimbursements.map((r) => r.to))]
    .map((to) => {
      const items = reimbursements
        .filter((r) => r.to === to)
        .sort((a, b) => Number(b.from === myRep) - Number(a.from === myRep) || b.amount - a.amount || (label(a.from) < label(b.from) ? -1 : 1))
      return { to, items, total: items.reduce((s, r) => s + r.amount, 0) }
    })
    .sort((a, b) => Number(b.to === myRep) - Number(a.to === myRep) || Number(b.items.some((r) => r.from === myRep)) - Number(a.items.some((r) => r.from === myRep)) || b.total - a.total)
  const gid = state.group.id
  const flagged = live.filter((e) => e.inconsistent).length
  return (
    <div>
      <Section title={t('Balances')}>
        {flagged > 0 && <p class="notice small">⚠ {t('{n} expenses have a split that doesn’t add up; they are applied proportionally.', { n: flagged })}</p>}
        <ul class="balances">
          {people.map((p) => {
            const rep = reps.get(p.id)!
            const total = balances[p.id]?.total ?? 0
            const household = members.has(rep) && !shown.has(rep)
            if (members.has(rep)) shown.add(rep)
            const householdTotal = grouped[rep]?.total ?? 0
            return [
              household && (
                <li key={'h-' + rep} class="household">
                  <span class="name">{label(rep)}</span>
                  <span class={'value ' + (householdTotal > 0 ? 'pos' : householdTotal < 0 ? 'neg' : '')}>{formatMoney(householdTotal, currency)}</span>
                  <Bar value={householdTotal} max={max} tone={householdTotal >= 0 ? 'pos' : 'neg'} />
                </li>
              ),
              <li key={p.id} class={(p.id === record.me ? 'me' : '') + (members.has(rep) ? ' member' : '')}>
                <span class="name">
                  {p.name}
                  {p.id === record.me && <span class="muted small"> ({t('me')})</span>}
                </span>
                <span class={'value ' + (total > 0 ? 'pos' : total < 0 ? 'neg' : '')}>{formatMoney(total, currency)}</span>
                <Bar value={total} max={max} tone={total >= 0 ? 'pos' : 'neg'} />
              </li>,
            ]
          })}
        </ul>
      </Section>
      <Section title={t('Suggested reimbursements')}>
        {reimbursements.length === 0 && <p class="empty">{t('Everyone is settled up. 🎉')}</p>}
        {reimbursements.length > 0 && (
          <p class="muted small">{t('{n} transfers settle everyone up, grouped by who receives the money.', { n: reimbursements.length })}</p>
        )}
        {byRecipient.map(({ to, total, items }) => (
          <div key={to} class={'settle' + (to === myRep ? ' mine' : '')}>
            <div class="settle-head">
              <span class="name">
                {t('{name} receives', { name: label(to) })}
                {to === myRep && <span class="muted small"> ({t('me')})</span>}
              </span>
              <span class="value pos">{formatMoney(total, currency)}</span>
            </div>
            <ul class="settle-rows">
              {items.map((r) => (
                <li key={r.from} class={r.from === myRep ? 'mine' : ''}>
                  <span class="grow">
                    {t('from {name}', { name: label(r.from) })}
                    {r.from === myRep && <span class="muted small"> ({t('me')})</span>}
                  </span>
                  <span class="value">{formatMoney(r.amount, currency)}</span>
                  <a class="btn small" href={`#/g/${gid}/e/new?from=${r.from}&to=${r.to}&amount=${r.amount}`} aria-label={t('{from} owes {to}', { from: label(r.from), to: label(r.to) })}>
                    {t('Mark as paid')}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
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
