# Relay survey (M0)

First run: 15 Nov 2026, from GitHub Actions, with a brand-new key that has no profile or follows.
The probe event is shaped like a Splittio batch: kind 30078, `d` and `z` tags, ~20 KB of NIP-44 ciphertext (27.8 KB event).

| Relay | Accepts 30078 | Read back | `#z` indexed | NIP-77 | max_message_length | Paid/auth |
|---|---|---|---|---|---|---|
| wss://purplerelay.com | yes | **no** | no | yes | 131072 | no |
| wss://nos.lol | yes | yes | yes | no | 131072 | no |
| wss://relay.primal.net | yes | yes | yes | no | 1000000 | no |
| wss://relay.snort.social | yes | yes | yes | no | 524288 | no |
| wss://offchain.pub | **no** ("pubkey is not in our web of trust") | – | – | yes | 131072 | no |
| wss://nostr.data.haus | yes | yes | yes | yes | 131072 | no |
| wss://nostr.oxtr.dev | yes | yes | yes | yes | 131072 | no |
| wss://relay.nostr.wirednet.jp | yes | yes | yes | yes | 131072 | no |
| wss://nostr-pub.wellorder.net | **no connection** | – | – | ? | ? | ? |
| wss://nostr.sathoarder.com | yes | yes | yes | no | ? | no |
| wss://nostr.bitcoiner.social | yes | yes | yes | yes | 131072 | no |
| wss://nostr.mom | yes | yes | yes | no | 131072 | no |

Resulting lists (`src/sync/relays.ts`):

- **Default:** nos.lol, relay.primal.net, relay.snort.social, relay.nostr.wirednet.jp, nostr.data.haus
- **Fallback:** nostr.oxtr.dev, nostr.mom, nostr.sathoarder.com
- **Extras (selectable):** purplerelay.com, nostr.bitcoiner.social, offchain.pub, nostr-pub.wellorder.net

(Updated after the burst test below: nostr.bitcoiner.social left the defaults.)

Retention checks after 24 h and 7 days: run the "Relay survey" workflow manually with
`recheck_run_id = 43713531163`.

### 24 h retention check (16 Nov 2026, run 43867223346)

Each relay that accepted the probe was asked for it again by id:

| Relay | 24 h |
|---|---|
| nos.lol, relay.primal.net, relay.snort.social, nostr.data.haus, relay.nostr.wirednet.jp | kept |
| nostr.oxtr.dev, nostr.mom, nostr.sathoarder.com | kept |
| purplerelay.com | kept (it did not return the event right after publishing, but does now) |
| nostr.bitcoiner.social | **gone** |

Every default and fallback relay kept the event. nostr.bitcoiner.social dropped it within a day,
which matches the burst test below: it already moved to the extras. The 7-day check is due on
22 Nov 2026.

## Burst test: stable key vs. a new key per event (15 Nov 2026)

Question: if every batch is signed by a throwaway key, do relays reject or throttle Splittio more?
`scripts/relay-burst.mjs` ("Relay burst test" workflow, run 43775816024) sends 4 rounds of 20
Splittio-shaped events (~3 KB) back to back per relay, on two runners, one in the order
stable, fresh, fresh, stable and the other in the reverse order. Stable = one key for the round,
fresh = a new key for every event.

| Relay | Stable key | New key per event | Notes |
|---|---|---|---|
| nos.lol, relay.primal.net, relay.snort.social, nostr.data.haus, relay.nostr.wirednet.jp, purplerelay.com, nostr.sathoarder.com | 80/80 | 80/80 | no difference |
| nostr.oxtr.dev | 60/80 | 80/80 | **per-pubkey limit**: a stable key is "rate limited" from its 16th event; fresh keys never are |
| nostr.mom | 73/74 | 80/80 | one stable round lost the connection at its 14th event |
| nostr.bitcoiner.social | 15/80 | 15/80 | web of trust: ~15 events from unknown keys per IP, then every unknown key is refused, whichever mode came first |
| offchain.pub | 15/80 | 15/80 | same as nostr.bitcoiner.social |

All accepted events were read back after 60 s. Conclusion: a new key per event never did worse
than a stable key, and avoids per-pubkey rate limits. A device key with no profile counts as
"unknown" to web-of-trust relays just like a throwaway key, so it gains nothing there.

Separate finding: nostr.bitcoiner.social, then a default relay, now behaves as a web-of-trust relay
(the M0 survey sent only one event, inside its allowance). It moved to the extras, replaced by
relay.nostr.wirednet.jp (100% in both tests, NIP-77); nostr.sathoarder.com became a fallback.
Groups created before this keep their relay list.
