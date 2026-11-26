import { describe, it, expect } from "vitest";
import { type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWraithClient,
  WraithClientProvider,
  WraithError,
  useCandles,
  useCreateOfframpOrder,
  useFees,
  useNgnCustomerStatus,
  useNgnDataBundles,
  useOfframpAvailability,
  useOfframpOrder,
  useOfframpRate,
  useOfframpTrustline,
  useSearch,
  useVerifyBank,
} from "../src";

const BASE = "https://wraith.test";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/**
 * Fetch stub for one request at a time. It records the URL, method, headers and
 * decoded body so the tests can assert on what actually went over the wire —
 * the bearer token in particular cannot be checked from the typed call alone.
 */
function stubFetch(body: unknown, status = 200): { fetch: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // openapi-fetch builds a `Request` and hands that to fetch, so the method
    // and body live on the request rather than on `init`.
    if (input instanceof Request) {
      const text = await input.clone().text();
      captured.push({
        url: input.url,
        method: input.method,
        headers: input.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }

    const url = typeof input === "string" ? input : input.toString();
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, captured };
}

function makeWrapper(fetchImpl: typeof fetch) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = createWraithClient({ baseUrl: BASE, fetch: fetchImpl });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <WraithClientProvider client={client}>{children}</WraithClientProvider>
      </QueryClientProvider>
    );
  };
}

describe("offramp hooks", () => {
  it("useOfframpOrder sends the order's bearer token", async () => {
    const body = {
      id: "ofr_abc",
      status: "pending",
      providerStatus: "processing",
      amountStableCoin: 50,
      amountNGN: 74000,
      depositAddress: "GDEPOSIT",
      rate: 1480,
      createdAt: "2026-01-01T00:00:00Z",
      source: "live",
    };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(
      () => useOfframpOrder("ofr_abc", "oft_secret-token"),
      { wrapper: makeWrapper(fetch) },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const request = captured[0];
    expect(new URL(request.url).pathname).toBe("/offramp/orders/ofr_abc");
    expect(request.headers.get("authorization")).toBe("Bearer oft_secret-token");
    expect(result.current.data?.status).toBe("pending");
  });

  it("useCreateOfframpOrder POSTs the order and returns the access token", async () => {
    const body = {
      id: "ofr_new",
      accessToken: "oft_new-token",
      walletAddress: "GDEPOSIT",
      chain: "stellar",
      coin: "usdc",
      amountStableCoin: 50,
      amountNGN: 74000,
      rate: 1480,
      status: "pending",
    };
    const { fetch, captured } = stubFetch(body, 201);
    const order = {
      amountNGN: 74000,
      bankAccount: "0123456789",
      bankCode: "044",
      bankName: "Example Bank",
      accountName: "Ada Example",
      walletAddress: "GUSER",
      idempotencyKey: "idem-1",
    };

    const { result } = renderHook(() => useCreateOfframpOrder(), {
      wrapper: makeWrapper(fetch),
    });

    let returned: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      returned = await result.current.mutateAsync(order);
    });

    expect(captured[0].method).toBe("POST");
    expect(new URL(captured[0].url).pathname).toBe("/offramp/orders");
    expect(captured[0].body).toEqual(order);
    // The token the create call mints is the one the read call needs.
    expect(returned?.accessToken).toBe("oft_new-token");
  });

  it("useCreateOfframpOrder surfaces a provider failure as a WraithError", async () => {
    const { fetch } = stubFetch({ error: "payout rejected", code: "payout_rejected" }, 502);
    const { result } = renderHook(() => useCreateOfframpOrder(), {
      wrapper: makeWrapper(fetch),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          amountStableCoin: 5,
          bankAccount: "0123456789",
          bankCode: "044",
          bankName: "Example Bank",
          accountName: "Ada Example",
          walletAddress: "GUSER",
          idempotencyKey: "idem-2",
        }),
      ).rejects.toBeInstanceOf(WraithError);
    });

    expect(result.current.error?.status).toBe(502);
  });

  it("useVerifyBank POSTs the account identifiers", async () => {
    const { fetch, captured } = stubFetch({ accountName: "Ada Example" });
    const request = { bankCode: "044", accountNumber: "0123456789" };
    const { result } = renderHook(() => useVerifyBank(), { wrapper: makeWrapper(fetch) });

    await act(async () => {
      await result.current.mutateAsync(request);
    });

    expect(captured[0].method).toBe("POST");
    expect(new URL(captured[0].url).pathname).toBe("/offramp/verify-bank");
    expect(captured[0].body).toEqual(request);
  });

  it("useOfframpAvailability reads the availability flag", async () => {
    const { fetch, captured } = stubFetch({ available: true });
    const { result } = renderHook(() => useOfframpAvailability(), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.available).toBe(true);
    expect(new URL(captured[0].url).pathname).toBe("/offramp/availability");
  });

  it("useOfframpRate sends the coin it is pricing", async () => {
    const { fetch, captured } = stubFetch({ coin: "xlm", rate: 410.5, indicative: true });
    const { result } = renderHook(() => useOfframpRate({ coin: "xlm" }), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.rate).toBe(410.5);
    expect(new URL(captured[0].url).searchParams.get("coin")).toBe("xlm");
  });

  it("useOfframpTrustline asks about the refund address", async () => {
    const { fetch, captured } = stubFetch({ valid: true, trustsUSDC: true });
    const { result } = renderHook(() => useOfframpTrustline("GPAYER"), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(new URL(captured[0].url).searchParams.get("address")).toBe("GPAYER");
  });
});

