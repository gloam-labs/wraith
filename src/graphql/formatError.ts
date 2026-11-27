import type { GraphQLFormattedError } from "graphql";

/**
 * Mask genuinely unexpected failures at /graphql (#404, review follow-up).
 *
 * Apollo Server does not mask execution errors on its own: a resolver whose
 * database call blows up would otherwise hand the client the raw message —
 * connection strings, hostnames, whatever the driver included. The only
 * errors Apollo itself masks are the ones thrown before execution (the old
 * requestDidStart refusals took that path), which is why moving the plugins'
 * refusals to didResolveOperation was not, by itself, enough to preserve
 * masking for everything else.
 *
 * Every error reaches this formatter after Apollo has enriched it with an
 * extensions.code: an error that arrives with no code of its own is stamped
 * INTERNAL_SERVER_ERROR. Those are the unplanned server faults, and they are
 * the ones masked here. An error carrying any other code is a deliberate,
 * client-facing answer and keeps its message:
 *
 * - the plugins' own refusals — PERSISTED_QUERY_REQUIRED,
 *   PERSISTED_QUERY_NOT_FOUND, QUERY_TOO_DEEP, QUERY_TOO_COSTLY — which must
 *   stay readable (with their 400 status) so the caller can fix its request;
 * - GraphQL parse/validation errors (GRAPHQL_PARSE_FAILED,
 *   GRAPHQL_VALIDATION_FAILED, BAD_REQUEST, …);
 * - resolvers' deliberate BAD_USER_INPUT errors (invalid network, cursor or
 *   arguments in server.ts).
 *
 * Deliberate client errors must therefore always carry a code: a plain
 * `new Error(...)` thrown from a resolver is treated as a server fault and
 * masked, which is the safe default for anything nobody planned for.
 */
export function formatGraphQLError(
  formattedError: GraphQLFormattedError,
): GraphQLFormattedError {
  const code = formattedError.extensions?.code;
  if (typeof code === "string" && code !== "INTERNAL_SERVER_ERROR") {
    return formattedError;
  }

  return {
    message: "Internal server error",
    extensions: { code: "INTERNAL_SERVER_ERROR" },
  };
}
