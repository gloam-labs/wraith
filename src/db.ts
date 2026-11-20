import { PrismaClient, Prisma } from "@prisma/client";
import type { NftTransferRecord, NftMetadataPayload } from "./ingester/nft";
import { decodeCursor, encodeCursor, parseODataFilter, parseODataSelect, projectRecord } from "./lib/odata";
import { resolveNetwork, type Network } from "./network";
import { toDisplayAmount } from "./amount";

// Every function below takes an optional trailing `network`. Omitting it means
// "the network this process is configured for" (STELLAR_NETWORK), which is
// exactly the pre-#159 behaviour for single-network deployments. The per-network
// indexer loop (#161) and the API selector (#163) pass it explicitly.

export { toDisplayAmount } from "./amount";

import { withReadReplicas } from "./db/router";
import { observeDbQuery } from "./metrics";

// ─── Singleton Prisma client ───────────────────────────────────────────────
// Re-use one connection pool across the process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const replicaUrls = process.env.DATABASE_REPLICAS
  ? process.env.DATABASE_REPLICAS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const prisma =
  globalForPrisma.prisma ??
  withReadReplicas(
    new PrismaClient({
      // `query` only in development: it prints every statement, which is
      // noise in production and can carry parameter values into the log.
      // `error` stays in both. Prisma's error log goes to stdout, never to a
      // caller — the response-side leak was closed separately — and this is
      // the only place a failed write on a money-moving route becomes visible
      // at all, since the route handlers answer 500 without logging.
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "warn", "error"]
          : ["warn", "error"],
    }),
    { replicaUrls }
  );

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// ─── Types ─────────────────────────────────────────────────────────────────
export interface TransferRecord {
  contractId: string;
  eventType: string; // "transfer" | "mint" | "burn" | "clawback"
  fromAddress: string | null;
  toAddress: string | null;
  amount: string; // i128 as decimal string
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
  isSac?: boolean; // true when the contract is a Stellar Asset Contract (#136)
}

type ListPage<T> = {
  rows: T[];
  nextCursor: string | null;
  /** True when the n+1 fetch found a row past this page. */
  hasMore: boolean;
};

/**
 * A `COUNT(*)` over the same filter costs as much as walking every matching
 * row, and on the tables this service exists to grow it dominates the request.
 * Lists therefore skip it unless the caller asks with `includeTotal` (#206);
 * `hasMore` from the n+1 fetch already answers what pagination needs.
 */
function totalField(total: number | undefined): { total?: number } {
  return total === undefined ? {} : { total };
}

function buildListPage<T extends { id: number }>(rows: T[], limit: number): ListPage<T> {
  if (rows.length <= limit) {
    return { rows, nextCursor: null, hasMore: false };
  }

  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    nextCursor: encodeCursor(pageRows[pageRows.length - 1].id),
    hasMore: true,
  };
}

function selectRows<T extends Record<string, unknown>>(
  rows: T[],
  select: string[] | undefined,
  derived: Record<string, (row: T) => unknown> = {}
): Array<Record<string, unknown>> {
  return rows.map((row) => projectRecord(row, select, derived));
}

const TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "eventType",
  "fromAddress",
  "toAddress",
  "amount",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "isSac",
  "createdAt",
  "displayAmount",
  "direction",
];

const NFT_TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "tokenId",
  "fromAddress",
  "toAddress",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "createdAt",
];

const ACCOUNT_SUMMARY_SELECTABLE_FIELDS = [
  "id",
  "address",
  "contractId",
  "totalSent",
  "totalReceived",
  "net",
  "txCount",
  "lastActivityAt",
  "updatedAt",
  "displayTotalSent",
  "displayTotalReceived",
  "displayNet",
];

const TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  eventType: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  amount: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

const NFT_TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  tokenId: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

const ACCOUNT_SUMMARY_FIELD_TYPES = {
  id: { type: "number" as const },
  address: { type: "string" as const },
  contractId: { type: "string" as const },
  totalSent: { type: "string" as const },
  totalReceived: { type: "string" as const },
  net: { type: "string" as const },
  txCount: { type: "number" as const },
  lastActivityAt: { type: "date" as const },
  updatedAt: { type: "date" as const },
};

// ─── Upsert helper ─────────────────────────────────────────────────────────
/**
 * Idempotently insert a batch of transfer events.
 * Conflicts on `(network, eventId)` are silently ignored — safe to call
 * multiple times with overlapping ledger ranges.
 */
