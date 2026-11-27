package accounts_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/accounts"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestBalance(t *testing.T) {
	const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
	const contract = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"
	const note = "Derived by summing indexed transfers, not read from chain. Excludes any history before the indexer's start ledger."
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/accounts/"+address+"/balance" || r.URL.RawQuery != "" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"address":"` + address + `","network":"testnet","balances":[{
			"contractId":"` + contract + `","balance":"-123456789012345678901234567890","displayBalance":"-12345678901234567890123.4567890"
		}],"derivedFromLedger":true,"note":"` + note + `"}`))
	}))
	defer srv.Close()

	result, err := accounts.New(wraith.New(srv.URL)).Balance(context.Background(), address)
	if err != nil {
		t.Fatalf("Balance: %v", err)
	}
	if result.Address != address || result.Network != "testnet" || !result.DerivedFromLedger || result.Note != note || len(result.Balances) != 1 {
		t.Fatalf("unexpected response: %+v", result)
	}
	want := accounts.TokenBalance{
		ContractID: contract, Balance: "-123456789012345678901234567890", DisplayBalance: "-12345678901234567890123.4567890",
	}
	if result.Balances[0] != want {
		t.Errorf("balance = %+v, want %+v", result.Balances[0], want)
	}
}
