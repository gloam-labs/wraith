/**
 * Stable React Query key factory. Importing this lets callers invalidate or
 * prefetch the same keys the hooks use, e.g.
 * `queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all })`.
 */
export const queryKeys = {
  transfers: {
    all: ["wraith", "transfers"] as const,
    incoming: (address: string, query?: unknown) =>
      ["wraith", "transfers", "incoming", address, query] as const,
    outgoing: (address: string, query?: unknown) =>
      ["wraith", "transfers", "outgoing", address, query] as const,
    forAddress: (address: string, query?: unknown) =>
      ["wraith", "transfers", "address", address, query] as const,
    byTx: (txHash: string) =>
      ["wraith", "transfers", "tx", txHash] as const,
  },
  accounts: {
    all: ["wraith", "accounts"] as const,
    summary: (address: string) =>
      ["wraith", "accounts", "summary", address] as const,
    transfers: (address: string, query?: unknown) =>
      ["wraith", "accounts", "transfers", address, query] as const,
  },
  assets: {
    all: ["wraith", "assets"] as const,
    popular: (query?: unknown) =>
      ["wraith", "assets", "popular", query] as const,
  },
  nfts: {
    all: ["wraith", "nfts"] as const,
    transfers: (query?: unknown) =>
      ["wraith", "nfts", "transfers", query] as const,
  },
  webhooks: {
    all: ["wraith", "webhooks"] as const,
    list: () => ["wraith", "webhooks", "list"] as const,
    deliveries: (id: number, query?: unknown) =>
      ["wraith", "webhooks", "deliveries", id, query] as const,
  },
  hostFn: {
    all: ["wraith", "host-fn"] as const,
    logs: (contractId: string, query?: unknown) =>
      ["wraith", "host-fn", contractId, query] as const,
  },
  offramp: {
    all: ["wraith", "offramp"] as const,
    availability: () => ["wraith", "offramp", "availability"] as const,
    rate: (query?: unknown) =>
      ["wraith", "offramp", "rate", query] as const,
    trustline: (address: string) =>
      ["wraith", "offramp", "trustline", address] as const,
    // The order's access token is deliberately absent: a credential in a cache
    // key ends up in devtools, logs and persisted caches.
    order: (orderId: string) =>
      ["wraith", "offramp", "order", orderId] as const,
  },
  fees: {
    all: ["wraith", "fees"] as const,
    quote: (query?: unknown) => ["wraith", "fees", query] as const,
  },
  search: {
    all: ["wraith", "search"] as const,
    query: (q: string, query?: unknown) =>
      ["wraith", "search", q, query] as const,
  },
  candles: {
    all: ["wraith", "candles"] as const,
    list: (bucket: string, contractId: string, query?: unknown) =>
      ["wraith", "candles", bucket, contractId, query] as const,
  },
  ngn: {
    all: ["wraith", "ngn"] as const,
    customerStatus: (customerRef: string) =>
      ["wraith", "ngn", "customers", "status", customerRef] as const,
    dataBundles: (query?: unknown) =>
      ["wraith", "ngn", "bills", "data-bundles", query] as const,
  },
  status: () => ["wraith", "status"] as const,
} as const;
