import { queryKeys } from "../queryKeys";
import {
  useWraithQuery,
  type GetQuery,
  type GetResponse,
  type WraithQueryOptions,
} from "../internal";

/**
 * Fuzzy search across accounts, assets and contracts (`GET /search`).
 *
 * `q` is required by the API and is separate from the optional parameters
 * (`network`), so it cannot be accidentally omitted: a search with no term is
 * a 400, not an empty list.
 */
export function useSearch(
  q: string,
  query?: Omit<GetQuery<"/search">, "q">,
  options?: WraithQueryOptions<GetResponse<"/search">>,
) {
  return useWraithQuery<GetResponse<"/search">>(
    queryKeys.search.query(q, query),
    (client) => client.GET("/search", { params: { query: { ...query, q } } }),
    options,
  );
}
