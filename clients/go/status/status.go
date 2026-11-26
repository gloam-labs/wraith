// Package status is the Wraith client for indexer status endpoints.
package status

import (
	"context"

	"github.com/Miracle656/wraith/clients/go/wraith"
)

// Client accesses the /status endpoint.
type Client struct {
	c *wraith.Client
}

// New returns a status client backed by a shared *wraith.Client.
func New(c *wraith.Client) *Client { return &Client{c: c} }

// NetworkStatus holds per-network indexer progress, as returned in the
// "networks" map of the /status response.
type NetworkStatus struct {
	LastIndexedLedger *int64 `json:"lastIndexedLedger"`
	LatestLedger      *int64 `json:"latestLedger"`
	LagLedgers        *int64 `json:"lagLedgers"`
	Running           bool   `json:"running"`
	Reason            string `json:"reason,omitempty"`
}

// Status reports the indexer's progress and lag.
//
// The "status" field is "healthy" or "degraded".
// "network" names which chain the top-level ledger fields describe.
// "networks" carries the same breakdown for every enabled network,
// regardless of which one was selected by the caller.
type Status struct {
	OK                bool                     `json:"ok"`
	Status            string                   `json:"status"`
	Network           string                   `json:"network"`
	LastIndexedLedger *int64                   `json:"lastIndexedLedger"`
	LatestLedger      *int64                   `json:"latestLedger"`
	LagLedgers        *int64                   `json:"lagLedgers"`
	StartedAt         string                   `json:"startedAt"`
	UptimeSeconds     int64                    `json:"uptimeSeconds"`
	TotalIndexed      int64                    `json:"totalIndexed"`
	Networks          map[string]NetworkStatus `json:"networks"`
}

// Get returns the current indexer status (GET /status).
func (s *Client) Get(ctx context.Context) (*Status, error) {
	var st Status
	if err := s.c.Get(ctx, "/status", nil, &st); err != nil {
		return nil, err
	}
	return &st, nil
}
