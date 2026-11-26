import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/**
 * The naira rails' read routes that are in the published spec.
 *
 * Deliberately **not** wrapped here: the order-status routes
 * (`/ngn/onramp/status`, `/ngn/bills/status`, …). They require **both**
 * `customerRef` and `orderId`, which is an access-control property rather than
 * an inconvenience — a wallet address is semi-public, and a single-identifier
 * lookup would turn it into a way to read a stranger's order. There is no
 * convenience overload in this client for exactly that reason, and their types
 * are still missing from `openapi.json` (#291).
 */

/**
 * Is this customer reference verified? (`GET /ngn/customers/status`)
 *
 * Read-only: asking does not create a customer. This is not an order lookup,
 * so `customerRef` alone is the correct identifier.
 */
export function useNgnCustomerStatus(
  customerRef: string,
  options?: WraithQueryOptions<GetResponse<"/ngn/customers/status">>,
) {
  return useWraithQuery<GetResponse<"/ngn/customers/status">>(
    queryKeys.ngn.customerStatus(customerRef),
    (client) =>
      client.GET("/ngn/customers/status", { params: { query: { customerRef } } }),
    options,
  );
}

/** The data bundles a `data` bill can buy (`GET /ngn/bills/data-bundles`). */
export function useNgnDataBundles(
  query?: GetQuery<"/ngn/bills/data-bundles">,
  options?: WraithQueryOptions<GetResponse<"/ngn/bills/data-bundles">>,
) {
  return useWraithQuery<GetResponse<"/ngn/bills/data-bundles">>(
    queryKeys.ngn.dataBundles(query),
    (client) => client.GET("/ngn/bills/data-bundles", { params: { query } }),
    options,
  );
}