export async function upsertTransfers(
  records: TransferRecord[],
  network?: Network
): Promise<number> {
  if (records.length === 0) return 0;
  const net = resolveNetwork(network);

  // Prisma's createMany with skipDuplicates is the most efficient bulk path.
  const result = await observeDbQuery("upsertTransfers", () =>
    prisma.tokenTransfer.createMany({
      data: records.map((r) => ({ ...r, network: net })),
      skipDuplicates: true,
    })
  );

  return result.count;
}

// ─── Indexer state helpers ─────────────────────────────────────────────────
/**
 * Read the last indexed ledger from DB.
 * Returns null if no state row exists yet for this network.
 */
export async function getLastIndexedLedger(network?: Network): Promise<number | null> {
  const state = await observeDbQuery("getLastIndexedLedger", () =>
    prisma.indexerState.findUnique({
      where: { network: resolveNetwork(network) },
    })
  );
  return state?.lastIndexedLedger ?? null;
}

/**
 * Read the last indexed ledger and state details from DB.
 */
export async function getLastIndexedState(
  network?: Network
): Promise<{ lastIndexedLedger: number | null }> {
  const state = await prisma.indexerState.findUnique({
    where: { network: resolveNetwork(network) },
  });
  return { lastIndexedLedger: state?.lastIndexedLedger ?? null };
}

/**
 * Persist the last successfully indexed ledger sequence number.
 */
export async function setLastIndexedLedger(ledger: number, network?: Network): Promise<void> {
  const net = resolveNetwork(network);
  await observeDbQuery("setLastIndexedLedger", () =>
    prisma.indexerState.upsert({
      where: { network: net },
      create: { network: net, lastIndexedLedger: ledger },
      update: { lastIndexedLedger: ledger },
    })
  );
}

// ─── Derived balances ─────────────────────────────────────────────────────────
export type BalanceRow = {
  contractId: string;
  balance: string;
};

/**
 * Per-token balance for an address, derived by summing what it received and
 * subtracting what it sent across the indexed history.
 *
 * This is a *derived* figure, not an on-chain balance read. It is only correct
 * from the ledger the indexer started at: anything the address held before
 * that is invisible here, so the number can be lower than reality and, for an
 * address that was net-negative over the indexed window, can even be negative.
 * The route says so in its response rather than presenting it as authoritative.
 *
 * Scoped by network — summing two chains' transfers for the same address
 * produces a figure that corresponds to no balance anywhere.
 */
export async function queryBalances(
  address: string,
  network?: Network
): Promise<BalanceRow[]> {
  const net = resolveNetwork(network);

  return observeDbQuery("queryBalances", () =>
    prisma.$queryRaw<BalanceRow[]>`
      SELECT
        "contractId",
        (
          COALESCE(SUM(CASE WHEN "toAddress"   = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN "fromAddress" = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)
        )::TEXT AS "balance"
      FROM "wraith"."TokenTransfer"
      WHERE "network" = ${net}
        AND ("toAddress" = ${address} OR "fromAddress" = ${address})
      GROUP BY "contractId"
      HAVING (
        COALESCE(SUM(CASE WHEN "toAddress"   = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN "fromAddress" = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)
      ) <> 0
      ORDER BY "contractId"
    `
  );
}

// ─── Backfill cursor helpers ───────────────────────────────────────────────
export interface BackfillCursorState {
  startLedger: number;
  endLedger: number;
  nextLedger: number;
}

export async function getBackfillCursor(
  network?: Network
): Promise<BackfillCursorState | null> {
  const state = await prisma.backfillCursor.findUnique({
    where: { network: resolveNetwork(network) },
  });
  return state
    ? { startLedger: state.startLedger, endLedger: state.endLedger, nextLedger: state.nextLedger }
    : null;
}

export async function setBackfillCursor(
  cursor: BackfillCursorState,
  network?: Network
): Promise<void> {
  const net = resolveNetwork(network);
  await prisma.backfillCursor.upsert({
    where: { network: net },
    create: { network: net, ...cursor },
    update: cursor,
  });
}

export async function clearBackfillCursor(network?: Network): Promise<void> {
  await prisma.backfillCursor.deleteMany({ where: { network: resolveNetwork(network) } });
}

// ─── Data retention ─────────────────────────────────────────────────────────
export const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

let warnedRetentionValue: string | undefined;

