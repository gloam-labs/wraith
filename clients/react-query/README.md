# @wraith/react-query

Typed [React Query](https://tanstack.com/query) hooks for the
[Wraith](https://github.com/Miracle656/wraith) Soroban token-transfer indexer.

The request/response types are **generated from `openapi.json`** with
[`openapi-typescript`](https://openapi-ts.dev/), and the network layer is
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) — so the hooks are
fully typed end to end with no hand-maintained models. Regenerate any time the
API changes (see [Regenerating](#regenerating)).

## Install

```bash
npm install @wraith/react-query @tanstack/react-query
```

`@tanstack/react-query` and `react` are peer dependencies.

## Usage

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createWraithClient,
  WraithClientProvider,
  useIncomingTransfers,
  usePopularAssets,
} from "@wraith/react-query";

const queryClient = new QueryClient();
const wraith = createWraithClient({ baseUrl: "https://wraith.example.com" });

function App({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WraithClientProvider client={wraith}>{children}</WraithClientProvider>
    </QueryClientProvider>
  );
}

function Transfers({ address }: { address: string }) {
  const { data, isLoading, error } = useIncomingTransfers(address, { limit: 100 });
  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>; // error is a typed WraithError
  return (
    <ul>
      {data?.transfers?.map((t) => (
        <li key={t.eventId}>
          {t.contractId} {t.displayAmount ?? t.amount}
        </li>
      ))}
    </ul>
  );
}
```

## Hooks

Every list endpoint of the API has a hook:

| Resource  | Hook                                                                            | Endpoint                          |
| --------- | ------------------------------------------------------------------------------ | --------------------------------- |
| Transfers | `useIncomingTransfers`                                                          | `GET /transfers/incoming/{address}` |
| Transfers | `useOutgoingTransfers`                                                          | `GET /transfers/outgoing/{address}` |
| Transfers | `useAddressTransfers`                                                           | `GET /transfers/address/{address}`  |
| Transfers | `useTransactionTransfers`                                                       | `GET /transfers/tx/{txHash}`        |
| Accounts  | `useAccountSummary`                                                             | `GET /accounts/{address}/summary`   |
| Accounts  | `useAccountTransfers`                                                           | `GET /accounts/{address}/transfers` |
| Assets    | `usePopularAssets`                                                              | `GET /assets/popular`               |
| NFTs      | `useNftTransfers`                                                               | `GET /nfts/transfers`               |
| Webhooks  | `useWebhooks`                                                                   | `GET /webhooks`                     |
| Webhooks  | `useWebhookDeliveries`                                                          | `GET /webhooks/{id}/deliveries`     |
| Host fns  | `useHostFunctionLogs`                                                           | `GET /host-fn/{contractId}`         |
| Status    | `useStatus`                                                                     | `GET /status`                       |
| Offramp   | `useOfframpAvailability`                                                        | `GET /offramp/availability`         |
| Offramp   | `useOfframpRate`                                                                | `GET /offramp/rate`                 |
| Offramp   | `useOfframpTrustline`                                                           | `GET /offramp/trustline`            |
| Offramp   | `useVerifyBank` (mutation)                                                      | `POST /offramp/verify-bank`         |
| Offramp   | `useCreateOfframpOrder` (mutation)                                              | `POST /offramp/orders`              |
| Offramp   | `useOfframpOrder`                                                               | `GET /offramp/orders/{orderId}`     |
| Fees      | `useFees`                                                                       | `GET /fees`                         |
| Search    | `useSearch`                                                                     | `GET /search`                       |
| Candles   | `useCandles`                                                                    | `GET /candles/{bucket}/{contractId}` |
| NGN       | `useNgnCustomerStatus`                                                          | `GET /ngn/customers/status`         |
| NGN       | `useNgnDataBundles`                                                             | `GET /ngn/bills/data-bundles`       |

Each hook takes its path params, an optional typed `query` object, and an
optional React Query `options` object. Non-2xx responses reject with a
`WraithError` (`.status`, `.body`). Use the exported `queryKeys` factory to
invalidate or prefetch:

```ts
queryClient.invalidateQueries({ queryKey: queryKeys.transfers.all });
```

## Cash-out (offramp), and its bearer token

Creating an order is a **mutation**, never a query — a retried create is a
second payout request. The response carries `accessToken`, returned only once
(a replay issues a fresh one and retires the old). Reading the order back needs
it:

```tsx
const create = useCreateOfframpOrder();
const { id, accessToken } = await create.mutateAsync({
  amountNGN: 74_000,
  bankAccount: "0123456789",
  bankCode: "044",
  bankName: "Example Bank",
  accountName: "Ada Example",
  walletAddress: "GUSER…",
  idempotencyKey: "a-key-you-keep-for-retries",
});

const order = useOfframpOrder(id, accessToken);
```

`useOfframpOrder` sends the token as `Authorization: Bearer …`; the API answers
401 without it. The token is deliberately not part of the React Query key, so
it does not end up in devtools or a persisted cache.

## Coverage, and what is deliberately missing

This is the client that covers the money rails. It was chosen because it is
built from the **generated** `openapi.json` types and CI already fails if
`schema.d.ts` drifts, so its request and response shapes cannot quietly diverge
from the server. The Go and Python clients still stop at transfers, assets,
NFTs, status and webhooks.

Covered here: every offramp route, both fee endpoints' `GET /fees`,
`GET /search`, `GET /candles/{bucket}/{contractId}`, and the two NGN reads that
appear in `openapi.json`.

Not covered, on purpose:

- **NGN order-status reads** (`/ngn/onramp/status`, `/ngn/bills/status`, …).
  They require **both** `customerRef` and `orderId`, which is access control,
  not an inconvenience: a wallet address is semi-public, and a
  single-identifier lookup would let it read a stranger's order. No
  convenience overload is offered, and their types are still missing from the
  spec (#291).
- **The seven NGN routes absent from `openapi.json`** (#291). Hand-writing
  their types would diverge the moment the spec is fixed.
- **`/candles` is not in `openapi.json`** (the API registers it only on
  OHLC-enabled, single-network deployments), so its two types live in
  `src/candles.ts`, mirroring `src/api/candles.ts`, rather than in the
  generated file.
- **Operator routes** (`/metrics`, `/ops/failures`, `/fees/report`) and the
  webhook/Discord callbacks are not wrapped: they are not called by a browser
  client.

## Regenerating

The committed `src/schema.d.ts` is generated from the repo's `openapi.json`:

```bash
npm run generate   # openapi-typescript ../../openapi.json -o src/schema.d.ts
```

CI runs this and fails if the committed schema is stale (see
`.github/workflows/react-query-sdk.yml`), so the client never drifts from the
spec.

## Development

```bash
npm install
npm run generate
npm run typecheck
npm test
```
