# wraith-go

Idiomatic Go client for the [Wraith](https://github.com/Miracle656/wraith)
Soroban token-transfer indexer REST API.

The client is split into **one package per resource** — `transfers`,
`accounts`, `assets`, `nfts`, `webhooks`, `status` — all sharing a small
transport in the root `wraith` package. Amounts are returned as `string` to
preserve full i128 precision.

## Install

```bash
go get github.com/Miracle656/wraith/clients/go
```

## Usage

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/Miracle656/wraith/clients/go/wraith"
	"github.com/Miracle656/wraith/clients/go/transfers"
	"github.com/Miracle656/wraith/clients/go/assets"
)

func main() {
	c := wraith.New("https://wraith.example.com")
	ctx := context.Background()

	// Transfers received by an address.
	tc := transfers.New(c)
	page, err := tc.Incoming(ctx, "GABC...", &transfers.ListParams{
		Limit: wraith.IntPtr(100),
	})
	if err != nil {
		log.Fatal(err)
	}
	for _, t := range page.Transfers {
		fmt.Println(t.ContractID, t.Amount, t.EventType)
	}

	// Most-active assets.
	ac := assets.New(c)
	pop, err := ac.PopularAssets(ctx, &assets.PopularParams{Window: "24h", By: "volume"})
	if err != nil {
		log.Fatal(err)
	}
	for _, a := range pop.Assets {
		fmt.Println(a.ContractID, a.TransferCount, a.Volume)
	}
}
```

A non-2xx response is returned as a `*wraith.APIError`:

```go
page, err := tc.Incoming(ctx, "GABC...", nil)
var apiErr *wraith.APIError
if errors.As(err, &apiErr) {
	fmt.Println(apiErr.StatusCode, apiErr.Message)
}
```

## Packages

| Package     | Constructor             | List methods                                  |
| ----------- | ----------------------- | --------------------------------------------- |
| `wraith`    | `wraith.New(baseURL)`   | shared transport, `APIError`, options         |
| `transfers` | `transfers.New(c)`      | `Incoming`, `Outgoing`, `ForAddress`, `ByTx`  |
| `accounts`  | `accounts.New(c)`       | `Summary`, `Transfers`                        |
| `assets`    | `assets.New(c)`         | `PopularAssets`                               |
| `nfts`      | `nfts.New(c)`           | `Transfers`                                   |
| `webhooks`  | `webhooks.New(c)`       | `List`, `Deliveries`                          |
| `status`    | `status.New(c)`         | `Get`                                         |

Options: `wraith.WithHTTPClient(*http.Client)` and `wraith.WithHeader(k, v)`.

## Coverage

What the Go client reaches today, against the whole API. `✅` the group in full,
`◐` part of it, `—` none of it. Know this before installing: a gap here means
hand-rolling `net/http` against a documented route.

| Group                | Go    | Gap                                                              |
| -------------------- | :---: | ---------------------------------------------------------------- |
| Transfers            | ✅    |                                                                   |
| Accounts             | ◐     | `GET /accounts/{address}/balance` uncovered          |
| Windowed summary     | —     | `GET /summary/{address}` uncovered                     |
| Assets               | ✅    |                                                                   |
| NFTs                 | ◐     | `GET /nfts/owners/{contract}/{token_id}` uncovered |
| Status               | ✅    |                                                                   |
| Token directory      | —     | `GET /tokens` uncovered                              |
| Host-fn logs         | —     | uncovered; react-query has it                                    |
| Webhooks             | ◐     | `List`, `Deliveries` only — no `POST /webhooks`, no delete |
| Search, candles, fees, offramp, NGN rails | — | #308                                  |
| Exports, ops, liveness, bot and provider callbacks, GraphQL | — | deliberate |

The full table — every client, and why each gap is open or deliberate — is
[docs/client-coverage.md](../../docs/client-coverage.md). Change this row and
that row in the same PR.

Two per-client gaps sit outside that table because they are about how the calls
behave, not which routes exist: the client cannot select a network or filter a
summary (#412), and it drops the API's error code (#410).

## Development

```bash
cd clients/go
go test ./... -cover
go vet ./...
gofmt -l .
```
