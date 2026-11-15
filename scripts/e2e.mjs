// End-to-end check with real browsers: two "phones" (separate browser contexts,
// separate storage) share a group through a local relay, including an offline
// edit on one of them. Also checks the iPhone join flow and French auto-detection.
//
//   npm run build && npm run e2e        (screenshots go to e2e-shots/)
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, devices } from 'playwright'
import { startRelay } from './dev-relay.mjs'

const SHOTS = process.env.SHOTS ?? 'e2e-shots'
mkdirSync(SHOTS, { recursive: true })
const relay = await startRelay({ port: 0, quiet: true })
const preview = spawn('npx', ['vite', 'preview', '--port', '4317', '--strictPort'], { stdio: 'pipe', detached: true })
await new Promise((r) => preview.stdout.on('data', (d) => String(d).includes('4317') && r()))
const BASE = 'http://localhost:4317/'

const browser = await chromium.launch()
const failures = []
const check = (cond, msg) => {
  console.log((cond ? '✓ ' : '✗ ') + msg)
  if (!cond) failures.push(msg)
}

async function phone(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-GB', ...opts })
  await ctx.addInitScript(
    ([r]) => {
      localStorage.setItem('splittio.defaultRelays', JSON.stringify([r]))
      localStorage.setItem('splittio.fallbackRelays', '[]')
    },
    [relay.url],
  )
  const page = await ctx.newPage()
  page.on('pageerror', (e) => failures.push(`${name}: ${e.message}`))
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(name, 'console', m.type(), m.text()))
  return { ctx, page }
}

