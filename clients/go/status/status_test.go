package status_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/status"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestGet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/status" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		// Real /status response shape, including status, network, and networks.
		_, _ = w.Write([]byte(`{
			"ok": true,
			"status": "healthy",
			"network": "testnet",
			"lastIndexedLedger": 100,
			"latestLedger": 102,
			"lagLedgers": 2,
			"startedAt": "2025-01-01T00:00:00.000Z",
			"uptimeSeconds": 3600,
			"totalIndexed": 5000,
			"networks": {
				"testnet": {
					"lastIndexedLedger": 100,
					"latestLedger": 102,
					"lagLedgers": 2,
					"running": true
				}
			}
		}`))
	}))
	defer srv.Close()

	c := status.New(wraith.New(srv.URL))
	st, err := c.Get(context.Background())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !st.OK {
		t.Errorf("OK = false, want true")
	}
	if st.Status != "healthy" {
		t.Errorf("Status = %q, want healthy", st.Status)
	}
	if st.Network != "testnet" {
		t.Errorf("Network = %q, want testnet", st.Network)
	}
	if st.LagLedgers == nil || *st.LagLedgers != 2 {
		t.Errorf("LagLedgers = %v, want 2", st.LagLedgers)
	}
	if st.TotalIndexed != 5000 {
		t.Errorf("TotalIndexed = %d, want 5000", st.TotalIndexed)
	}
	if len(st.Networks) != 1 {
		t.Errorf("Networks len = %d, want 1", len(st.Networks))
	}
	tn, ok := st.Networks["testnet"]
	if !ok {
		t.Fatal("Networks[testnet] missing")
	}
	if !tn.Running {
		t.Errorf("Networks[testnet].Running = false, want true")
	}
}
