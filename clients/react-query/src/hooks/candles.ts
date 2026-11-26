import type { CandleBucket, CandlesResponse } from "../candles";
import { queryKeys } from "../queryKeys";
import { useWraithQuery, type WraithQueryOptions } from "../internal";

/** Query parameters accepted by `GET /candles/{bucket}/{contractId}`. */
export interface CandlesQuery {
  limit?: number;
  offset?: number;
}

/**
 * OHLC candles for a token contract (`GET /candles/{bucket}/{contractId}`).
 *
 * The route exists only on single-network deployments with OHLC enabled, which
 * is also why it is not in `openapi.json` — see {@link CandlesResponse}.
 */
export function useCandles(
  bucket: CandleBucket,
  contractId: string,
  query?: CandlesQuery,
  options?: WraithQueryOptions<CandlesResponse>,
) {
  return useWraithQuery<CandlesResponse>(
    queryKeys.candles.list(bucket, contractId, query),
    (client) =>
      client.GET("/candles/{bucket}/{contractId}", {
        params: { path: { bucket, contractId }, query },
      }),
    options,
  );
}