try {
  // ---- Phone A creates the group ----
  const A = await phone('A')
  await A.page.goto(BASE)
  await A.page.getByRole('link', { name: '+ New group' }).click()
  await A.page.getByLabel('Group name').fill('Raclette 2026')
  await A.page.getByLabel('Participant 1').fill('Ann')
  await A.page.getByLabel('Participant 2').fill('Bob')
  await A.page.getByRole('button', { name: '+ Add participant' }).click()
  await A.page.getByLabel('Participant 3').fill('Cy')
  await A.page.getByRole('button', { name: 'Create group' }).click()
  await A.page.waitForSelector('.qr svg')
  await A.page.screenshot({ path: `${SHOTS}/1-invite.png` })
  await A.page.getByText('Show link').click()
  const link = await A.page.locator('.invite textarea').inputValue()
  check(link.startsWith(BASE + '#/join/'), 'invite link generated with QR code')
  await A.page.getByRole('link', { name: 'Continue to the group' }).click()

  // ---- A adds an expense ----
  await A.page.getByRole('link', { name: 'Add expense' }).click()
  await A.page.getByLabel('Title').fill('Cheese')
  await A.page.getByLabel('Amount').fill('60')
  await A.page.getByRole('button', { name: 'Save' }).click()
  await A.page.waitForSelector('text=Cheese')

  // ---- Phone B joins with the link ----
  const B = await phone('B')
  await B.page.goto(link)
  await B.page.getByRole('button', { name: 'Join group' }).click()
  await B.page.waitForURL(/#\/g\/.*\/who/)
  check(!B.page.url().includes('/join/'), 'invite key stripped from the address bar after joining')
  await B.page.getByRole('button', { name: 'Bob' }).click()
  await B.page.waitForSelector('text=Cheese', { timeout: 10000 })
  check(true, 'B received the group and the expense from the relay')
  await B.page.getByRole('tab', { name: 'Balances' }).click()
  const bobOwes = await B.page.getByText('Bob owes Ann').first().waitFor().then(() => true, () => false)
  check(bobOwes, 'B sees "Bob owes Ann" in suggested reimbursements')
  await B.page.screenshot({ path: `${SHOTS}/2-balances-B.png` })

  // ---- B goes offline and edits; A edits meanwhile ----
  await B.ctx.setOffline(true)
  relay.disconnectAll()
  await B.page.getByRole('tab', { name: 'Expenses' }).click()
  await B.page.getByRole('link', { name: 'Add expense' }).click()
  await B.page.getByLabel('Title').fill('Wine')
  await B.page.getByLabel('Amount').fill('24,50')
  await B.page.getByRole('radio', { name: 'By shares' }).click()
  await B.page.getByLabel('Value for Bob').fill('2')
  await B.page.getByRole('button', { name: 'Save' }).click()
  await B.page.waitForSelector('text=Wine')
  check((await B.page.getByText('on this phone').count()) > 0, 'offline expense marked "on this phone"')
  await B.page.screenshot({ path: `${SHOTS}/3-offline-B.png` })

  await A.page.getByText('Cheese').click()
  await A.page.getByLabel('Title').fill('Cheese (Beaufort)')
  await A.page.getByRole('button', { name: 'Save' }).click()
  await A.page.waitForSelector('text=Cheese (Beaufort)')

  await B.ctx.setOffline(false)
  await B.page.evaluate(() => dispatchEvent(new Event('online')))
  await B.page.waitForSelector('text=Cheese (Beaufort)', { timeout: 20000 })
  await A.page.waitForSelector('text=Wine', { timeout: 20000 })
  check(true, 'after reconnecting, both phones have both edits')
  await B.page.waitForFunction(() => !document.body.innerText.includes('on this phone'), null, { timeout: 15000 })
  check(true, 'pending marker cleared once a relay confirmed')
  await A.page.getByRole('tab', { name: 'Balances' }).click()
  await B.page.getByRole('tab', { name: 'Balances' }).click()
  await A.page.locator('.balances .value').first().waitFor()
  await B.page.locator('.balances .value').first().waitFor()
  const balA = await A.page.locator('.balances .value').allInnerTexts()
  const balB = await B.page.locator('.balances .value').allInnerTexts()
  console.log('  balances A:', balA.join(' / '), ' B:', balB.join(' / '))
  check(balA.join() === balB.join() && balA.length === 3, 'both phones show identical balances')
  await A.page.screenshot({ path: `${SHOTS}/4-balances-A.png` })

  // ---- Activity log shows device ----
  await A.page.getByRole('tab', { name: 'Activity' }).click()
  const act = await A.page.locator('.activity').innerText()
  check(act.includes('Bob') && act.includes('Wine'), 'activity log names who changed what')
  await A.page.screenshot({ path: `${SHOTS}/5-activity-A.png` })

  // ---- iPhone in Safari: install-first join flow ----
  const iphone = await browser.newContext({ ...devices['iPhone 13'] })
  const ip = await iphone.newPage()
  await ip.goto(link)
  check(await ip.getByText('Install Splittio first').waitFor({ timeout: 10000 }).then(() => true, () => false), 'iPhone Safari gets the install-first join flow')
  await ip.screenshot({ path: `${SHOTS}/6-iphone-join.png` })

  // ---- French browser: UI in French automatically ----
  const fr = await phone('FR', { locale: 'fr-FR' })
  await fr.page.goto(BASE)
  check(await fr.page.getByText('Vos groupes').waitFor({ timeout: 10000 }).then(() => true, () => false), 'French browser gets the French UI')
  await fr.page.screenshot({ path: `${SHOTS}/7-home-fr.png` })
  const it = await phone('IT', { locale: 'it-IT' })
  await it.page.goto(BASE)
  check(await it.page.getByText('I tuoi gruppi').waitFor({ timeout: 10000 }).then(() => true, () => false), 'Italian browser gets the Italian UI')

  // ---- Expense form screenshot ----
  await A.page.getByRole('tab', { name: 'Expenses' }).click()
  await A.page.getByRole('link', { name: 'Add expense' }).click()
  await A.page.getByLabel('Title').fill('Hotel')
  await A.page.getByLabel('Amount').fill('300')
  await A.page.getByRole('radio', { name: 'By amount' }).click()
  await A.page.screenshot({ path: `${SHOTS}/8-expense-form.png`, fullPage: true })
} catch (e) {
  failures.push(String(e.stack ?? e))
} finally {
  await browser.close()
  try {
    process.kill(-preview.pid)
  } catch {}
  await relay.close()
}
if (failures.length) {
  console.error('\nFAILURES:\n' + failures.join('\n'))
  process.exit(1)
}
console.log('\nAll end-to-end checks passed.')
