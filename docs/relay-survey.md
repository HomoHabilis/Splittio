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

- **Default:** nos.lol, relay.primal.net, relay.snort.social, nostr.bitcoiner.social, nostr.data.haus
- **Fallback:** nostr.oxtr.dev, relay.nostr.wirednet.jp, nostr.mom
- **Extras (selectable):** purplerelay.com, nostr.sathoarder.com, offchain.pub, nostr-pub.wellorder.net

Retention checks after 24 h and 7 days: run the "Relay survey" workflow manually with
`recheck_run_id = 43713531163`.
