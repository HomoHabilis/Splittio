import { useMemo, useState } from 'preact/hooks'
import { app } from '../app/app'
import { getExpenseShares } from '../core/shares'
import type { Expense, Money, Recurrence, SplitMode } from '../core/types'
import { localToday } from '../core/util'
import { t } from '../i18n'
import { CategorySelect, CurrencySelect } from './components'
import { centsToInput, formatMoney, parseAmount } from './format'
import { go, useApp } from './hooks'

type Row = { on: boolean; value: string }

function hashQuery(): URLSearchParams {
  const i = location.hash.indexOf('?')
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : '')
}

/** Rate (group currency per 1 unit of `from`) from frankfurter.dev, as Spliit does. */
async function fetchRate(from: string, to: string, date: string): Promise<number | null> {
  try {
    const day = date > localToday() ? 'latest' : date
    const res = await fetch(`https://api.frankfurter.dev/v1/${day}?base=${from}&symbols=${to}`)
    const j = await res.json()
    const r = Number(j?.rates?.[to])
    return r > 0 ? r : null
  } catch {
    return null
  }
}

export function ExpenseForm({ groupId, expenseId }: { groupId: string; expenseId?: string }) {
  useApp()
  const view = app.view(groupId)
  const prev = expenseId ? view?.state.expenses.find((e) => e.id === expenseId) : undefined
  const q = hashQuery()
  const groupCurrency = view?.state.group.currency ?? 'EUR'
  const people = useMemo(
    () => (view?.state.participants ?? []).filter((p) => !p.deleted || prev?.money.paidFor.some((x) => x.participantId === p.id) || prev?.paidBy === p.id),
    [view?.state.participants, prev?.id],
  )
  const me = view?.record.me

  const init = () => {
    const m = prev?.money
    const converted = !!(m?.originalCurrency && m.originalCurrency !== groupCurrency)
    const inputCurrency = converted ? m!.originalCurrency! : groupCurrency
    const inputAmount = converted ? (m!.originalAmount ?? 0) : (m?.amount ?? (q.get('amount') ? Number(q.get('amount')) : 0))
    const rows: Record<string, Row> = {}
    const mode: SplitMode = m?.splitMode ?? 'EVENLY'
    for (const p of people) {
      const pf = m?.paidFor.find((x) => x.participantId === p.id)
      let value = ''
      if (pf) {
        if (mode === 'BY_SHARES') value = String(pf.shares / 100)
        else if (mode === 'BY_PERCENTAGE') value = String(pf.shares / 100)
        else if (mode === 'BY_AMOUNT') value = centsToInput(converted && m!.rate ? Math.round(pf.shares / m!.rate) : pf.shares)
      }
      const to = q.get('to')
      rows[p.id] = { on: m ? !!pf : to ? p.id === to : !p.deleted, value: value || (mode === 'BY_SHARES' ? '1' : '') }
    }
    return {
      title: prev?.title ?? (q.get('to') ? t('Reimbursement') : ''),
      amount: inputAmount ? centsToInput(inputAmount) : '',
      currency: inputCurrency,
      rate: m?.rate ? String(m.rate) : '',
      date: prev?.date ?? localToday(),
      category: prev?.category ?? (q.get('to') ? 1 : 0),
      paidBy: prev?.paidBy ?? q.get('from') ?? me ?? people[0]?.id ?? '',
      mode,
      rows,
      notes: prev?.notes ?? '',
      recurrence: (prev?.recurrence ?? 'none') as Recurrence,
      isReimbursement: prev?.isReimbursement ?? !!q.get('to'),
    }
  }
  const [f, setF] = useState(init)
  const [busy, setBusy] = useState(false)
  const [rateMsg, setRateMsg] = useState('')
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }))
  const setRow = (id: string, r: Partial<Row>) => setF((s) => ({ ...s, rows: { ...s.rows, [id]: { ...s.rows[id], ...r } } }))

  if (!view) return null
  const converted = f.currency !== groupCurrency
  const inputCents = parseAmount(f.amount)
  const rate = converted ? Number(f.rate.replace(',', '.')) : 1
  const amount = inputCents === null || !(rate > 0) ? null : Math.round(inputCents * rate)
  const selected = people.filter((p) => f.rows[p.id]?.on)

  // Build the atomic money field.
  let money: Money | null = null
  let error = ''
  if (amount === null) error = converted && !(rate > 0) ? t('Enter the exchange rate.') : t('Enter an amount.')
  else if (selected.length === 0) error = t('Select at least one participant.')
  else {
    const paidFor = selected.map((p) => {
      const v = f.rows[p.id].value.replace(',', '.')
      let shares = 1
      if (f.mode === 'BY_SHARES') shares = Math.round(Number(v) * 100)
      if (f.mode === 'BY_PERCENTAGE') shares = Math.round(Number(v) * 100)
      if (f.mode === 'BY_AMOUNT') shares = parseAmount(f.rows[p.id].value) ?? NaN
      return { participantId: p.id, shares }
    })
    if (paidFor.some((p) => !Number.isFinite(p.shares) || p.shares < 0)) error = t('Check the split values.')
    else if (f.mode === 'BY_PERCENTAGE' && paidFor.reduce((s, p) => s + p.shares, 0) !== 10000)
      error = t('Percentages add up to {sum}%, not 100%.', { sum: paidFor.reduce((s, p) => s + p.shares, 0) / 100 })
    else if (f.mode === 'BY_AMOUNT' && paidFor.reduce((s, p) => s + p.shares, 0) !== inputCents)
      error = t('Amounts add up to {sum}, not {total}.', {
        sum: formatMoney(paidFor.reduce((s, p) => s + p.shares, 0), f.currency),
        total: formatMoney(inputCents ?? 0, f.currency),
      })
    else if (f.mode === 'BY_SHARES' && paidFor.reduce((s, p) => s + p.shares, 0) <= 0) error = t('Check the split values.')
    else {
      if (f.mode === 'BY_AMOUNT' && converted) {
        // Convert each amount, then fix the rounding residue so the split adds up exactly.
        let sum = 0
        for (const p of paidFor) sum += p.shares = Math.round(p.shares * rate)
        paidFor[paidFor.length - 1].shares += amount - sum
      }
      money = { amount, currency: groupCurrency, splitMode: f.mode, paidFor }
      if (converted) Object.assign(money, { originalAmount: inputCents!, originalCurrency: f.currency, rate })
    }
  }
  if (!f.title.trim()) error = error || t('Enter a title.')
  if (!f.paidBy) error = error || t('Choose who paid.')
  const preview = money ? getExpenseShares({ id: prev?.id, amount: money.amount, splitMode: money.splitMode, paidFor: money.paidFor }) : null

  const save = async (e: Event) => {
    e.preventDefault()
    if (error || !money || busy) return
    setBusy(true)
    await app.saveExpense(
      groupId,
      {
        title: f.title.trim(),
        date: f.date,
        category: f.category,
        notes: f.notes,
        paidBy: f.paidBy,
        money,
        isReimbursement: f.isReimbursement,
        recurrence: prev?.recurringFrom ? 'none' : f.recurrence,
      },
      prev,
    )
    history.back()
  }

  const getRate = async () => {
    setRateMsg(t('Fetching rate…'))
    const r = await fetchRate(f.currency, groupCurrency, f.date)
    if (r) {
      set('rate', String(Math.round(r * 1e6) / 1e6))
      setRateMsg('')
    } else setRateMsg(t('Could not fetch the rate (offline?). Enter it manually.'))
  }

  const modes: [SplitMode, string][] = [
    ['EVENLY', t('Evenly')],
    ['BY_SHARES', t('By shares')],
    ['BY_PERCENTAGE', t('By percentage')],
    ['BY_AMOUNT', t('By amount')],
  ]

  return (
    <main class="page">
      <header class="bar">
        <button class="icon-btn" aria-label={t('Back')} onClick={() => history.back()}>
          ←
        </button>
        <h1 class="grow">{prev ? t('Edit expense') : f.isReimbursement ? t('New reimbursement') : t('New expense')}</h1>
      </header>
      {prev?.inconsistent && <p class="notice small">⚠ {t('The split doesn’t add up; it is applied proportionally.')}</p>}
      {prev?.recurringFrom && <p class="notice small">↻ {t('This is an occurrence of a recurring expense. Changes apply to this occurrence only.')}</p>}
      <form class="form" onSubmit={save}>
        <label>
          {t('Title')}
          <input value={f.title} onInput={(e) => set('title', e.currentTarget.value)} required autofocus={!prev} placeholder={t('e.g. Groceries')} />
        </label>
        <div class="row wrap">
          <label class="grow">
            {t('Amount')}
            <input inputMode="decimal" value={f.amount} onInput={(e) => set('amount', e.currentTarget.value)} placeholder="0.00" required />
          </label>
          <label>
            {t('Currency')}
            <CurrencySelect value={f.currency} onChange={(v) => set('currency', v)} />
          </label>
        </div>
        {converted && (
          <div class="card">
            <label>
              {t('Exchange rate: 1 {from} = ? {to}', { from: f.currency, to: groupCurrency })}
              <div class="row">
                <input inputMode="decimal" value={f.rate} onInput={(e) => set('rate', e.currentTarget.value)} />
                <button type="button" class="btn" onClick={getRate}>
                  {t('Get rate')}
                </button>
              </div>
            </label>
            {rateMsg && <p class="muted small">{rateMsg}</p>}
            {amount !== null && <p class="small">= {formatMoney(amount, groupCurrency)}</p>}
          </div>
        )}
        <div class="row wrap">
          <label class="grow">
            {t('Date')}
            <input type="date" value={f.date} onInput={(e) => set('date', e.currentTarget.value)} required />
          </label>
          <label class="grow">
            {t('Category')}
            <CategorySelect value={f.category} onChange={(v) => set('category', v)} />
          </label>
        </div>
        <label>
          {f.isReimbursement ? t('Paid back by') : t('Paid by')}
          <select value={f.paidBy} onChange={(e) => set('paidBy', e.currentTarget.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{f.isReimbursement ? t('Paid back to') : t('Paid for')}</legend>
          <div class="seg" role="radiogroup" aria-label={t('Split mode')}>
            {modes.map(([m, label]) => (
              <button
                type="button"
                key={m}
                role="radio"
                aria-checked={f.mode === m}
                class={f.mode === m ? 'on' : ''}
                onClick={() => {
                  const rows = { ...f.rows }
                  const on = people.filter((p) => rows[p.id]?.on)
                  for (const p of people) {
                    let value = ''
                    if (m === 'BY_SHARES') value = '1'
                    if (m === 'BY_PERCENTAGE' && rows[p.id].on) value = String(Math.round((10000 / on.length)) / 100)
                    rows[p.id] = { ...rows[p.id], value }
                  }
                  setF((s) => ({ ...s, mode: m, rows }))
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div class="row small">
            <button type="button" class="link" onClick={() => setF((s) => ({ ...s, rows: Object.fromEntries(people.map((p) => [p.id, { ...s.rows[p.id], on: true }])) }))}>
              {t('All')}
            </button>
            <button type="button" class="link" onClick={() => setF((s) => ({ ...s, rows: Object.fromEntries(people.map((p) => [p.id, { ...s.rows[p.id], on: false }])) }))}>
              {t('None')}
            </button>
          </div>
          {people.map((p) => (
            <div class="row split-row" key={p.id}>
              <label class="check grow">
                <input type="checkbox" checked={f.rows[p.id]?.on} onChange={(e) => setRow(p.id, { on: e.currentTarget.checked })} /> {p.name}
              </label>
              {f.mode !== 'EVENLY' && f.rows[p.id]?.on && (
                <span class="row">
                  <input
                    class="narrow"
                    inputMode="decimal"
                    aria-label={t('Value for {name}', { name: p.name })}
                    value={f.rows[p.id].value}
                    onInput={(e) => setRow(p.id, { value: e.currentTarget.value })}
                  />
                  <span class="muted small unit">{f.mode === 'BY_PERCENTAGE' ? '%' : f.mode === 'BY_AMOUNT' ? f.currency : '×'}</span>
                </span>
              )}
              <span class="muted small share-preview">{preview?.has(p.id) ? formatMoney(preview.get(p.id)!, groupCurrency) : ''}</span>
            </div>
          ))}
        </fieldset>
        <label>
          {t('Notes')}
          <textarea rows={2} value={f.notes} onInput={(e) => set('notes', e.currentTarget.value)} />
        </label>
        {!prev?.recurringFrom && (
          <label>
            {t('Repeat')}
            <select value={f.recurrence} onChange={(e) => set('recurrence', e.currentTarget.value as Recurrence)}>
              <option value="none">{t('Never')}</option>
              <option value="daily">{t('Daily')}</option>
              <option value="weekly">{t('Weekly')}</option>
              <option value="monthly">{t('Monthly')}</option>
              <option value="yearly">{t('Yearly')}</option>
            </select>
          </label>
        )}
        <label class="check">
          <input type="checkbox" checked={f.isReimbursement} onChange={(e) => set('isReimbursement', e.currentTarget.checked)} /> {t('This is a reimbursement')}
        </label>
        {error && <p class="error small">{error}</p>}
        <div class="row">
          <button class="btn primary grow" type="submit" disabled={!!error || busy}>
            {t('Save')}
          </button>
        </div>
        {prev && <ExpenseActions groupId={groupId} expense={prev} />}
      </form>
    </main>
  )
}

function ExpenseActions({ groupId, expense }: { groupId: string; expense: Expense }) {
  return (
    <div class="row">
      {expense.deleted ? (
        <button type="button" class="btn" onClick={async () => (await app.setDeleted(groupId, expense.id, false), go(`g/${groupId}`, true))}>
          {t('Restore')}
        </button>
      ) : (
        <button
          type="button"
          class="btn danger"
          onClick={async () => {
            if (!confirm(t('Delete this expense? It can be restored from the activity log.'))) return
            await app.setDeleted(groupId, expense.id, true)
            history.back()
          }}
        >
          {t('Delete')}
        </button>
      )}
      <a class="btn ghost" href={`#/g/${groupId}/activity?e=${expense.id}`}>
        {t('History')}
      </a>
    </div>
  )
}
