import { useEffect, useState } from 'preact/hooks'
import type { GroupView } from '../app/app'
import { inviteLink } from '../app/invite'
import { t } from '../i18n'
import { copyText } from './hooks'

/** Invite link, QR code (lazy-loaded generator), Web Share and copy. */
export function InviteCard({ view }: { view: GroupView }) {
  const { state, record } = view
  const link = inviteLink({
    v: 1,
    groupId: record.id,
    key: record.key,
    relays: state.group.relays.length ? state.group.relays : record.relays,
    name: state.group.name || record.name,
  })
  const [svg, setSvg] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    void import('qrcode-generator').then(({ default: qrcode }) => {
      const qr = qrcode(0, 'L')
      qr.addData(link)
      qr.make()
      if (alive) setSvg(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }))
    })
    return () => {
      alive = false
    }
  }, [link])
  const share = async () => {
    try {
      await navigator.share({ title: 'Splittio', text: t('Join “{name}” on Splittio', { name: state.group.name }), url: link })
    } catch {
      setCopied(await copyText(link))
    }
  }
  return (
    <div class="card invite">
      <h3>{t('Invite people')}</h3>
      <p class="small">{t('Scan this code with the phone’s camera app, or send the link.')}</p>
      <div class="qr" aria-label={t('QR code of the invite link')} dangerouslySetInnerHTML={{ __html: svg }} />
      <div class="row wrap">
        {'share' in navigator && (
          <button class="btn primary" onClick={share}>
            {t('Share link')}
          </button>
        )}
        <button class="btn" onClick={async () => setCopied(await copyText(link))}>
          {copied ? t('Link copied ✓') : t('Copy link')}
        </button>
      </div>
      <details>
        <summary class="small">{t('Show link')}</summary>
        <textarea class="mono small" readOnly rows={4} value={link} onFocus={(e) => e.currentTarget.select()} />
      </details>
      <p class="notice small">🔑 {t('The link is the group’s password: anyone who has it can read the group and act as any member. Share it privately.')}</p>
    </div>
  )
}
