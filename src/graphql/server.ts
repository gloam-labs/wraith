import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@as-integrations/express5";
import {
  queryAllTransfers,
  queryByTxHash,
  querySummary,
  queryTransfers,
} from "../db";
import { costLimitPlugin } from "./costLimit";
import { persistedQueryPlugin } from "./persisted";
import { requestNetwork } from "../middleware/network";
import { enabledNetworks, isNetwork, NETWORKS, currentNetwork, type Network } from "../network";
import { getCachedTokenDecimals } from "../tokenCache";
import { toDisplayAmount } from "../amount";
import { transferQuerySchema } from "../openapi/schemas";
import { decodeCursor } from "../lib/odata";

export const typeDefs = `#graphql
  enum Network {
    TESTNET
    MAINNET
  }

  enum TransferDirection {
    INCOMING
    OUTGOING
    ALL
  }

  type GraphQLHealth {
    ok: Boolean!
    version: String!
  }

  type Transfer {
    id: Int!
    contractId: String!
    eventType: String!
    fromAddress: String
    toAddress: String
    amount: String!
    displayAmount: String
    ledger: Int!
    ledgerClosedAt: String!
    txHash: String!
    eventId: String!
    direction: String
  }

  type TransferConnection {
    "Exact match count. Null unless the query passed includeTotal: true, because it costs a full COUNT."
    total: Int
    hasMore: Boolean!
    transfers: [Transfer!]!
    nextCursor: String
  }

  type TokenSummary {
    contractId: String!
    totalReceived: String!
    totalSent: String!
    netFlow: String!
    displayTotalReceived: String!
    displayTotalSent: String!
    displayNetFlow: String!
    txCount: Int!
  }

  type Query {
    health: GraphQLHealth!
    transfers(
      address: String!
      direction: TransferDirection = ALL
      contractId: String
      network: Network
      limit: Int = 50
      offset: Int = 0
      "Also compute the exact total. Slower on large result sets."
      includeTotal: Boolean = false
      "Opaque cursor from a previous page's nextCursor. Pass it back unchanged to continue; a malformed cursor is an error, not a silent first page."
      cursor: String
      "Inclusive lower bound on ledger."
      fromLedger: Int
      "Inclusive upper bound on ledger."
      toLedger: Int
      "Inclusive lower bound on ledgerClosedAt (ISO 8601 with offset, e.g. 2025-01-01T00:00:00Z)."
      fromDate: String
      "Inclusive upper bound on ledgerClosedAt (ISO 8601 with offset)."
      toDate: String
      "Only transfers whose eventType is one of these (transfer, mint, burn, clawback)."
      eventTypes: [String!]
      "Filter to a specific token contract, as contractId does."
      token: String
    ): TransferConnection!
    transferByTx(txHash: String!, network: Network): [Transfer!]!
    summary(address: String!, contractId: String, network: Network): [TokenSummary!]!
  }
`;

type TransferDirection = "INCOMING" | "OUTGOING" | "ALL";
type NetworkArg = "TESTNET" | "MAINNET";

/** What every resolver receives: the network the HTTP request selected (#163). */
export interface GraphQLContext {
  network: Network;
}

/**
 * Decide which network one field reads from.
 *
 * A field-level `network:` argument wins over the request-level selector, so a
 * single document can compare two chains in one round-trip. With neither, the
 * context's network applies — which is the `?network=` / `X-Network` value, and
 * failing that the process default.
 *
 * An argument naming a network this deployment does not serve throws rather
 * than returning nothing: an empty list would read as "no such transfers"
 * instead of "this process has never indexed that chain".
 */
function resolveArgNetwork(arg: NetworkArg | undefined, ctx: GraphQLContext | undefined): Network {
  if (arg === undefined) return ctx?.network ?? currentNetwork();

  const normalised = arg.toLowerCase();
  if (!isNetwork(normalised)) {
    throw new Error(`Invalid network: "${arg}". Valid values: ${NETWORKS.join(", ")}.`);
  }

  const enabled = enabledNetworks();
  if (!enabled.includes(normalised)) {
    throw new Error(
      `Network "${normalised}" is not enabled on this deployment. Enabled networks: ${enabled.join(", ")}.`
    );
  }

  return normalised;
}

export interface TransfersArgs {
  address: string;
  direction?: TransferDirection;
  contractId?: string | null;
  network?: NetworkArg;
  limit?: number | null;
  offset?: number | null;
  includeTotal?: boolean | null;
  cursor?: string | null;
  fromLedger?: number | null;
  toLedger?: number | null;
  fromDate?: string | null;
  toDate?: string | null;
  eventTypes?: string[] | null;
  token?: string | null;
}

/**
 * Validate `transfers` arguments the way the REST transfer routes do (#405):
 * the same zod schema (`transferQuerySchema`) enforces limit 1–200, ledger
 * bounds >= 0, ISO datetimes with an offset, and the event-type vocabulary.
 * GraphQL already types the values, so the schema is fed the decoded values
 * (eventTypes joined back into the comma-separated form REST parses).
 *
 * Two deliberate differences from REST:
 * - `token` is passed through unchecked, like `contractId` (which REST also
 *   leaves unchecked); REST's strict contract-address regex for `token` would
 *   reject the short fixture ids the data layer itself accepts.
 * - `eventTypes` are lower-cased before validation: GraphQL callers write
 *   enum-style `TRANSFER`, REST's vocabulary is lowercase `transfer`, and both
 *   mean the same filter. Anything outside the vocabulary still errors.
 *
 * A malformed `cursor` is an error, not a silent first page: the data layer's
 * `decodeCursor` swallows bad cursors so REST can fall back cleanly, but a
 * GraphQL client that hands back a `nextCursor` it was given has no fallback
 * to fall back to — silently restarting the list would loop forever.
 */
