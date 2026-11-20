import { Prisma } from "@prisma/client";
import { decodeCursor, parseODataFilter, parseODataSelect } from "../lib/odata";
import { resolveNetwork, type Network } from "../network";
import { toDisplayAmount } from "../amount";
import { observeDbQuery } from "../metrics";
import { when } from "../prismaWhen";
import { prisma, buildListPage, selectRows, totalField } from "./client";
import {
  type TransferRecord,
  type BalanceRow,
  type TransferQueryParams,
  type SummaryQueryParams,
  type SummaryRow,
  type AllTransfersQueryParams,
  TRANSFER_SELECTABLE_FIELDS,
  TRANSFER_FIELD_TYPES,
} from "./types";

// ─── Data retention ─────────────────────────────────────────────────────────
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS ?? "30", 10);

// ─── Upsert helper ─────────────────────────────────────────────────────────
/**
 * Idempotently insert a batch of transfer events.
 * Conflicts on `(network, eventId)` are silently ignored - safe to call
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

// ─── Derived balances ─────────────────────────────────────────────────────────
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
 * Scoped by network - summing two chains' transfers for the same address
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

/**
 * Delete indexed events older than RETENTION_DAYS to keep the DB within
 * free-tier limits. Returns the number of rows deleted across all tables.
 *
 * **Every indexed table, not just transfers.** This pruned `TokenTransfer`
 * alone for a long time while the indexer wrote to four tables, and on
 * 2026-10-27 that filled the shared Supabase disk and put the whole project
 * into read-only mode: `HostFnLog` had reached 1,776 MB over 3.64 million rows
 * - more than every other table in the database combined - while `TokenTransfer`
 * sat at 80 kB precisely because this function was keeping it trimmed. Writes
 * stopped for wraith and Lens together, and recovery meant truncating the table
 * by hand.
 *
 * So the rule, and the reason the list is spelled out rather than defaulted:
 * **a new table the indexer writes to must be added here.** `rollbackToLedger`
 * already enumerates the same four, and the two lists are meant to agree.
 *
 * Scoped to one network, like every other bulk delete here: pruning testnet
 * must never delete mainnet history, which is the more expensive of the two to
 * re-index.
 */
export async function pruneOldTransfers(network?: Network): Promise<number> {
  const net = resolveNetwork(network);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const where = { network: net, ledgerClosedAt: { lt: cutoff } };

  // Separate statements rather than one transaction: these are independent
  // deletes of millions of rows, and holding them open together is what makes a
  // prune block the indexer that scheduled it.
  const deleted: Record<string, number> = {};
  for (const [label, run] of [
    ["transfers", () => prisma.tokenTransfer.deleteMany({ where })],
    ["nftTransfers", () => prisma.nftTransfer.deleteMany({ where })],
    ["hostFnLogs", () => prisma.hostFnLog.deleteMany({ where })],
    ["lpShareTransfers", () => prisma.lpShareTransfer.deleteMany({ where })],
  ] as const) {
    deleted[label] = (await run()).count;
  }

  const total = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  if (total > 0) {
    const detail = Object.entries(deleted)
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label}=${n}`)
      .join(" ");
    console.log(
      `[prune] Deleted ${total} ${net} rows older than ${RETENTION_DAYS} days (before ${cutoff.toISOString()}): ${detail}`
    );
  }

  return total;
}

// ─── Query helpers ─────────────────────────────────────────────────────────
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
    ...when<Prisma.TokenTransferWhereInput>(direction === "incoming", { toAddress: address }),
    ...when<Prisma.TokenTransferWhereInput>(direction !== "incoming", { fromAddress: address }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(contractId), { contractId }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(token), { contractId: token }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(eventTypes?.length), {
      eventType: { in: eventTypes },
    }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(fromLedger || toLedger), {
      ledger: {
        ...when<Prisma.IntFilter>(Boolean(fromLedger), { gte: fromLedger }),
        ...when<Prisma.IntFilter>(Boolean(toLedger), { lte: toLedger }),
      },
    }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(fromDate || toDate), {
      ledgerClosedAt: {
        ...when<Prisma.DateTimeFilter>(Boolean(fromDate), { gte: fromDate }),
        ...when<Prisma.DateTimeFilter>(Boolean(toDate), { lte: toDate }),
      },
    }),
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
/**
 * Returns per-token aggregate totals for an address.
 * Uses a raw SQL query because Prisma cannot SUM string-typed columns.
 */
export async function querySummary(params: SummaryQueryParams): Promise<SummaryRow[]> {
  const { network, address, contractId, fromDate, toDate } = params;

  // Raw SQL bypasses Prisma's where-builder, so the network predicate has to be
  // added by hand here - a missing one would silently sum both chains together.
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

// ─── Combined address query ────────────────────────────────────────────────
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
    ...when<Prisma.TokenTransferWhereInput>(Boolean(contractId), { contractId }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(token), { contractId: token }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(eventTypes?.length), {
      eventType: { in: eventTypes },
    }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(fromLedger || toLedger), {
      ledger: {
        ...when<Prisma.IntFilter>(Boolean(fromLedger), { gte: fromLedger }),
        ...when<Prisma.IntFilter>(Boolean(toLedger), { lte: toLedger }),
      },
    }),
    ...when<Prisma.TokenTransferWhereInput>(Boolean(fromDate || toDate), {
      ledgerClosedAt: {
        ...when<Prisma.DateTimeFilter>(Boolean(fromDate), { gte: fromDate }),
        ...when<Prisma.DateTimeFilter>(Boolean(toDate), { lte: toDate }),
      },
    }),
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