/**
 * Read `RETENTION_DAYS`, falling back to the default for anything that is not a
 * whole number of days between 1 and 3650.
 *
 * A bare `parseInt` let `RETENTION_DAYS=abc` through as NaN, which made an
 * invalid cut-off date, which made every delete throw, which meant nothing was
 * ever pruned: the 2026-10-27 outage reached by a typo. `0` and negative values
 * are rejected as well, since they would put the cut-off at or after now and
 * delete everything. A bad value warns once per distinct value, not per run.
 */
export function resolveRetentionDays(raw: string | undefined = process.env.RETENTION_DAYS): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const trimmed = raw.trim();
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (Number.isSafeInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS) return days;

  if (warnedRetentionValue !== trimmed) {
    warnedRetentionValue = trimmed;
    console.warn(
      `[prune] Ignoring invalid RETENTION_DAYS (expected a whole number from 1 to ${MAX_RETENTION_DAYS}); using ${DEFAULT_RETENTION_DAYS}`
    );
  }
  return DEFAULT_RETENTION_DAYS;
}

/** Test-only: forget which bad `RETENTION_DAYS` value has already warned. */
export function _resetRetentionWarning(): void {
  warnedRetentionValue = undefined;
}

type PrunableDelegate = {
  findMany(args: {
    where: Record<string, unknown>;
    select: { id: true };
    orderBy: { id: "asc" };
    take: number;
  }): Promise<Array<{ id: number }>>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
};

/**
 * Every table the indexer writes to, in one place. See {@link pruneNetwork} for
 * why this is spelled out rather than derived: **a new table the indexer writes
 * to must be added here.** `rollbackToLedger` enumerates the same four, and the
 * two lists are meant to agree.
 */
export const PRUNE_TABLES: ReadonlyArray<{ label: string; delegate: () => PrunableDelegate }> = [
  { label: "transfers", delegate: () => prisma.tokenTransfer as unknown as PrunableDelegate },
  { label: "nftTransfers", delegate: () => prisma.nftTransfer as unknown as PrunableDelegate },
  { label: "hostFnLogs", delegate: () => prisma.hostFnLog as unknown as PrunableDelegate },
  { label: "lpShareTransfers", delegate: () => prisma.lpShareTransfer as unknown as PrunableDelegate },
];

export interface PruneOptions {
  /** Rows per DELETE statement. */
  batchSize?: number;
  /** Pause between batches, so a run never monopolises the database. */
  pauseMs?: number;
  /** Stop starting new batches after this long; the next run continues. */
  budgetMs?: number;
  now?: Date;
}

export interface PruneResult {
  network: Network;
  deleted: Record<string, number>;
  total: number;
  /** False when the time budget ran out before every table was drained. */
  complete: boolean;
}

export const PRUNE_BATCH_SIZE = 5_000;
export const PRUNE_BATCH_PAUSE_MS = 100;
export const PRUNE_RUN_BUDGET_MS = 60_000;

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete indexed events older than the retention window for ONE network, in
 * bounded batches. Throws on a database error; callers decide what that means.
 *
 * **Every indexed table, not just transfers.** This pruned `TokenTransfer`
 * alone for a long time while the indexer wrote to four tables, and on
 * 2026-10-27 that filled the shared Supabase disk and put the whole project
 * into read-only mode: `HostFnLog` had reached 1,776 MB over 3.64 million rows
 * — more than every other table in the database combined — while `TokenTransfer`
 * sat at 80 kB precisely because this function was keeping it trimmed. Writes
 * stopped for wraith and Lens together, and recovery meant truncating the table
 * by hand.
 *
 * So the rule, and the reason the list is spelled out rather than defaulted:
 * a new table the indexer writes to must be added to {@link PRUNE_TABLES}.
 *
 * **Batched.** `deleteMany` has no LIMIT, so each batch first selects up to
 * `batchSize` ids (scoped by network and age) and deletes exactly those, with
 * the network and age predicate repeated on the delete. One statement therefore
 * never touches more than a batch, and a stale id can never reach another
 * network's rows.
 *
 * Scoped to one network, like every other bulk delete here: pruning testnet
 * must never delete mainnet history, which is the more expensive of the two to
 * re-index.
 */
