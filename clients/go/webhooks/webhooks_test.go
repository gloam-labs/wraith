package webhooks_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Miracle656/wraith/clients/go/webhooks"
	"github.com/Miracle656/wraith/clients/go/wraith"
)

func TestList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/webhooks" {
			t.Errorf("path = %q", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		// Real API shape: filter is null when not set.
		_, _ = w.Write([]byte(`{"subscriptions":[{"id":1,"url":"https://h","filter":null,"active":true,"createdAt":"t","updatedAt":"t"}]}`))
	}))
	defer srv.Close()

	c := webhooks.New(wraith.New(srv.URL))
	list, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Subscriptions) != 1 || list.Subscriptions[0].ID != 1 || !list.Subscriptions[0].Active {
		t.Errorf("unexpected list: %+v", list)
	}
	if list.Subscriptions[0].Filter != nil {
		t.Errorf("filter = %v, want nil", list.Subscriptions[0].Filter)
	}
}

// TestListWithFilter verifies that a subscription whose filter field is an
// object (not null) decodes into a *WebhookFilter correctly. The old *string
// type could not decode this and returned an error on every real server.
func TestListWithFilter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		// Real API: filter is an object with contract/from/to/min_amount fields.
		_, _ = w.Write([]byte(`{"subscriptions":[
			{"id":2,"url":"https://h","filter":{"contract":"CABC","min_amount":"1000000"},"active":true,"createdAt":"t","updatedAt":"t"}
		]}`))
	}))
	defer srv.Close()

	c := webhooks.New(wraith.New(srv.URL))
	list, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list.Subscriptions) != 1 {
		t.Fatalf("want 1 subscription, got %d", len(list.Subscriptions))
	}
	f := list.Subscriptions[0].Filter
	if f == nil {
		t.Fatal("filter = nil, want object")
	}
	if f.Contract == nil || *f.Contract != "CABC" {
		t.Errorf("filter.contract = %v, want CABC", f.Contract)
	}
	if f.MinAmount == nil || *f.MinAmount != "1000000" {
		t.Errorf("filter.min_amount = %v, want 1000000", f.MinAmount)
	}
	if f.From != nil || f.To != nil {
		t.Errorf("unexpected filter fields set: from=%v to=%v", f.From, f.To)
	}
}

func TestDeliveries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/webhooks/7/deliveries" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.URL.Query().Get("status") != "failed" {
			t.Errorf("status = %q, want failed", r.URL.Query().Get("status"))
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"total":1,"limit":50,"offset":0,
			"deliveries":[{"id":9,"eventId":"e","status":"failed","attempts":3,
			"lastStatusCode":500,"lastError":"boom","nextRetryAt":null,"deliveredAt":null,"createdAt":"t"}]}`))
	}))
	defer srv.Close()

	c := webhooks.New(wraith.New(srv.URL))
	list, err := c.Deliveries(context.Background(), 7, &webhooks.DeliveriesParams{Status: "failed"})
	if err != nil {
		t.Fatalf("Deliveries: %v", err)
	}
	if len(list.Deliveries) != 1 || list.Deliveries[0].Status != "failed" || list.Deliveries[0].Attempts != 3 {
		t.Fatalf("unexpected deliveries: %+v", list)
	}
	if list.Deliveries[0].LastStatusCode == nil || *list.Deliveries[0].LastStatusCode != 500 {
		t.Errorf("lastStatusCode = %v, want 500", list.Deliveries[0].LastStatusCode)
	}
}
