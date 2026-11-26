package hostfn_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/hostfn"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestLogs(t *testing.T) {
	const contract = "CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN"
	const txHash = "b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5"
	const gasUsed = "9007199254740993"
	const closedAt = "2024-06-01T12:00:00.000Z"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/host-fn/"+contract {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.RawQuery {
		case "":
			_, _ = w.Write([]byte(`{"contractId":"` + contract + `","total":0,"limit":50,"offset":0,"logs":[]}`))
		case "functionName=swap&limit=10&network=mainnet&offset=0":
			_, _ = w.Write([]byte(`{"contractId":"` + contract + `","total":2,"limit":10,"offset":0,"logs":[
				{"contractId":"` + contract + `","functionName":"swap","args":["100"],"result":{"amount":"99"},
				 "gasUsed":"` + gasUsed + `","ledger":9999001,"ledgerClosedAt":"` + closedAt + `","txHash":"` + txHash + `","eventId":"e2e-0000000009999001000-0000000001"},
				{"contractId":"` + contract + `","functionName":"swap","args":[],"result":null,
				 "gasUsed":null,"ledger":9999001,"ledgerClosedAt":"` + closedAt + `","txHash":"` + txHash + `","eventId":"e2e-0000000009999001000-0000000000"}
			]}`))
		default:
			t.Errorf("query = %q", r.URL.RawQuery)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	c := hostfn.New(wraith.New(srv.URL))
	page, err := c.Logs(context.Background(), contract, nil)
	if err != nil {
		t.Fatalf("Logs with nil params: %v", err)
	}
	if page.ContractID != contract || page.Total != 0 || page.Limit != 50 || page.Offset != 0 || page.Logs == nil || len(page.Logs) != 0 {
		t.Errorf("unexpected default page: %+v", page)
	}

	network, function := "mainnet", "swap"
	page, err = c.Logs(context.Background(), contract, &hostfn.LogsParams{
		Network: &network, FunctionName: &function, Limit: wraith.IntPtr(10), Offset: wraith.IntPtr(0),
	})
	if err != nil {
		t.Fatalf("Logs with filters: %v", err)
	}
	if page.ContractID != contract || page.Total != 2 || page.Limit != 10 || page.Offset != 0 || len(page.Logs) != 2 {
		t.Fatalf("unexpected filtered page: %+v", page)
	}
	first, second := page.Logs[0], page.Logs[1]
	if first.ContractID != contract || first.FunctionName != "swap" || first.Ledger != 9999001 ||
		first.LedgerClosedAt != closedAt || first.TxHash != txHash || first.EventID != "e2e-0000000009999001000-0000000001" {
		t.Errorf("unexpected log: %+v", first)
	}
	if first.GasUsed == nil || *first.GasUsed != gasUsed || string(first.Args) != `["100"]` || string(first.Result) != `{"amount":"99"}` {
		t.Errorf("unexpected log values: %+v", first)
	}
	if second.GasUsed != nil || string(second.Result) != "null" {
		t.Errorf("expected null gasUsed and result: %+v", second)
	}
}
