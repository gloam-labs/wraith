import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/**
 * What the wallet should charge on a send, and where to pay it (`GET /fees`).
 *
 * Pass the amount being sent, in whole units, and the server prices the
 * percentage fee for it; without one every fee is the floor. Served
 * `no-store` by the API, so React Query's `staleTime` is left to the caller.
 */
export function useFees(
  query?: GetQuery<"/fees">,
  options?: WraithQueryOptions<GetResponse<"/fees">>,
) {
  return useWraithQuery<GetResponse<"/fees">>(
    queryKeys.fees.quote(query),
    (client) => client.GET("/fees", { params: { query } }),
    options,
  );
}
