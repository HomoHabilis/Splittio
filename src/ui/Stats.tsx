import type { GroupView } from '../app/app'
import { getRecurringSpending, getSpendingByCategory, getSpendingByParticipant, getSpendingOverTime, getSpendingSummary } from '../core/totals'
import { t } from '../i18n'
import { Bar, categoryIcon, categoryName, Section } from './components'
import { formatDate, formatMoney, formatMonth } from './format'

export function Stats({ view }: { view: GroupView }) {
  const { state } = view
  const c = state.group.currency
  const live = state.expenses.filter((e) => !e.deleted)
  const summary = getSpendingSummary(live)
  const byCat = getSpendingByCategory(live)
  const byMonth = getSpendingOverTime(live)
  const byPerson = getSpendingByParticipant(state.participants.filter((p) => !p.deleted), live)
  const recurring = getRecurringSpending(live.filter((e) => !e.recurringFrom))
  const maxCat = Math.max(1, ...byCat.map((x) => Math.abs(x.total)))
  const maxMonth = Math.max(1, ...byMonth.map((x) => Math.abs(x.total)))
  const maxPerson = Math.max(1, ...byPerson.map((x) => Math.max(x.paid, x.share)))
  if (summary.expenseCount === 0) return <p class="empty">{t('No expenses yet.')}</p>
  return (
    <div>
      <Section title={t('Summary')}>
        <dl class="totals">
          <dt>{t('Total spending')}</dt>
          <dd>{formatMoney(summary.totalSpending, c)}</dd>
          <dt>{t('Expenses')}</dt>
          <dd>{summary.expenseCount}</dd>
          <dt>{t('Average expense')}</dt>
          <dd>{formatMoney(summary.averageExpense, c)}</dd>
          {summary.largestExpense && (
            <>
              <dt>{t('Largest expense')}</dt>
              <dd>
                {summary.largestExpense.title} · {formatMoney(summary.largestExpense.amount, c)}
              </dd>
            </>
          )}
          {summary.firstDate && (
            <>
              <dt>{t('Period')}</dt>
              <dd>
                {formatDate(summary.firstDate)} – {formatDate(summary.lastDate!)}
              </dd>
            </>
          )}
        </dl>
      </Section>
      <Section title={t('By category')}>
        <ul class="bars">
          {byCat.map((x) => (
            <li key={x.categoryId}>
              <span>
                {categoryIcon(x.categoryId)} {categoryName(x.categoryId)}
              </span>
              <span class="value">{formatMoney(x.total, c)}</span>
              <Bar value={x.total} max={maxCat} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t('By month')}>
        <ul class="bars">
          {byMonth.map((x) => (
            <li key={x.month}>
              <span>{formatMonth(x.month)}</span>
              <span class="value">{formatMoney(x.total, c)}</span>
              <Bar value={x.total} max={maxMonth} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title={t('By participant')}>
        <ul class="bars">
          {byPerson.map((x) => (
            <li key={x.participantId}>
              <span>{x.name}</span>
              <span class="value small">
                {t('paid {paid} · share {share}', { paid: formatMoney(x.paid, c), share: formatMoney(x.share, c) })}
              </span>
              <Bar value={x.paid} max={maxPerson} />
            </li>
          ))}
        </ul>
      </Section>
      {recurring.count > 0 && (
        <Section title={t('Recurring expenses')}>
          <dl class="totals">
            <dt>{t('Active recurring expenses')}</dt>
            <dd>{recurring.count}</dd>
            <dt>{t('Estimated per month')}</dt>
            <dd>{formatMoney(recurring.estimatedMonthly, c)}</dd>
            <dt>{t('Estimated per year')}</dt>
            <dd>{formatMoney(recurring.estimatedYearly, c)}</dd>
          </dl>
        </Section>
      )}
    </div>
  )
}
