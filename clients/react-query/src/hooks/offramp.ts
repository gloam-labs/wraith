import { queryKeys } from "../queryKeys";
import {
  useWraithMutation,
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type PostBody,
  type PostResponse,
  type WraithMutationOptions,
  type WraithQueryOptions,
} from "../internal";

/**
 * The naira cash-out rail.
 *
 * These routes move real money through the provider, so two rules apply to the
 * hooks that call them:
 *
 *  - Creating an order is a **mutation**, never a query. A retried create is a
 *    second payout request; the caller's `idempotencyKey` is what makes a retry
 *    safe, and React Query must not invent one.
 *  - Reading an order back needs the bearer token the create call returned.
 *    `useOfframpOrder` takes it explicitly and sends it as
 *    `Authorization: Bearer …`; the API answers 401 without it. The token is
 *    kept out of the React Query key so it never lands in devtools or a
 *    persisted cache.
 */

/** Is cash-out switched on in this deployment? (`GET /offramp/availability`) */
export function useOfframpAvailability(
  options?: WraithQueryOptions<GetResponse<"/offramp/availability">>,
) {
  return useWraithQuery<GetResponse<"/offramp/availability">>(
    queryKeys.offramp.availability(),
    (client) => client.GET("/offramp/availability"),
    options,
  );
}

/** Indicative naira-per-coin rate (`GET /offramp/rate`). */
export function useOfframpRate(
  query?: GetQuery<"/offramp/rate">,
  options?: WraithQueryOptions<GetResponse<"/offramp/rate">>,
) {
  return useWraithQuery<GetResponse<"/offramp/rate">>(
    queryKeys.offramp.rate(query),
    (client) => client.GET("/offramp/rate", { params: { query } }),
    options,
  );
}

/** Does a classic account hold the USDC trustline a refund needs? */
export function useOfframpTrustline(
  address: string,
  options?: WraithQueryOptions<GetResponse<"/offramp/trustline">>,
) {
  return useWraithQuery<GetResponse<"/offramp/trustline">>(
    queryKeys.offramp.trustline(address),
    (client) =>
      client.GET("/offramp/trustline", { params: { query: { address } } }),
    options,
  );
}

/** Resolve a bank account to the name the payout will be addressed to. */
export function useVerifyBank(
  options?: WraithMutationOptions<
    PostResponse<"/offramp/verify-bank">,
    PostBody<"/offramp/verify-bank">
  >,
) {
  return useWraithMutation<
    PostResponse<"/offramp/verify-bank">,
    PostBody<"/offramp/verify-bank">
  >((client, body) => client.POST("/offramp/verify-bank", { body }), options);
}

/**
 * Create a cash-out order (`POST /offramp/orders`).
 *
 * The response carries `accessToken` — the only time it is ever returned. Keep
 * it and pass it to {@link useOfframpOrder}; the API does not store a copy that
 * can be handed out again.
 */
export function useCreateOfframpOrder(
  options?: WraithMutationOptions<
    PostResponse<"/offramp/orders">,
    PostBody<"/offramp/orders">
  >,
) {
  return useWraithMutation<
    PostResponse<"/offramp/orders">,
    PostBody<"/offramp/orders">
  >((client, body) => client.POST("/offramp/orders", { body }), options);
}

/**
 * Read back an order this client created (`GET /offramp/orders/{orderId}`).
 *
 * `accessToken` is the bearer token from the create response. Both identifiers
 * belong to the same order and the API will refuse a token minted for another.
 */
export function useOfframpOrder(
  orderId: string,
  accessToken: string,
  options?: WraithQueryOptions<GetResponse<"/offramp/orders/{orderId}">>,
) {
  return useWraithQuery<GetResponse<"/offramp/orders/{orderId}">>(
    queryKeys.offramp.order(orderId),
    (client) =>
      client.GET("/offramp/orders/{orderId}", {
        params: { path: { orderId } },
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    options,
  );
}
