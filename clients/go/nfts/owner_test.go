package nfts_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/nfts"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestOwner(t *testing.T) {
	const contract = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
	const address = "GCXOO7OIJZ2HEOZODLOEISNVO6CBPK4PISRJCZYRFT37H7XGHDLB3C7O"
	const missing = "Token not found. No transfers indexed for this contract/token_id."
	const path = "/nfts/owners/" + contract + "/"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.RawQuery != "" {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.EscapedPath() {
		case path + "collection%2F42":
			_, _ = w.Write([]byte(`{"contract":"` + contract + `","token_id":"collection/42","owner":"` + address + `","metadata":{"name":null,"tokenUri":"https://example.com/nft/42"}}`))
		case path + "43":
			_, _ = w.Write([]byte(`{"contract":"` + contract + `","token_id":"43","owner":"` + address + `","metadata":null}`))
		case path + "44":
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"` + missing + `"}`))
		default:
			t.Errorf("path = %q", r.URL.EscapedPath())
			w.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer srv.Close()

	c := nfts.New(wraith.New(srv.URL))
	result, err := c.Owner(context.Background(), contract, "collection/42")
	if err != nil {
		t.Fatalf("Owner: %v", err)
	}
	if result.Contract != contract || result.TokenID != "collection/42" || result.Owner != address || result.Metadata == nil {
		t.Fatalf("unexpected response: %+v", result)
	}
	if result.Metadata.Name != nil || result.Metadata.TokenURI == nil || *result.Metadata.TokenURI != "https://example.com/nft/42" {
		t.Errorf("unexpected metadata: %+v", result.Metadata)
	}

	result, err = c.Owner(context.Background(), contract, "43")
	if err != nil {
		t.Fatalf("Owner without metadata: %v", err)
	}
	if result.Owner != address || result.TokenID != "43" || result.Metadata != nil {
		t.Errorf("unexpected response without metadata: %+v", result)
	}

	result, err = c.Owner(context.Background(), contract, "44")
	var apiErr *wraith.APIError
	if result != nil || !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusNotFound || apiErr.Message != missing {
		t.Errorf("Owner missing token = %+v, %v, want 404 APIError", result, err)
	}
}