export async function pruneNetwork(
  network?: Network,
  options: PruneOptions = {}
): Promise<PruneResult> {
  const net = resolveNetwork(network);
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? PRUNE_BATCH_SIZE));
  const pauseMs = options.pauseMs ?? PRUNE_BATCH_PAUSE_MS;
  const budgetMs = options.budgetMs ?? PRUNE_RUN_BUDGET_MS;
  const retentionDays = resolveRetentionDays();
  const cutoff = new Date((options.now ?? new Date()).getTime() - retentionDays * 86_400_000);
  const where = { network: net, ledgerClosedAt: { lt: cutoff } };
  const startedAt = Date.now();

  const deleted: Record<string, number> = {};
  let complete = true;

  tables: for (const { label, delegate } of PRUNE_TABLES) {
    deleted[label] = 0;
    const table = delegate();
    for (;;) {
      if (Date.now() - startedAt >= budgetMs) {
        complete = false;
        break tables;
      }
      const rows = await table.findMany({
        where,
        select: { id: true },
        orderBy: { id: "asc" },
        take: batchSize,
      });
      if (rows.length === 0) break;

      const { count } = await table.deleteMany({
        where: { ...where, id: { in: rows.map((row) => row.id) } },
      });
      deleted[label] += count;

      if (rows.length < batchSize) break;
      if (pauseMs > 0) await sleepMs(pauseMs);
    }
  }

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    const detail = Object.entries(deleted)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label}=${n}`)
      .join(" ");
    console.log(
      `[prune] Deleted ${total} ${net} rows older than ${retentionDays} days (before ${cutoff.toISOString()}): ${detail}${complete ? "" : " (time budget reached, continuing next run)"}`
    );
  }

  return { network: net, deleted, total, complete };
}

/** Prune one network and return only the row count. */
export async function pruneOldTransfers(
  network?: Network,
  options?: PruneOptions
): Promise<number> {
  return (await pruneNetwork(network, options)).total;
}

// ─── Query helpers ─────────────────────────────────────────────────────────
export type TransferQueryParams = {
  network?: Network;
  tokenDecimals?: (contractId: string, network: Network) => number | undefined;
  address: string;
  direction: "incoming" | "outgoing";
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export async function queryTransfers(params: TransferQueryParams) {
  const {
    network,
    tokenDecimals,
    address,
    direction,
    contractId,
    token,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = params;
  const resolvedNetwork = resolveNetwork(network);

  const baseWhere: Prisma.TokenTransferWhereInput = {
    network: resolvedNetwork,
    ...(direction === "incoming" ? { toAddress: address } : { fromAddress: address }),
    ...(contractId ? { contractId } : {}),
    ...(token ? { contractId: token } : {}),
    ...(eventTypes?.length ? { eventType: { in: eventTypes } } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
    ...(fromDate || toDate
      ? {
          ledgerClosedAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
  };

  const odataWhere = parseODataFilter(filter, TRANSFER_FIELD_TYPES);
  const where: Prisma.TokenTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.TokenTransferWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId") || requestedSelect.includes("displayAmount"),
        eventType: requestedSelect.includes("eventType"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        amount: requestedSelect.includes("amount") || requestedSelect.includes("displayAmount"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        isSac: requestedSelect.includes("isSac"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);

  const [total, transfers] = await observeDbQuery("queryTransfers", async () => {
    const rowsQuery = prisma.tokenTransfer.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap + 1,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
      ...(prismaSelect ? { select: prismaSelect } : {}),
    });
    return includeTotal
      ? prisma.$transaction([prisma.tokenTransfer.count({ where }), rowsQuery])
      : ([undefined, await rowsQuery] as const);
  });

  const page = buildListPage(transfers as Array<{ id: number }>, cap);

  return {
    ...totalField(total),
    hasMore: page.hasMore,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect, {
      displayAmount: (row) => {
        const transfer = row as { amount?: string; contractId?: string };
        return toDisplayAmount(
          String(transfer.amount),
          transfer.contractId ? tokenDecimals?.(transfer.contractId, resolvedNetwork) : undefined,
        );
      },
    }),
    nextCursor: page.nextCursor,
  };
}

export async function queryByTxHash(txHash: string, network?: Network) {
  return prisma.tokenTransfer.findMany({
    where: { network: resolveNetwork(network), txHash },
    orderBy: { id: "asc" },
  });
}

// ─── Summary aggregate query ───────────────────────────────────────────────
export type SummaryQueryParams = {
  network?: Network;
  address: string;
  contractId?: string;
  fromDate?: Date;
  toDate?: Date;
};

type SummaryRow = {
  contractId: string;
  totalReceived: string; // NUMERIC cast to TEXT
  totalSent: string;     // NUMERIC cast to TEXT
  txCount: bigint;       // INT8 — node-postgres returns bigint columns as BigInt
};

/**
 * Returns per-token aggregate totals for an address.
 * Uses a raw SQL query because Prisma cannot SUM string-typed columns.
 */
export async function querySummary(params: SummaryQueryParams): Promise<SummaryRow[]> {
  const { network, address, contractId, fromDate, toDate } = params;

  // Raw SQL bypasses Prisma's where-builder, so the network predicate has to be
  // added by hand here — a missing one would silently sum both chains together.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"network" = ${resolveNetwork(network)}`,
    Prisma.sql`("toAddress" = ${address} OR "fromAddress" = ${address})`,
  ];
  if (contractId) conditions.push(Prisma.sql`"contractId" = ${contractId}`);
  if (fromDate)   conditions.push(Prisma.sql`"ledgerClosedAt" >= ${fromDate}`);
  if (toDate)     conditions.push(Prisma.sql`"ledgerClosedAt" <= ${toDate}`);

  const where = Prisma.join(conditions, " AND ");

  return prisma.$queryRaw<SummaryRow[]>`
    SELECT
      "contractId",
      COALESCE(SUM(CASE WHEN "toAddress"   = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)::TEXT AS "totalReceived",
      COALESCE(SUM(CASE WHEN "fromAddress" = ${address} THEN CAST("amount" AS NUMERIC) ELSE 0 END), 0)::TEXT AS "totalSent",
      COUNT(*)::INT8 AS "txCount"
    FROM "wraith"."TokenTransfer"
    WHERE ${where}
    GROUP BY "contractId"
    ORDER BY "contractId"
  `;
}

