// Package hostfn is the Wraith client for indexed host-function logs.
package hostfn

import (
	"context"
	"encoding/json"
	"net/url"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /host-fn endpoint.
type Client struct {
	c *wraith.Client
}

// New returns a host-function client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// Log is an indexed contract event. Args and Result contain contract-specific
// JSON values. GasUsed is a decimal string when available and nil otherwise.
type Log struct {
	ContractID     string          `json:"contractId"`
	FunctionName   string          `json:"functionName"`
	Args           json.RawMessage `json:"args"`
	Result         json.RawMessage `json:"result"`
	GasUsed        *string         `json:"gasUsed"`
	Ledger         int64           `json:"ledger"`
	LedgerClosedAt string          `json:"ledgerClosedAt"`
	TxHash         string          `json:"txHash"`
	EventID        string          `json:"eventId"`
}

// Page is a page of host-function logs plus pagination metadata.
type Page struct {
	ContractID string `json:"contractId"`
	Total      int    `json:"total"`
	Limit      int    `json:"limit"`
	Offset     int    `json:"offset"`
	Logs       []Log  `json:"logs"`
}

// LogsParams are the optional filters and pagination settings for Logs.
type LogsParams struct {
	Network      *string // "testnet" or "mainnet"
	FunctionName *string
	Limit        *int
	Offset       *int
}

func (p *LogsParams) query() url.Values {
	q := url.Values{}
	if p == nil {
		return q
	}
	if p.Network != nil {
		wraith.AddString(q, "network", *p.Network)
	}
	if p.FunctionName != nil {
		wraith.AddString(q, "functionName", *p.FunctionName)
	}
	wraith.AddInt(q, "limit", p.Limit)
	wraith.AddInt(q, "offset", p.Offset)
	return q
}

// Logs returns indexed events for a contract (GET /host-fn/{contractId}).
// Pass nil params to use the server's defaults.
func (h *Client) Logs(ctx context.Context, contractID string, params *LogsParams) (*Page, error) {
	var page Page
	if err := h.c.Get(ctx, "/host-fn/"+url.PathEscape(contractID), params.query(), &page); err != nil {
		return nil, err
	}
	return &page, nil
}
