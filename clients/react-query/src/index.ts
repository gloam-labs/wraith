export { createWraithClient } from "./client";
export type { WraithClient, WraithClientOptions } from "./client";
export {
  WraithClientProvider,
  useWraithClient,
} from "./context";
export type { WraithClientProviderProps } from "./context";
export { WraithError } from "./errors";
export { queryKeys } from "./queryKeys";
export type { GetQuery, GetResponse, WraithQueryOptions } from "./internal";

// Hooks — one module per resource.
export {
  useIncomingTransfers,
  useOutgoingTransfers,
  useAddressTransfers,
  useTransactionTransfers,
} from "./hooks/transfers";
export { useAccountSummary, useAccountTransfers } from "./hooks/accounts";
export { usePopularAssets } from "./hooks/assets";
export { useNftTransfers } from "./hooks/nfts";
export { useWebhooks, useWebhookDeliveries } from "./hooks/webhooks";
export { useHostFunctionLogs } from "./hooks/hostFn";
export { useStatus } from "./hooks/status";

// Money rails and the search/candles reads.
export {
  useOfframpAvailability,
  useOfframpRate,
  useOfframpTrustline,
  useVerifyBank,
  useCreateOfframpOrder,
  useOfframpOrder,
} from "./hooks/offramp";
export { useFees } from "./hooks/fees";
export { useSearch } from "./hooks/search";
export { useCandles } from "./hooks/candles";
export type { CandlesQuery } from "./hooks/candles";
export { useNgnCustomerStatus, useNgnDataBundles } from "./hooks/ngn";
export type {
  Candle,
  CandleBucket,
  CandlesPaths,
  CandlesResponse,
} from "./candles";

// The generated OpenAPI types, re-exported for advanced use.
export type { paths, components } from "./schema";