// ─── NFT helpers ───────────────────────────────────────────────────────────

export async function upsertNftTransfers(
  records: NftTransferRecord[],
  network?: Network
): Promise<number> {
  if (records.length === 0) return 0;
  const net = resolveNetwork(network);
  const result = await observeDbQuery("upsertNftTransfers", () =>
    prisma.nftTransfer.createMany({
      data: records.map((r) => ({ ...r, network: net })),
      skipDuplicates: true,
    })
  );
  return result.count;
}

export async function getNftMetadata(
  contractId: string,
  tokenId: string,
  network?: Network
): Promise<{ name: string | null; tokenUri: string | null } | null> {
  return prisma.nftMetadata.findUnique({
    where: {
      network_contractId_tokenId: { network: resolveNetwork(network), contractId, tokenId },
    },
    select: { name: true, tokenUri: true },
  });
}

/**
 * Roll back indexed rows to a target ledger sequence.
 * Deletes any rows with ledger > `targetLedger` from event tables
 * and atomically updates the indexer state to reflect the new tip.
 * Returns the number of deleted rows (sum across tables).
 */
export async function rollbackToLedger(
  targetLedger: number,
  network?: Network
): Promise<number> {
  const net = resolveNetwork(network);

  // Every delete is network-scoped. Ledger sequences are per-chain and testnet
  // runs far ahead of mainnet, so an unscoped `ledger > target` would let a
  // testnet reorg delete real mainnet history.
  const [deletedTransfers, deletedNftTransfers, deletedHostFnLogs, deletedLpTransfers, _state] = await prisma.$transaction([
    prisma.tokenTransfer.deleteMany({ where: { network: net, ledger: { gt: targetLedger } } }),
    prisma.nftTransfer.deleteMany({ where: { network: net, ledger: { gt: targetLedger } } }),
    prisma.hostFnLog.deleteMany({ where: { network: net, ledger: { gt: targetLedger } } }),
    prisma.lpShareTransfer.deleteMany({ where: { network: net, ledger: { gt: targetLedger } } }),
    prisma.indexerState.upsert({
      where: { network: net },
      create: { network: net, lastIndexedLedger: targetLedger },
      update: { lastIndexedLedger: targetLedger },
    }),
  ]);

  const totalDeleted =
    (deletedTransfers?.count ?? 0) + (deletedNftTransfers?.count ?? 0) + (deletedHostFnLogs?.count ?? 0) + (deletedLpTransfers?.count ?? 0);

  if (totalDeleted > 0) {
    console.log(`[reorg] Rolled back ${net} to ledger ${targetLedger}, deleted ${totalDeleted} rows`);
  } else {
    console.log(`[reorg] Rolled back ${net} to ledger ${targetLedger}, no rows deleted`);
  }

  return totalDeleted;
}

