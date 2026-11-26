// Package tokens is the Wraith client for cached token metadata.
package tokens

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /tokens endpoint.
type Client struct {
	c *wraith.Client
}

// New returns a tokens client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Token is the cached metadata for a token on a Stellar network.
type Token struct {
	Network    string `json:"network"`
	ContractID string `json:"contractId"`
	Symbol     string `json:"symbol"`
	Name       string `json:"name"`
	Decimals   int    `json:"decimals"`
}

// ListResponse contains all cached tokens for the selected network.
type ListResponse struct {
	OK      bool    `json:"ok"`
	Network string  `json:"network"`
	Tokens  []Token `json:"tokens"`
}

// ListParams are the optional filters for List.
type ListParams struct {
	Network *string // "testnet" or "mainnet"
}

func (p *ListParams) query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	if p.Network != nil {
		wraith.AddString(q, "network", *p.Network)
	}
	return q
}

// List returns the indexer's cached token metadata (GET /tokens).
// Pass nil params to use the default network selection.
func (t *Client) List(ctx context.Context, params *ListParams) (*ListResponse, error) {
	var result ListResponse
	if err := t.c.Get(ctx, "/tokens", params.query(), &result); err != nil {
		return nil, err
	}
	return &result, nil
}
