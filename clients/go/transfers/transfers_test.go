package transfers_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/transfers"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestIncoming(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transfers/incoming/GABC" {
			t.Errorf("path = %q", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("limit") != "50" {
			t.Errorf("limit = %q, want 50", q.Get("limit"))
		}
		if q.Get("contractId") != "CABC" {
			t.Errorf("contractId = %q, want CABC", q.Get("contractId"))
		}
		w.Header().Set("content-type", "application/json")
		// Real API shape: hasMore always present, total absent unless includeTotal=true.
		_, _ = w.Write([]byte(`{
			"hasMore":false,"limit":50,"offset":0,"nextCursor":null,
			"transfers":[{"id":1,"contractId":"CABC","eventType":"transfer",
			"fromAddress":"GFROM","toAddress":"GABC","amount":"100",
			"displayAmount":"0.0000100","ledger":10,"ledgerClosedAt":"2026-01-01T00:00:00Z",
			"txHash":"deadbeef","eventId":"evt-1"}]}`))
	}))
	defer srv.Close()

	c := transfers.New(wraith.New(srv.URL))
	page, err := c.Incoming(context.Background(), "GABC", &transfers.ListParams{
		ContractID: "CABC",
		Limit:      wraith.IntPtr(50),
	})
	if err != nil {
		t.Fatalf("Incoming: %v", err)
	}
	if page.HasMore != false || len(page.Transfers) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	// total is absent when includeTotal was not requested
	if page.Total != nil {
		t.Errorf("total = %v, want nil (not requested)", page.Total)
	}
	tr := page.Transfers[0]
	if tr.ContractID != "CABC" || tr.Amount != "100" || tr.EventType != "transfer" {
		t.Errorf("unexpected transfer: %+v", tr)
	}
}

func TestIncomingWithTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("includeTotal") != "true" {
			t.Errorf("includeTotal not set")
		}
		w.Header().Set("content-type", "application/json")
		// Real API shape when includeTotal=true: total is present.
		_, _ = w.Write([]byte(`{"hasMore":false,"total":3,"limit":50,"offset":0,"nextCursor":null,"transfers":[]}`))
	}))
	defer srv.Close()

	c := transfers.New(wraith.New(srv.URL))
	page, err := c.Incoming(context.Background(), "GABC", &transfers.ListParams{IncludeTotal: true})
	if err != nil {
		t.Fatalf("Incoming: %v", err)
	}
	if page.Total == nil || *page.Total != 3 {
		t.Errorf("total = %v, want 3", page.Total)
	}
}

// TestByTxDecodesObject verifies that ByTx decodes the real API response shape:
// {"transfers":[...]}. The old test sent a bare array which the real server
// never returns.
func TestByTxDecodesObject(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transfers/tx/abc123" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		// Real API: object with a "transfers" key, not a bare array.
		_, _ = w.Write([]byte(`{"transfers":[{"id":1,"contractId":"CABC","eventType":"mint","fromAddress":null,"toAddress":"GABC","amount":"5","displayAmount":"0.0000005","ledger":1,"ledgerClosedAt":"2026-01-01T00:00:00Z","txHash":"abc123","eventId":"e1"}]}`))
	}))
	defer srv.Close()

	c := transfers.New(wraith.New(srv.URL))
	list, err := c.ByTx(context.Background(), "abc123")
	if err != nil {
		t.Fatalf("ByTx: %v", err)
	}
	if len(list) != 1 || list[0].EventType != "mint" {
		t.Errorf("unexpected list: %+v", list)
	}
}

func TestOutgoingAndForAddress(t *testing.T) {
	cases := []struct {
		name     string
		wantPath string
		call     func(c *transfers.Client) (*transfers.Page, error)
	}{
		{
			name:     "outgoing",
			wantPath: "/transfers/outgoing/GABC",
			call: func(c *transfers.Client) (*transfers.Page, error) {
				return c.Outgoing(context.Background(), "GABC", nil)
			},
		},
		{
			name:     "forAddress",
			wantPath: "/transfers/address/GABC",
			call: func(c *transfers.Client) (*transfers.Page, error) {
				return c.ForAddress(context.Background(), "GABC", &transfers.ListParams{EventType: []string{"transfer", "mint"}})
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.wantPath {
					t.Errorf("path = %q, want %q", r.URL.Path, tc.wantPath)
				}
				w.Header().Set("content-type", "application/json")
				// Real API shape: hasMore is always present, total is absent.
				_, _ = w.Write([]byte(`{"hasMore":false,"limit":50,"offset":0,"nextCursor":null,"transfers":[]}`))
			}))
			defer srv.Close()

			c := transfers.New(wraith.New(srv.URL))
			page, err := tc.call(c)
			if err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			if page.Limit != 50 {
				t.Errorf("limit = %d, want 50", page.Limit)
			}
		})
	}
}

func TestListParamsRepeatedEventType(t *testing.T) {
	p := &transfers.ListParams{EventType: []string{"transfer", "mint"}}
	got := p.Query()["eventType"]
	if len(got) != 2 || got[0] != "transfer" || got[1] != "mint" {
		t.Errorf("eventType = %v, want [transfer mint]", got)
	}
}

func TestListParamsNilProducesEmptyQuery(t *testing.T) {
	var p *transfers.ListParams
	if got := p.Query().Encode(); got != "" {
		t.Errorf("nil params query = %q, want empty", got)
	}
}