export async function upsertNftMetadata(
  contractId: string,
  tokenId: string,
  data: NftMetadataPayload,
  network?: Network
): Promise<void> {
  const net = resolveNetwork(network);
  await prisma.nftMetadata.upsert({
    where: { network_contractId_tokenId: { network: net, contractId, tokenId } },
    create: {
      network: net,
      contractId,
      tokenId,
      name: data.name ?? null,
      tokenUri: data.tokenUri ?? null,
    },
    update: { name: data.name ?? null, tokenUri: data.tokenUri ?? null, fetchedAt: new Date() },
  });
}

export type NftTransferQueryParams = {
  network?: Network;
  contractId?: string;
  tokenId?: string;
  address?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export async function queryNftTransfers(params: NftTransferQueryParams) {
  const {
    network,
    contractId,
    tokenId,
    address,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = params;

  const baseWhere: Prisma.NftTransferWhereInput = {
    network: resolveNetwork(network),
    ...(contractId ? { contractId } : {}),
    ...(tokenId ? { tokenId } : {}),
    ...(address ? { OR: [{ fromAddress: address }, { toAddress: address }] } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
  };

  const odataWhere = parseODataFilter(filter, NFT_TRANSFER_FIELD_TYPES);
  const where: Prisma.NftTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.NftTransferWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), NFT_TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId"),
        tokenId: requestedSelect.includes("tokenId"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const rowsQuery = prisma.nftTransfer.findMany({
    where,
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    take: cap + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
    ...(prismaSelect ? { select: prismaSelect } : {}),
  });
  const [total, transfers] = includeTotal
    ? await prisma.$transaction([prisma.nftTransfer.count({ where }), rowsQuery])
    : ([undefined, await rowsQuery] as const);

  const page = buildListPage(transfers as Array<{ id: number }>, cap);

  return {
    ...totalField(total),
    hasMore: page.hasMore,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect),
    nextCursor: page.nextCursor,
  };
}

/**
 * Return the current owner of a token: the toAddress of its most recent transfer.
 */
export async function getNftOwner(
  contractId: string,
  tokenId: string,
  network?: Network
): Promise<string | null> {
  const latest = await prisma.nftTransfer.findFirst({
    where: { network: resolveNetwork(network), contractId, tokenId, toAddress: { not: null } },
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    select: { toAddress: true },
  });
  return latest?.toAddress ?? null;
}

// ─── Account summary helpers ───────────────────────────────────────────────

/**
 * Incrementally update materialized aggregates for every address touched by
 * `records`. Called inside the same logical write as upsertTransfers so the
 * two tables never diverge.
 *
 * Strategy:
 *   1. Accumulate per-(address, contractId) deltas in memory.
 *   2. Emit one raw UPSERT per unique pair — O(unique addresses) DB round-trips.
 *
 * Using raw SQL because Prisma cannot do arithmetic on string-typed NUMERIC columns.
 */
export async function upsertAccountSummaries(
  records: TransferRecord[],
  network?: Network
): Promise<void> {
  if (records.length === 0) return;
  // Deliberately not called `net` — this table already has a `net` column
  // holding a balance, and the SQL below references both.
  const networkName = resolveNetwork(network);

  // Accumulate deltas keyed by "address|contractId"
  const deltas = new Map<
    string,
    { address: string; contractId: string; sent: bigint; received: bigint; count: number; lastAt: Date }
  >();

  const touch = (address: string, contractId: string, sent: bigint, received: bigint, at: Date) => {
    const key = `${address}|${contractId}`;
    const prev = deltas.get(key) ?? { address, contractId, sent: 0n, received: 0n, count: 0, lastAt: at };
    deltas.set(key, {
      address,
      contractId,
      sent: prev.sent + sent,
      received: prev.received + received,
      count: prev.count + 1,
      lastAt: at > prev.lastAt ? at : prev.lastAt,
    });
  };

  for (const { contractId, fromAddress, toAddress, amount, ledgerClosedAt } of records) {
    const amt = BigInt(amount);
    if (fromAddress) touch(fromAddress, contractId, amt, 0n, ledgerClosedAt);
    if (toAddress)   touch(toAddress,   contractId, 0n, amt, ledgerClosedAt);
  }

  for (const { address, contractId, sent, received, count, lastAt } of deltas.values()) {
    const sentStr     = sent.toString();
    const receivedStr = received.toString();
    const netStr      = (received - sent).toString();

    // The ON CONFLICT target must name the same columns as the unique index,
    // which #159 widened to (network, address, contractId). Leaving the old
    // two-column target here would raise
    // "no unique or exclusion constraint matching the ON CONFLICT specification"
    // on every write, not merely mis-scope the aggregate.
    await prisma.$executeRaw`
      INSERT INTO wraith."AccountSummary"
        ("network", address, "contractId", "totalSent", "totalReceived", net, "txCount", "lastActivityAt", "updatedAt")
      VALUES
        (${networkName}, ${address}, ${contractId}, ${sentStr}, ${receivedStr}, ${netStr}, ${count}, ${lastAt}, NOW())
      ON CONFLICT ("network", address, "contractId") DO UPDATE SET
        "totalSent"      = (wraith."AccountSummary"."totalSent"::NUMERIC     + ${sentStr}::NUMERIC)::TEXT,
        "totalReceived"  = (wraith."AccountSummary"."totalReceived"::NUMERIC  + ${receivedStr}::NUMERIC)::TEXT,
        net              = (wraith."AccountSummary"."totalReceived"::NUMERIC  + ${receivedStr}::NUMERIC
                           - wraith."AccountSummary"."totalSent"::NUMERIC     - ${sentStr}::NUMERIC)::TEXT,
        "txCount"        = wraith."AccountSummary"."txCount" + ${count},
        "lastActivityAt" = GREATEST(wraith."AccountSummary"."lastActivityAt", ${lastAt}),
        "updatedAt"      = NOW()
    `;
  }
}

/**
 * Return all asset rows for a given address, optionally filtered to one contract.
 * O(1) — reads directly from the materialized AccountSummary table.
 */
export async function getAccountSummary(
  address: string,
  contractId?: string,
  network?: Network
) {
  return prisma.accountSummary.findMany({
    where: {
      network: resolveNetwork(network),
      address,
      ...(contractId ? { contractId } : {}),
    },
    orderBy: { lastActivityAt: "desc" },
    select: {
      contractId:     true,
      totalSent:      true,
      totalReceived:  true,
      net:            true,
      txCount:        true,
      lastActivityAt: true,
    },
  });
}

export type AccountSummaryQueryParams = {
  network?: Network;
  address: string;
  contractId?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export async function queryAccountSummaries(params: AccountSummaryQueryParams) {
  const {
    network,
    address,
    contractId,
    filter,
    select,
    cursor,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = params;

  const baseWhere: Prisma.AccountSummaryWhereInput = {
    network: resolveNetwork(network),
    address,
    ...(contractId ? { contractId } : {}),
  };

  const odataWhere = parseODataFilter(filter, ACCOUNT_SUMMARY_FIELD_TYPES);
  const where: Prisma.AccountSummaryWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.AccountSummaryWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), ACCOUNT_SUMMARY_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        address: requestedSelect.includes("address"),
        contractId: requestedSelect.includes("contractId"),
        totalSent: requestedSelect.includes("totalSent"),
        totalReceived: requestedSelect.includes("totalReceived"),
        net: requestedSelect.includes("net"),
        txCount: requestedSelect.includes("txCount"),
        lastActivityAt: requestedSelect.includes("lastActivityAt"),
        updatedAt: requestedSelect.includes("updatedAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const rowsQuery = prisma.accountSummary.findMany({
    where,
    orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
    take: cap + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
    ...(prismaSelect ? { select: prismaSelect } : {}),
  });
  const [total, rows] = includeTotal
    ? await prisma.$transaction([prisma.accountSummary.count({ where }), rowsQuery])
    : ([undefined, await rowsQuery] as const);

  const page = buildListPage(rows as Array<{ id: number }>, cap);

  return {
    ...totalField(total),
    hasMore: page.hasMore,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect, {
      displayTotalSent: (row) => row.totalSent,
      displayTotalReceived: (row) => row.totalReceived,
      displayNet: (row) => row.net,
    }),
    nextCursor: page.nextCursor,
  };
}

// ─── Combined address query ────────────────────────────────────────────────
export type AllTransfersQueryParams = {
  network?: Network;
  tokenDecimals?: (contractId: string, network: Network) => number | undefined;
  address: string;
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export async function queryAllTransfers(params: AllTransfersQueryParams) {
  const {
    network,
    tokenDecimals,
    address,
    contractId,
    token,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    fromDate,
    toDate,
    eventTypes,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = params;
  const resolvedNetwork = resolveNetwork(network);

  const baseWhere: Prisma.TokenTransferWhereInput = {
    network: resolvedNetwork,
    OR: [{ toAddress: address }, { fromAddress: address }],
    ...(contractId ? { contractId } : {}),
    ...(token ? { contractId: token } : {}),
    ...(eventTypes?.length ? { eventType: { in: eventTypes } } : {}),
    ...(fromLedger || toLedger
      ? {
          ledger: {
            ...(fromLedger ? { gte: fromLedger } : {}),
            ...(toLedger ? { lte: toLedger } : {}),
          },
        }
      : {}),
    ...(fromDate || toDate
      ? {
          ledgerClosedAt: {
            ...(fromDate ? { gte: fromDate } : {}),
            ...(toDate ? { lte: toDate } : {}),
          },
        }
      : {}),
  };

  const odataWhere = parseODataFilter(filter, TRANSFER_FIELD_TYPES);
  const where: Prisma.TokenTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.TokenTransferWhereInput] }
    : baseWhere;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const requestedSelect = parseODataSelect(select?.join(","), TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId") || requestedSelect.includes("displayAmount"),
        eventType: requestedSelect.includes("eventType"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        amount: requestedSelect.includes("amount") || requestedSelect.includes("displayAmount"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        isSac: requestedSelect.includes("isSac"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const rowsQuery = prisma.tokenTransfer.findMany({
    where,
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    take: cap + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
    ...(prismaSelect ? { select: prismaSelect } : {}),
  });
  const [total, rows] = includeTotal
    ? await prisma.$transaction([prisma.tokenTransfer.count({ where }), rowsQuery])
    : ([undefined, await rowsQuery] as const);

  const page = buildListPage(rows as Array<{ id: number }>, cap);

  const transfers = selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect ? [...requestedSelect, "direction"] : undefined, {
    displayAmount: (row) => {
      const transfer = row as { amount?: string; contractId?: string };
      return toDisplayAmount(
        String(transfer.amount),
        transfer.contractId ? tokenDecimals?.(transfer.contractId, resolvedNetwork) : undefined,
      );
    },
    direction: (row) => ((row as { toAddress?: string | null }).toAddress === address ? "incoming" : "outgoing"),
  });

  return { ...totalField(total), hasMore: page.hasMore, transfers, nextCursor: page.nextCursor };
}

// ─── Popular assets query ──────────────────────────────────────────────────
export type PopularAssetsQueryParams = {
  network?: Network;
  fromDate: Date;
  by: string;
  limit: number;
  offset: number;
};

type PopularAssetRow = {
  contractId: string;
  transferCount: bigint;
  volume: string;
};

export async function queryPopularAssets(params: PopularAssetsQueryParams) {
  const { network, fromDate, by, limit, offset } = params;
  const net = resolveNetwork(network);
  const cap = Math.min(limit, 100);

  const orderClause = by === "volume"
    ? Prisma.sql`SUM(CAST("amount" AS NUMERIC)) DESC`
    : Prisma.sql`COUNT(*) DESC`;

  // Both halves filter on network. Leaving it off the count but not the page
  // (or vice versa) would return a total that disagrees with the rows.
  const countResult = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(DISTINCT "contractId")::INT8 AS "total"
    FROM "wraith"."TokenTransfer"
    WHERE "network" = ${net} AND "ledgerClosedAt" >= ${fromDate}
  `;
  const total = Number(countResult[0]?.total ?? 0);

  const assets = await prisma.$queryRaw<PopularAssetRow[]>`
    SELECT
      "contractId",
      COUNT(*)::INT8 AS "transferCount",
      COALESCE(SUM(CAST("amount" AS NUMERIC)), 0)::TEXT AS "volume"
    FROM "wraith"."TokenTransfer"
    WHERE "network" = ${net} AND "ledgerClosedAt" >= ${fromDate}
    GROUP BY "contractId"
    ORDER BY ${orderClause}
    LIMIT ${cap}
    OFFSET ${offset}
  `;

  return { total, assets };
}
