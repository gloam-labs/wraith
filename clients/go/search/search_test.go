package search_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/search"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestSearch(t *testing.T) {
	const account = "GDWCO35QUYQLGO6P7OLW4BZWNMMGGUWNPLRVPLCBVG7YNVDZKUDIW4KN"
	const asset = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF"
	const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
	mainnet := "mainnet"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/search" {
			t.Errorf("request = %s %s, want GET /search", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.RawQuery {
		case "q=G":
			_, _ = w.Write([]byte(`{"query":"G","count":1,"results":[{"type":"account","value":"` + account + `","lastActivityAt":"2026-01-01T00:00:00.000Z"}]}`))
		case "network=mainnet&q=C":
			_, _ = w.Write([]byte(`{"query":"C","count":2,"results":[
				{"type":"asset","value":"` + asset + `","isSac":false},
				{"type":"contract","value":"` + contract + `"}
			]}`))
		default:
			t.Errorf("query = %q", r.URL.RawQuery)
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	c := search.New(wraith.New(srv.URL))
	t.Run("account with default network", func(t *testing.T) {
		result, err := c.Search(context.Background(), "G", nil)
		if err != nil {
			t.Fatalf("Search: %v", err)
		}
		if result.Query != "G" || result.Count != 1 || len(result.Results) != 1 {
			t.Fatalf("unexpected response: %+v", result)
		}
		hit := result.Results[0]
		if hit.Type != "account" || hit.Value != account || hit.IsSAC != nil ||
			hit.LastActivityAt == nil || *hit.LastActivityAt != "2026-01-01T00:00:00.000Z" {
			t.Errorf("unexpected account: %+v", hit)
		}
	})
	t.Run("asset and contract on selected network", func(t *testing.T) {
		result, err := c.Search(context.Background(), "C", &search.SearchParams{Network: &mainnet})
		if err != nil {
			t.Fatalf("Search: %v", err)
		}
		if result.Query != "C" || result.Count != 2 || len(result.Results) != 2 {
			t.Fatalf("unexpected response: %+v", result)
		}
		first, second := result.Results[0], result.Results[1]
		if first.Type != "asset" || first.Value != asset || first.IsSAC == nil || *first.IsSAC || first.LastActivityAt != nil {
			t.Errorf("unexpected asset: %+v", first)
		}
		if second.Type != "contract" || second.Value != contract || second.IsSAC != nil || second.LastActivityAt != nil {
			t.Errorf("unexpected contract: %+v", second)
		}
	})
}
