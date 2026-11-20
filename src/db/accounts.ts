import { Prisma } from "@prisma/client";
import { decodeCursor, parseODataFilter, parseODataSelect } from "../lib/odata";
import { resolveNetwork, type Network } from "../network";
import { when } from "../prismaWhen";
import { prisma, buildListPage, selectRows, totalField } from "./client";
import {
  type TransferRecord,
  type AccountSummaryQueryParams,
  ACCOUNT_SUMMARY_SELECTABLE_FIELDS,
  ACCOUNT_SUMMARY_FIELD_TYPES,
} from "./types";

/**
 * Incrementally update materialized aggregates for every address touched by
 * `records`. Called inside the same logical write as upsertTransfers so the
 * two tables never diverge.
 *
 * Strategy:
 *   1. Accumulate per-(address, contractId) deltas in memory.
 *   2. Emit one raw UPSERT per unique pair - O(unique addresses) DB round-trips.
 *
 * Using raw SQL because Prisma cannot do arithmetic on string-typed NUMERIC columns.
 */
export async function upsertAccountSummaries(
  records: TransferRecord[],
  network?: Network
): Promise<void> {
  if (records.length === 0) return;
  // Deliberately not called `net` - this table already has a `net` column
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
 * O(1) - reads directly from the materialized AccountSummary table.
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
      ...when<Prisma.AccountSummaryWhereInput>(Boolean(contractId), { contractId }),
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
    ...when<Prisma.AccountSummaryWhereInput>(Boolean(contractId), { contractId }),
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
      displayTotalSent: (row) => (row as { totalSent?: unknown }).totalSent,
      displayTotalReceived: (row) => (row as { totalReceived?: unknown }).totalReceived,
      displayNet: (row) => (row as { net?: unknown }).net,
    }),
    nextCursor: page.nextCursor,
  };
}