describe("fees, search and candles hooks", () => {
  it("useFees prices the amount being sent", async () => {
    const body = { enabled: true, fees: {} };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(() => useFees({ amount: "100" }), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(new URL(captured[0].url).pathname).toBe("/fees");
    expect(new URL(captured[0].url).searchParams.get("amount")).toBe("100");
  });

  it("useSearch always sends q", async () => {
    const body = { query: "abc", count: 0, results: [] };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(() => useSearch("abc", { network: "mainnet" }), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(captured[0].url);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("abc");
    expect(url.searchParams.get("network")).toBe("mainnet");
  });

  it("useCandles requests the bucket and contract with pagination", async () => {
    const body = {
      bucket: "1h",
      contractId: "CTOKEN",
      candles: [
        {
          timeBucket: "2026-01-01T00:00:00Z",
          contractId: "CTOKEN",
          open: "1",
          high: "2",
          low: "0.5",
          close: "1.5",
          volume: "10",
          txCount: 3,
        },
      ],
    };
    const { fetch, captured } = stubFetch(body);
    const { result } = renderHook(() => useCandles("1h", "CTOKEN", { limit: 10 }), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(captured[0].url);
    expect(url.pathname).toBe("/candles/1h/CTOKEN");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(result.current.data?.candles?.[0]?.close).toBe("1.5");
  });
});

describe("NGN read hooks", () => {
  it("useNgnCustomerStatus asks about one customer reference", async () => {
    const { fetch, captured } = stubFetch({ customerRef: "cust_1", verified: true });
    const { result } = renderHook(() => useNgnCustomerStatus("cust_1"), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(captured[0].url);
    expect(url.pathname).toBe("/ngn/customers/status");
    expect(url.searchParams.get("customerRef")).toBe("cust_1");
  });

  it("useNgnDataBundles filters by provider", async () => {
    const { fetch, captured } = stubFetch({ bundles: [] });
    const { result } = renderHook(() => useNgnDataBundles({ provider: "MTN" }), {
      wrapper: makeWrapper(fetch),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = new URL(captured[0].url);
    expect(url.pathname).toBe("/ngn/bills/data-bundles");
    expect(url.searchParams.get("provider")).toBe("MTN");
  });
});