function parseTransfersArgs(args: TransfersArgs) {
  const eventTypes = args.eventTypes
    ?.map((eventType) => eventType.trim().toLowerCase())
    .filter(Boolean);
  const parsed = transferQuerySchema.safeParse({
    address: args.address,
    contractId: args.contractId ?? undefined,
    fromLedger: args.fromLedger ?? undefined,
    toLedger: args.toLedger ?? undefined,
    fromDate: args.fromDate ?? undefined,
    toDate: args.toDate ?? undefined,
    eventType: eventTypes?.length ? eventTypes.join(",") : undefined,
    limit: args.limit ?? undefined,
    offset: args.offset ?? undefined,
    cursor: args.cursor ?? undefined,
    includeTotal: args.includeTotal ?? undefined,
  });
  if (!parsed.success) {
    throw new Error(
      `Invalid transfers arguments: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  const cursor = parsed.data.cursor?.trim() || undefined;
  if (cursor !== undefined) {
    const cursorId = decodeCursor(cursor);
    if (cursorId === undefined || !Number.isInteger(cursorId) || cursorId <= 0) {
      throw new Error(
        `Invalid cursor: "${args.cursor}". Pass back the nextCursor from a previous page.`,
      );
    }
  }

  return {
    ...parsed.data,
    cursor,
    eventTypes: parsed.data.eventType,
    token: args.token?.trim() || undefined,
  };
}

export function formatTransfer(row: Record<string, unknown>) {
  return {
    ...row,
    ledgerClosedAt:
      row.ledgerClosedAt instanceof Date
        ? row.ledgerClosedAt.toISOString()
        : String(row.ledgerClosedAt),
  };
}

export const resolvers = {
  Query: {
    health: () => ({ ok: true, version: process.env.npm_package_version ?? "1.0.0" }),

    transfers: async (
      _parent: unknown,
      args: TransfersArgs,
      ctx?: GraphQLContext
    ) => {
      const validated = parseTransfersArgs(args);
      const common = {
        network: resolveArgNetwork(args.network, ctx),
        tokenDecimals: getCachedTokenDecimals,
        address: args.address,
        contractId: args.contractId ?? undefined,
        token: validated.token,
        cursor: validated.cursor,
        fromLedger: validated.fromLedger,
        toLedger: validated.toLedger,
        fromDate: validated.fromDate,
        toDate: validated.toDate,
        eventTypes: validated.eventTypes,
        limit: validated.limit,
        offset: validated.offset,
        includeTotal: validated.includeTotal,
      };

      const result =
        args.direction === "INCOMING"
          ? await queryTransfers({ ...common, direction: "incoming" })
          : args.direction === "OUTGOING"
            ? await queryTransfers({ ...common, direction: "outgoing" })
            : await queryAllTransfers(common);

      return {
        ...result,
        transfers: result.transfers.map((transfer) =>
          formatTransfer(transfer as Record<string, unknown>)
        ),
      };
    },

    transferByTx: async (
      _parent: unknown,
      args: { txHash: string; network?: NetworkArg },
      ctx?: GraphQLContext
    ) => {
      const network = resolveArgNetwork(args.network, ctx);
      const transfers = await queryByTxHash(args.txHash, network);
      return (transfers as Array<Record<string, unknown>>).map((transfer) => ({
        ...formatTransfer(transfer),
        displayAmount: toDisplayAmount(
          String(transfer.amount),
          typeof transfer.contractId === "string"
            ? getCachedTokenDecimals(transfer.contractId, network)
            : undefined,
        ),
      }));
    },

    summary: async (
      _parent: unknown,
      args: { address: string; contractId?: string; network?: NetworkArg },
      ctx?: GraphQLContext
    ) => {
      const network = resolveArgNetwork(args.network, ctx);
      const rows = await querySummary({
        address: args.address,
        contractId: args.contractId,
        network,
      });
      return rows.map((row) => {
        const received = BigInt(row.totalReceived);
        const sent = BigInt(row.totalSent);
        const net = received - sent;
        // Same display conversion as the REST summaryHandler in src/api.ts:
        // raw (integer) totals scaled by the token's cached decimals.
        const decimals = getCachedTokenDecimals(row.contractId, network);

        return {
          contractId: row.contractId,
          totalReceived: row.totalReceived,
          totalSent: row.totalSent,
          netFlow: net.toString(),
          displayTotalReceived: toDisplayAmount(row.totalReceived, decimals),
          displayTotalSent: toDisplayAmount(row.totalSent, decimals),
          displayNetFlow: toDisplayAmount(net.toString(), decimals),
          txCount: Number(row.txCount),
        };
      });
    },
  },
};

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createGraphQLMiddleware() {
  const server = new ApolloServer<GraphQLContext>({
    typeDefs,
    resolvers,
    persistedQueries: false,
    plugins: [
      persistedQueryPlugin,
      costLimitPlugin({
        maxDepth: readPositiveInt("GRAPHQL_MAX_DEPTH", 10),
        maxCost: readPositiveInt("GRAPHQL_MAX_COST", 1000),
      }),
    ],
  });

  server.startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests();

  // The HTTP-level selector reaches resolvers through the context, so
  // `?network=` and `X-Network` work on /graphql exactly as on the REST routes
  // — the networkMiddleware has already validated it by the time we read it.
  return expressMiddleware(server, {
    context: async ({ req }) => ({ network: requestNetwork(req) }),
  });
}
