# Client coverage

Every route group the API serves, and whether each of the three clients
([Go](../clients/go), [react-query](../clients/react-query),
[Python](../clients/python)) can reach it.

Two kinds of gap live here and they are not the same thing, which is the whole
reason this file exists:

- **open** — the client should reach it and does not yet. The number is the
  issue that closes it; `open —` with no number means nobody has filed it, which
  is a decision waiting to be made rather than one that has been made.
- **deliberate** — the client will not reach it, with the reason stated.

`✅` the whole group · `◐` part of it, named in the gap · `—` none of it.

| Group | Routes | Go | react-query | Python | Gap |
| --- | --- | :-: | :-: | :-: | --- |
| Transfers | `/transfers/incoming`, `/outgoing`, `/address`, `/tx` | ✅ | ✅ | ✅ | |
| Accounts | `/accounts/{address}/summary`, `/transfers`, `/balance` | ✅ | ◐ | ◐ | open — `balance` missing from react-query and Python |
| Windowed summary | `/summary/{address}` | — | — | — | open — |
| Assets | `/assets/popular` | ✅ | ✅ | ✅ | |
| NFTs | `/nfts/transfers`, `/nfts/owners/{contract}/{token_id}` | ✅ | ◐ | ✅ | open — `owners` missing from react-query |
| Status | `/status` | ✅ | ✅ | ✅ | |
| Token directory | `/tokens` | ✅ | — | — | open — missing from react-query and Python |
| Host-fn logs | `/host-fn/{contractId}` | ✅ | ✅ | — | open — missing from Python |
| Webhooks | `GET`/`POST /webhooks`, `DELETE /webhooks/{id}`, `/webhooks/{id}/deliveries` | ◐ | ◐ | ✅ | open — Go and react-query are read-only; Python can subscribe, list deliveries and delete |
| Search | `/search` | ✅ | — | — | open — missing from react-query and Python; Go's part of #308 is done |
| Candles | `/candles/{bucket}/{contractId}` | — | — | — | open — #308 |
| Fees | `/fees`, `/fees/report` | — | — | — | open — #308 |
| Offramp | `/offramp/availability`, `/rate`, `/trustline`, `/verify-bank`, `POST /orders`, `GET /orders/{orderId}` | — | — | — | open — #308 |
| NGN rails | `/ngn/customers/status`, `/ngn/bills/data-bundles`, plus seven routes missing from the spec (#291) | — | — | — | open — #308; the undocumented seven cannot be generated against |
| Exports | `/transfers.csv`, `/transfers.parquet`, `/transfers/address/{address}/export.csv` | — | — | — | deliberate — a byte stream is a different return shape from every typed page here, and a caller with a client wants the JSON page |
| Ops | `/ops/failures` | — | — | — | deliberate — gated by `OPS_TOKEN`, and a list of failed payouts is not something to hand a wallet SDK |
| Liveness, readiness, metrics | `/healthz`, `/readyz`, `/metrics` | — | — | — | deliberate — an orchestrator probe and a Prometheus scrape, not an application API |
| Bot and provider callbacks | `/discord/interactions`, `/discord/link`, `/webhooks/linq` | — | — | — | deliberate — Discord signs the first, the payout provider signs the last, and a browser opens the middle |
| GraphQL | `/graphql` | — | — | — | deliberate — a second protocol; these clients are REST |

## Cross-client gaps

Both are wider than any single row above, so they are recorded here rather than
repeated down the table:

- **Network.** The read routes take `network` (or the `X-Network` header) and
  none of the three can use it properly: Go (#412) and Python (#411) have no way
  to pass it at all, and react-query's only route in is a client-level header
  that no cache key includes, so one `QueryClient` pointed at two chains serves
  one chain's answer for the other (#413).
- **Writes.** Python can create and delete webhook subscriptions; Go and
  react-query can only list subscriptions and deliveries. No client can place
  an offramp order, which is why that row's `POST /orders` gap (#308) is about
  the money rails rather than webhook support.

## Keeping this honest

Every row was read off the code, not off a client's README:

- Go: one package per group under `clients/go/`, so `grep '^func '`.
- react-query: `clients/react-query/src/hooks/`, each hook naming its endpoint.
- Python: the public methods of `WraithClient` in `clients/python/wraith/client.py`.

When a client gains or loses a group, change the row here **and** the client's
own README table in the same PR. If the two disagree, the README wins with the
reader, and that is how this file would rot.

Issue #310 — "Nothing notices when a client falls behind the API" — proposes
replacing the hand-keeping with a CI check that diffs each client's covered
routes against the spec, with today's gaps allow-listed. Until that lands, this
table is the only record of which gaps anybody decided on.
