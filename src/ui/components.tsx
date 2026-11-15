import type { ComponentChildren } from 'preact'
import { CATEGORIES } from '../core/categories'
import { t } from '../i18n'
import type { SyncStatus } from '../sync/engine'
import { allCurrencies } from './format'

export function CurrencySelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const list = allCurrencies()
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      {!list.includes(value) && <option value={value}>{value}</option>}
      {list.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}

export function categoryName(id: number): string {
  return t(CATEGORIES.find((c) => c.id === id)?.name ?? 'General')
}

export function CategorySelect({ value, onChange, id }: { value: number; onChange: (v: number) => void; id?: string }) {
  const groups = [...new Set(CATEGORIES.map((c) => c.grouping))]
  return (
    <select id={id} value={String(value)} onChange={(e) => onChange(Number(e.currentTarget.value))}>
      {groups.map((g) => (
        <optgroup key={g} label={t(g)}>
          {CATEGORIES.filter((c) => c.grouping === g).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {t(c.name)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

const CATEGORY_ICONS: Record<string, string> = {
  Uncategorized: '•',
  Entertainment: '🎬',
  'Food and Drink': '🍽',
  Home: '🏠',
  Life: '🌱',
  Transportation: '🚆',
  Utilities: '💡',
}

export function categoryIcon(id: number): string {
  if (id === 1) return '💸'
  return CATEGORY_ICONS[CATEGORIES.find((c) => c.id === id)?.grouping ?? ''] ?? '•'
}

/** Honest sync state: saved here vs. accepted by relays. */
export function syncSummary(s: SyncStatus, groupRelays: string[]): { text: string; tone: 'ok' | 'warn' | 'off' } {
  const open = s.relays.filter((r) => r.status === 'open' && groupRelays.includes(r.url)).length
  const total = groupRelays.length
  const local = s.outbox + s.unconfirmed
  if (local > 0)
    return {
      text: open === 0 ? t('Offline: {n} change(s) saved on this phone', { n: local }) : t('Sending {n} change(s)…', { n: local }),
      tone: open === 0 ? 'off' : 'warn',
    }
  if (open === 0) return { text: t('Offline: changes are saved on this phone'), tone: 'off' }
  return { text: t('Connected to {open}/{total} relays', { open, total }), tone: open >= 2 ? 'ok' : 'warn' }
}

export function Section({ title, children, action }: { title: string; children: ComponentChildren; action?: ComponentChildren }) {
  return (
    <section class="card">
      <div class="section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

export function Bar({ value, max, tone }: { value: number; max: number; tone?: 'pos' | 'neg' }) {
  const pct = max > 0 ? Math.min(100, Math.round((Math.abs(value) / max) * 100)) : 0
  return (
    <div class="bar-track">
      <div class={'bar-fill ' + (tone ?? '')} style={{ width: pct + '%' }} />
    </div>
  )
}
