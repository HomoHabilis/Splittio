import { CreateGroup } from './CreateGroup'
import { ExpenseForm } from './ExpenseForm'
import { Group } from './Group'
import { Home } from './Home'
import { useApp, useRoute } from './hooks'
import { About, ImportPage } from './Import'
import { Join, WhoAreYou } from './Join'
import { app } from '../app/app'
import { InviteCard } from './InviteCard'
import { t } from '../i18n'

export function Root() {
  const route = useRoute()
  useApp()
  const [a, b, c, d] = route.map((s) => s.split('?')[0])
  if (a === 'new') return <CreateGroup />
  if (a === 'join' && b) return <Join payload={b} key={b} />
  if (a === 'import') return <ImportPage />
  if (a === 'about') return <About />
  if (a === 'g' && b) {
    if (c === 'who') return <WhoAreYou groupId={b} />
    if (c === 'e') return <ExpenseForm groupId={b} expenseId={d === 'new' ? undefined : d} key={b + d} />
    if (c === 'invite') {
      const view = app.view(b)
      return (
        <main class="page">
          <header class="bar">
            <a href={`#/g/${b}`} class="icon-btn" aria-label={t('Back')}>
              ←
            </a>
            <h1 class="grow">{view?.state.group.name}</h1>
          </header>
          {view && <InviteCard view={view} />}
          <a class="btn primary" href={`#/g/${b}`}>
            {t('Continue to the group')}
          </a>
        </main>
      )
    }
    return <Group groupId={b} tab={c} />
  }
  return <Home />
}
