package tokens_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/tokens"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestList(t *testing.T) {
	const contract = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"
	mainnet, empty := "mainnet", ""
	cases := []struct {
		name    string
		params  *tokens.ListParams
		query   string
		network string
	}{
		{name: "default network", network: "testnet"},
		{name: "empty network filter", params: &tokens.ListParams{Network: &empty}, network: "testnet"},
		{name: "selected network", params: &tokens.ListParams{Network: &mainnet}, query: "network=mainnet", network: mainnet},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/tokens" || r.URL.RawQuery != tc.query {
					t.Errorf("request = %s %s, want GET /tokens with query %q", r.Method, r.URL, tc.query)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true,"network":"` + tc.network + `","tokens":[{
					"network":"` + tc.network + `","contractId":"` + contract + `","symbol":"USDC","name":"USD Coin","decimals":7
				}]}`))
			}))
			defer srv.Close()

			result, err := tokens.New(wraith.New(srv.URL)).List(context.Background(), tc.params)
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if !result.OK || result.Network != tc.network || len(result.Tokens) != 1 {
				t.Fatalf("unexpected response: %+v", result)
			}
			want := tokens.Token{Network: tc.network, ContractID: contract, Symbol: "USDC", Name: "USD Coin", Decimals: 7}
			if result.Tokens[0] != want {
				t.Errorf("token = %+v, want %+v", result.Tokens[0], want)
			}
		})
	}
}
