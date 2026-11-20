# wraith-py

Python client for the [Wraith](https://github.com/Miracle656/wraith) Soroban
token transfer indexer REST API. Wraps the REST endpoints in typed dataclasses
so data analysts get autocompletion and full i128 precision (amounts are kept as
strings).

## Install

```bash
pip install wraith-py
```

## Usage

```python
from wraith import WraithClient

client = WraithClient("https://wraith.example.com")

# Transfers received by an address
page = client.incoming_transfers("GABC...", limit=100)
for transfer in page.transfers:
    # is_sac distinguishes SAC-wrapped classic assets from native Soroban tokens
    print(transfer.contract_id, transfer.amount, transfer.is_sac)

# Paginate with the cursor
if page.next_cursor:
    more = client.incoming_transfers("GABC...", cursor=page.next_cursor)

# Per-asset holdings for an account
summary = client.account_summary("GABC...")
for holding in summary.assets:
    print(holding.contract_id, holding.net, holding.tx_count)

# Most-active assets
popular = client.popular_assets(window="24h", by="volume")
for asset in popular.assets:
    print(asset.contract_id, asset.transfer_count, asset.volume)

client.close()  # or use the client as a context manager
```

## Coverage

What the Python client reaches today, against the whole API. `✅` the group in
full, `◐` part of it, `—` none of it. This client covers the least, and you
should know that before installing rather than after.

| Group                | Python | Gap                                                            |
| -------------------- | :----: | -------------------------------------------------------------- |
| Transfers            | ✅     |                                                                 |
| Accounts             | ◐      | `account_balance()` missing (`GET /accounts/{address}/balance`) |
| Windowed summary     | —      | `GET /summary/{address}` missing                   |
| Assets               | ✅     |                                                                 |
| NFTs                 | —      | missing entirely                                 |
| Status               | —      | missing                                          |
| Token directory      | —      | `GET /tokens` missing                            |
| Host-fn logs         | —      | missing; only react-query has it                 |
| Webhooks             | —      | missing; and no client can subscribe yet         |
| Search, candles, fees, offramp, NGN rails | — | #308                                  |
| Exports, ops, liveness, bot and provider callbacks, GraphQL | — | deliberate |

Everything in the "missing" rows above that has an obvious shape is #312, which
brings this client to parity with the Go one: `status`, `nfts`, `webhooks`.
The full table — every client, and why each gap is open or deliberate — is
[docs/client-coverage.md](../../docs/client-coverage.md). Change this row and
that row in the same PR.

Note also that every method here reads the deployment's default network: there
is no way to ask for the other one (#411), and the error code the API returns is
dropped (#410).

All responses are returned as typed dataclasses (`Transfer`, `TransferPage`,
`AccountSummary`, `AssetHolding`, `PopularAssets`, `PopularAsset`). Non-2xx
responses raise `WraithAPIError`.

## Development

```bash
pip install -e ".[dev]"
pytest
```

## Publishing

Builds are published to PyPI from CI on tags matching `pyclient-v*` (see
`.github/workflows/publish-python-sdk.yml`). To publish manually:

```bash
python -m build
twine upload dist/*
```
