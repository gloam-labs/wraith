// Package search is the Wraith client for account, asset, and contract search.
package search

import (
	"context"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /search endpoint.
type Client struct {
	c *wraith.Client
}

// New returns a search client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Hit is a matching account, asset, or contract. IsSAC is only present for
// assets, and LastActivityAt is only present for accounts.
type Hit struct {
	Type           string  `json:"type"`
	Value          string  `json:"value"`
	IsSAC          *bool   `json:"isSac,omitempty"`
	LastActivityAt *string `json:"lastActivityAt,omitempty"`
}

// Response is the query and its matching search hits.
type Response struct {
	Query   string `json:"query"`
	Count   int    `json:"count"`
	Results []Hit  `json:"results"`
}

// SearchParams are the optional filters for Search.
type SearchParams struct {
	Network *string // "testnet" or "mainnet"
}

func (p *SearchParams) query(prefix string) url.Values {
	q := url.Values{"q": {prefix}}
	if p == nil {
		return q
	}
	if p.Network != nil {
		wraith.AddString(q, "network", *p.Network)
	}
	return q
}

// Search looks up Stellar addresses or contract IDs by prefix (GET /search).
// Pass nil params to use the default network selection.
func (s *Client) Search(ctx context.Context, prefix string, params *SearchParams) (*Response, error) {
	var result Response
	if err := s.c.Get(ctx, "/search", params.query(prefix), &result); err != nil {
		return nil, err
	}
	return &result, nil
}
