package accounts

import (
	"context"
	"net/url"
)

// TokenBalance is one token's net balance over the indexed ledger window.
// Balance and DisplayBalance are strings to preserve their full precision.
type TokenBalance struct {
	ContractID     string `json:"contractId"`
	Balance        string `json:"balance"`
	DisplayBalance string `json:"displayBalance"`
}

// BalanceResponse reports the sum of indexed transfers per token for an
// address. DerivedFromLedger is true, and Note explains the indexed window.
// Transfers before the indexer's start ledger are omitted, so the result can
// differ from the on-chain balance.
type BalanceResponse struct {
	Address           string         `json:"address"`
	Network           string         `json:"network"`
	Balances          []TokenBalance `json:"balances"`
	DerivedFromLedger bool           `json:"derivedFromLedger"`
	Note              string         `json:"note"`
}

// Balance returns an account's derived token balances (GET /accounts/{address}/balance).
func (a *Client) Balance(ctx context.Context, address string) (*BalanceResponse, error) {
	var balance BalanceResponse
	if err := a.c.Get(ctx, "/accounts/"+url.PathEscape(address)+"/balance", nil, &balance); err != nil {
		return nil, err
	}
	return &balance, nil
}
