# wraith-go

Idiomatic Go client for the [Wraith](https://github.com/Miracle656/wraith)
Soroban token-transfer indexer REST API.

The client is split into one package per resource, all sharing the transport in
the `wraith` package. Amounts are returned as `string` to preserve full i128
precision.

## Install

```bash
go get github.com/Miracle656/wraith/clients/go
```

## Usage

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/Miracle656/wraith/clients/go/accounts"
	"github.com/Miracle656/wraith/clients/go/assets"
	"github.com/Miracle656/wraith/clients/go/hostfn"
	"github.com/Miracle656/wraith/clients/go/nfts"
	"github.com/Miracle656/wraith/clients/go/search"
	"github.com/Miracle656/wraith/clients/go/tokens"
	"github.com/Miracle656/wraith/clients/go/transfers"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func main() {
	const address = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN"
	const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"

	c := wraith.New("https://wraith.example.com")
	ctx := context.Background()

	// Transfers received by an address.
	tc := transfers.New(c)
	page, err := tc.Incoming(ctx, address, &transfers.ListParams{
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

	// Search accepts a prefix or a full Stellar address or contract ID.
	hits, err := search.New(c).Search(ctx, address, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(hits.Results)

	metadata, err := tokens.New(c).List(ctx, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(metadata.Tokens)

	logs, err := hostfn.New(c).Logs(ctx, contract, &hostfn.LogsParams{
		Limit: wraith.IntPtr(10),
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(logs.Total)

	balances, err := accounts.New(c).Balance(ctx, address)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(balances.Note, balances.Balances)

	// Check the shared APIError to distinguish an unindexed NFT from other errors.
	owner, err := nfts.New(c).Owner(ctx, contract, "42")
	var apiErr *wraith.APIError
	switch {
	case errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound:
		fmt.Println(apiErr.Message)
	case err != nil:
		log.Fatal(err)
	default:
		fmt.Println(owner.Owner)
	}
}
```

`Balance` sums indexed transfers per token. The `DerivedFromLedger` flag and `Note`
describe this window, which starts at the indexer's first ledger. The resulting
balance can differ from the on-chain balance.

## Packages

| Package     | Constructor           | Methods                                      |
| ----------- | --------------------- | -------------------------------------------- |
| `wraith`    | `wraith.New(baseURL)` | Shared transport, `APIError`, options        |
| `transfers` | `transfers.New(c)`    | `Incoming`, `Outgoing`, `ForAddress`, `ByTx` |
| `accounts`  | `accounts.New(c)`     | `Summary`, `Transfers`, `Balance`             |
| `assets`    | `assets.New(c)`       | `PopularAssets`                              |
| `nfts`      | `nfts.New(c)`         | `Transfers`, `Owner`                          |
| `webhooks`  | `webhooks.New(c)`     | `List`, `Deliveries`                          |
| `status`    | `status.New(c)`       | `Get`                                         |
| `search`    | `search.New(c)`       | `Search`                                      |
| `tokens`    | `tokens.New(c)`       | `List`                                        |
| `hostfn`    | `hostfn.New(c)`       | `Logs`                                        |

Options: `wraith.WithHTTPClient(*http.Client)` and `wraith.WithHeader(k, v)`.

## Coverage

What the Go client reaches today, against the whole API. `✅` the group in full,
`◐` part of it, `—` none of it. Know this before installing: a gap here means
hand-rolling `net/http` against a documented route.

| Group                | Go    | Gap                                                              |
| -------------------- | :---: | ---------------------------------------------------------------- |
| Transfers            | ✅    |                                                                   |
| Accounts             | ✅    |                                                                   |
| Windowed summary     | —     | `GET /summary/{address}` uncovered                                |
| Assets               | ✅    |                                                                   |
| NFTs                 | ✅    |                                                                   |
| Status               | ✅    |                                                                   |
| Token directory      | ✅    |                                                                   |
| Host-fn logs         | ✅    |                                                                   |
| Webhooks             | ◐     | `List`, `Deliveries` only — no `POST /webhooks`, no delete         |
| Search               | ✅    |                                                                   |
| Candles, fees, offramp, NGN rails | — | #308                                                     |
| Exports, ops, liveness, bot and provider callbacks, GraphQL | — | deliberate               |

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