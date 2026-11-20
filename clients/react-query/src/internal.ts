import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { WraithClient } from "./client";
import { useWraithClient } from "./context";
import { WraithError } from "./errors";
import type { paths } from "./schema";

/** The `200` `application/json` body returned by a GET on path `P`. */
export type GetResponse<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { "application/json": infer R } } } };
}
  ? R
  : never;

/** The query-string parameters accepted by a GET on path `P`. */
export type GetQuery<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } };
}
  ? Q
  : never;

/** The request body accepted by a POST on path `P`. */
export type PostBody<P extends keyof paths> = paths[P] extends {
  post: { requestBody: { content: { "application/json": infer B } } };
}
  ? B
  : never;

/**
 * The `application/json` body a POST on path `P` answers with.
 *
 * The created status is preferred because endpoints that both create and replay
 * (`POST /offramp/orders`) repeat the same shape under 200 and 201.
 */
export type PostResponse<P extends keyof paths> = paths[P] extends {
  post: { responses: { 201: { content: { "application/json": infer R } } } };
}
  ? R
  : paths[P] extends {
        post: { responses: { 200: { content: { "application/json": infer R } } } };
      }
    ? R
    : never;

/** Options forwarded to React Query, minus the bits the hooks own. */
export type WraithQueryOptions<TData> = Omit<
  UseQueryOptions<TData, WraithError, TData, QueryKey>,
  "queryKey" | "queryFn"
>;

/** Options forwarded to React Query's `useMutation`, minus the function. */
export type WraithMutationOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, WraithError, TVariables>,
  "mutationFn"
>;

interface FetchResult<TData> {
  data?: TData;
  error?: unknown;
  response: Response;
}

/**
 * Shared wrapper turning an openapi-fetch call into a typed `useQuery`. Non-2xx
 * responses (or transport errors surfaced by openapi-fetch) become a thrown
 * {@link WraithError} so React Query exposes them via `error`.
 */
export function useWraithQuery<TData>(
  queryKey: QueryKey,
  fetcher: (client: WraithClient) => Promise<FetchResult<TData>>,
  options?: WraithQueryOptions<TData>,
): UseQueryResult<TData, WraithError> {
  const client = useWraithClient();
  return useQuery<TData, WraithError>({
    queryKey,
    queryFn: async () => {
      const { data, error, response } = await fetcher(client);
      if (!response.ok || error !== undefined) {
        throw new WraithError(response.status, error ?? data);
      }
      return data as TData;
    },
    ...options,
  });
}

/**
 * Shared wrapper turning an openapi-fetch call into a typed `useMutation`.
 *
 * The offramp's write calls (`POST /offramp/orders`, `/offramp/verify-bank`)
 * are mutations, not queries: they move money and must not be retried by React
 * Query's query cache. Non-2xx responses become a thrown {@link WraithError},
 * exactly as in {@link useWraithQuery}.
 */
export function useWraithMutation<TData, TVariables>(
  mutationFn: (client: WraithClient, variables: TVariables) => Promise<FetchResult<TData>>,
  options?: WraithMutationOptions<TData, TVariables>,
): UseMutationResult<TData, WraithError, TVariables> {
  const client = useWraithClient();
  return useMutation<TData, WraithError, TVariables>({
    mutationFn: async (variables) => {
      const { data, error, response } = await mutationFn(client, variables);
      if (!response.ok || error !== undefined) {
        throw new WraithError(response.status, error ?? data);
      }
      return data as TData;
    },
    ...options,
  });
}
