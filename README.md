# Splittio

Split group expenses with friends, Tricount/Spliit style, with **no account and no server**.
Splittio is a PWA (Preact + Vite + TypeScript) served as static files. Groups live on members'
devices, and changes travel between them through public **Nostr relays**, end-to-end encrypted
with the group key. Edits from any member merge with a per-field last-writer-wins CRDT, so every
phone converges to the same ledger.

## Features

- Groups, participants, "who are you?", one participant on several devices
- Expenses with title, amount, date, category (Spliit's list), notes and payer
- 4 split modes: evenly, by shares, by percentage, by amount
- Balances, suggested reimbursements (minimum transfers), "Mark as paid"
- Multi-currency: original amount + rate (from frankfurter.dev, or entered by hand offline)
- Recurring expenses (daily, weekly, monthly, yearly), derived on every device without duplicates
- Search and filters, activity log (who changed what, from which device, with restore), stats
- Invite by link or QR code (scan with the camera app), Web Share, "Join with a link" paste box, iPhone install-first flow
- Import and export: CSV and JSON per group, import of Splittio CSV/JSON and Spliit JSON exports (into a new or an existing group), encrypted full backup (PBKDF2 + AES-GCM) with restore
- "Re-key group" when a link leaks; storage persistence request; install prompt
- English, French and Italian, picked automatically from the browser's languages (can be overridden in settings)
- Works offline (service worker); syncs when back online

## How it works

| Piece | Where |
|---|---|
| Hybrid Logical Clock | `src/core/hlc.ts` |
| Op log fold: per-field LWW, held future ops, recurring occurrences, atomic `money` field | `src/core/fold.ts` |
| Balances, shares, totals (ported from Spliit, MIT) | `src/core/{balances,shares,totals}.ts` |
| IndexedDB (signed events, ops, outbox, cursors) | `src/store/db.ts` |
| Wire format: kind 30078, `z` tag = HMAC(group key), NIP-44 v2, deflate, byte-capped batches | `src/sync/wire.ts` |
| Sync engine: sign at publish, cursors + 15 min overlap, NIP-77 / paged ID reconciliation, fallback relays, re-publish repair, snapshots | `src/sync/engine.ts` |
| Chunked snapshots with per-field HLCs | `src/sync/snapshot.ts` |
| Invite links (key in the URL fragment, stripped after joining) | `src/app/invite.ts` |

The design is described in the project plan (revised 15 Nov 2026). Small implementation choices:

- Held future ops are not kept in a separate store: every op is stored once, and the fold decides
  which are held (HLC more than 1 h ahead of the local clock). Same behaviour, one less store.
- Device announcements use their own entity kind (`device`), keyed by the device public key.
- Snapshots carry the full op history of recurring templates (their history drives the derived
  occurrences) and the held ops, plus `{value, hlc, author}` for every other field.

### Trust model

The group key in the invite link is the only credential. Anyone who has the link can read the
group, create a device, claim to be any participant and edit or delete anything. Device
signatures make changes traceable and the activity log flags new devices, but they don't prevent
impersonation. Use "Re-key group" to cut someone off.

### What relays see

Each event is signed by a throwaway key made for that one event, so relays can't tell which
device posted, or link a phone's events across groups. The device key and its Schnorr signature
over the batch travel inside the encrypted content (ops payload `v: 2`); members verify it and
reject a batch whose signature doesn't match. The signature also covers the group's ops tag, so a
batch can't be replayed into another group. Relays still see an opaque per-group tag, timing, and
the IP address of each connection, which could let a relay guess that several events came from
the same phone.
Batches from older clients (`v: 1`, signed by the device key) are still accepted.

## Development

```sh
npm install
npm run relay        # local Nostr relay (NIP-01/11/77) on ws://127.0.0.1:7447
npm run dev          # app on http://localhost:5173
```

To point the app at the local relay, run this in the browser console, then create a group:

```js
localStorage.setItem('splittio.defaultRelays', '["ws://127.0.0.1:7447"]')
localStorage.setItem('splittio.fallbackRelays', '[]')
```

(The same keys let a self-hoster change the default relays for new groups.)

### Tests

```sh
npm test             # unit + sync tests (CRDT convergence, clock skew, money, recurring, snapshots, reconciliation, import/export, i18n)
npm run build && npm run size   # size budget: < 100 KB gzipped JS + CSS
npm run e2e          # two browsers sharing a group through a local relay, offline edit, iPhone join flow, fr/it detection
```

### Relay survey (milestone M0)

```sh
npm run survey                 # publish a test event to all 12 listed relays from a fresh key
node scripts/relay-survey.mjs --recheck   # later: are the events still there? (run after 24 h and 7 days)
```

The **Relay survey** GitHub workflow runs the same script on GitHub's runners and attaches the
results; re-run it manually with the first run's id to check retention.

## Deploying to GitHub Pages

1. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Push to `main`. The **Deploy to GitHub Pages** workflow builds and publishes `dist/`.

The build uses a relative base path, so it works at `https://<user>.github.io/Splittio/` or any other
static host (GitLab/Codeberg Pages) without configuration.

## Licence

MIT. Calculation code and tests ported from [Spliit](https://github.com/spliit-app/spliit) (MIT).
The negentropy codec is vendored from [nostr-tools](https://github.com/nbd-wtf/nostr-tools) (Unlicense).
Relay list and group-key conventions follow [SplitFree](https://github.com/invincible04/SplitFree)
(reimplemented, no code copied).
