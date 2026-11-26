/**
 * Types for the legacy OHLC candles route.
 *
 * `GET /candles/{bucket}/{contractId}` is mounted only on single-network
 * deployments with OHLC enabled (`src/ohlcConfig.ts` in the API), and the
 * OpenAPI generator registers the path under the same condition. That means it
 * is absent from `openapi.json` in most builds, so it cannot come from the
 * generated `paths` — this is the one shape the client declares by hand, and it
 * mirrors `src/api/candles.ts`.
 *
 * It is kept separate from `schema.d.ts` deliberately: the generated file must
 * stay byte-identical to `openapi-typescript`'s output or CI fails.
 *
 * The values are decimal strings, not numbers: prices and volumes are i128
 * amounts and would lose precision as a JS number.
 */
export type CandleBucket = "1m" | "1h" | "1d";

/** One OHLC bucket for a token contract. */
export interface Candle {
  timeBucket: string;
  contractId: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  txCount: number;
}

/** Body of `GET /candles/{bucket}/{contractId}`. */
export interface CandlesResponse {
  bucket: CandleBucket;
  contractId: string;
  candles: Candle[];
}

/**
 * The candles path, in the same shape `openapi-typescript` produces, so
 * {@link WraithClient} can be typed with `paths & CandlesPaths`.
 */
export interface CandlesPaths {
  "/candles/{bucket}/{contractId}": {
    get: {
      parameters: {
        query?: { limit?: number; offset?: number };
        header?: never;
        path: { bucket: CandleBucket; contractId: string };
        cookie?: never;
      };
      requestBody?: never;
      responses: {
        200: {
          headers: { [name: string]: unknown };
          content: { "application/json": CandlesResponse };
        };
      };
    };
  };
}
