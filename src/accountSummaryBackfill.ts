import { parseNetwork, type Network } from "./network";

export const DEFAULT_BACKFILL_BATCH_SIZE = 5000;

export class TruncatedHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedHistoryError";
  }
}

export interface TokenTransferBackfillRow {
  id: number;
  contractId: string;
  fromAddress: string | null;
  toAddress: string | null;
  amount: string;
  ledgerClosedAt: Date;
}

export interface AccountSummaryBackfillRow {
  id: number;
  address: string;
  contractId: string;
  totalSent: string;
  totalReceived: string;
  net: string;
  txCount: number;
  lastActivityAt: Date;
}

export interface BackfillTxClient {
  accountSummary: {
    createMany(args: {
      data: Array<{
        network: Network;
        address: string;
        contractId: string;
        totalSent: string;
        totalReceived: string;
        net: string;
        txCount: number;
        lastActivityAt: Date;
      }>;
    }): Promise<{ count: number }>;
    update(args: {
      where: { id: number };
      data: {
        totalSent: string;
        totalReceived: string;
        net: string;
        txCount: number;
        lastActivityAt: Date;
      };
    }): Promise<unknown>;
    deleteMany(args: {
      where: { network: Network; id: { in: number[] } };
    }): Promise<{ count: number }>;
  };
}

export interface BackfillPrismaClient extends BackfillTxClient {
  tokenTransfer: {
    findFirst(args: {
      where: { network: Network };
      orderBy: Array<{ ledgerClosedAt?: "asc"; id?: "asc" }>;
      select: { ledgerClosedAt: true };
    }): Promise<{ ledgerClosedAt: Date } | null>;
    findMany(args: {
      where: { network: Network; id?: { gt: number } };
      orderBy: { id: "asc" };
      take: number;
      select: {
        id: true;
        contractId: true;
        fromAddress: true;
        toAddress: true;
        amount: true;
        ledgerClosedAt: true;
      };
    }): Promise<TokenTransferBackfillRow[]>;
  };
  accountSummary: BackfillTxClient["accountSummary"] & {
    findFirst(args: {
      where: { network: Network };
      orderBy: Array<{ lastActivityAt?: "asc"; id?: "asc" }>;
      select: { lastActivityAt: true };
    }): Promise<{ lastActivityAt: Date } | null>;
    findMany(args: {
      where: { network: Network };
      select: {
        id: true;
        address: true;
        contractId: true;
        totalSent: true;
        totalReceived: true;
        net: true;
        txCount: true;
        lastActivityAt: true;
      };
    }): Promise<AccountSummaryBackfillRow[]>;
  };
  $transaction<R>(
    fn: (tx: BackfillTxClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number }
  ): Promise<R>;
}

export interface BackfillCliOptions {
  help: boolean;
  network?: Network;
  dryRun: boolean;
  acceptTruncatedHistory: boolean;
  batchSize: number;
}

export interface RebuildAccountSummariesOptions {
  network: Network;
  batchSize?: number;
  dryRun?: boolean;
  acceptTruncatedHistory?: boolean;
  onProgress?: (info: { processed: number; lastId: number }) => void;
}

export interface RebuildAccountSummariesResult {
  network: Network;
  dryRun: boolean;
  transfersProcessed: number;
  totalSummaries: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  changed: number;
}

interface ComputedAggregate {
  address: string;
  contractId: string;
  sent: bigint;
  received: bigint;
  txCount: number;
  lastActivityAt: Date;
}

export function parseBackfillBatchSize(
  raw: string | undefined,
  sourceName = "BACKFILL_BATCH_SIZE"
): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_BACKFILL_BATCH_SIZE;
  }
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!/^[1-9]\d*$/.test(trimmed) || !Number.isSafeInteger(parsed)) {
    throw new Error(
      `Invalid ${sourceName}="${raw}": must be a positive whole number.`
    );
  }
  return parsed;
}

export function parseBackfillArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): BackfillCliOptions {
  let help = false;
  let networkRaw: string | undefined;
  let dryRun = false;
  let acceptTruncatedHistory = false;
  let batchSizeRaw = env.BACKFILL_BATCH_SIZE;
  let batchSizeSource = "BACKFILL_BATCH_SIZE";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--accept-truncated-history") {
      acceptTruncatedHistory = true;
    } else if (arg === "--network") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--network requires a value: testnet or mainnet.");
      }
      networkRaw = next;
      i++;
    } else if (arg.startsWith("--network=")) {
      networkRaw = arg.slice("--network=".length);
    } else if (arg === "--batch-size") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error("--batch-size requires a positive integer value.");
      }
      batchSizeRaw = next;
      batchSizeSource = "--batch-size";
      i++;
    } else if (arg.startsWith("--batch-size=")) {
      batchSizeRaw = arg.slice("--batch-size=".length);
      batchSizeSource = "--batch-size";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const batchSize = parseBackfillBatchSize(batchSizeRaw, batchSizeSource);

  if (help) {
    const parsedNet = networkRaw !== undefined ? parseNetwork(networkRaw) : undefined;
    return {
      help: true,
      network: parsedNet ?? undefined,
      dryRun,
      acceptTruncatedHistory,
      batchSize,
    };
  }

  if (networkRaw === undefined) {
    throw new Error("Missing required argument: --network <testnet|mainnet>.");
  }

  const network = parseNetwork(networkRaw);
  if (!network) {
    throw new Error(
      `Invalid --network="${networkRaw}": expected "testnet" or "mainnet".`
    );
  }

  return {
    help: false,
    network,
    dryRun,
    acceptTruncatedHistory,
    batchSize,
  };
}

const CREATE_CHUNK_SIZE = 1000;
const DELETE_CHUNK_SIZE = 5000;

/**
 * Rebuild `AccountSummary` totals for a single network from `TokenTransfer`.
 *
 * Design choices:
 * - **Pruned-history guard:** Compares the oldest stored transfer's
 *   `ledgerClosedAt` with the oldest summary's `lastActivityAt` for `network`
 *   before scanning or modifying anything. When transfers have been pruned,
 *   rebuilding would shrink lifetime totals to the remaining retention window,
 *   so we refuse unless `acceptTruncatedHistory` is explicitly set.
 * - **Keyset pagination:** Pages `TokenTransfer` by `id > lastId` rather than
 *   `skip`/`take` so scan cost stays O(1) per page on large tables.
 * - **Zero-downtime update (compute + diff + atomic transaction, no wipe):**
 *   Instead of truncating/deleting all network rows up front (which leaves API
 *   readers seeing zeros mid-run) or swapping a temp table (which requires an
 *   ACCESS EXCLUSIVE lock and risks touching the other network in a shared
 *   table), we accumulate per-(address, contractId) aggregates in memory, diff
 *   them against existing `AccountSummary` rows for `network`, and apply only
 *   the changed/new/obsolete rows inside one `prisma.$transaction`. Readers
 *   never observe an empty table, unchanged rows incur zero write churn, and
 *   the other network's rows are never read or touched.
 */
export async function rebuildAccountSummaries(
  db: BackfillPrismaClient,
  options: RebuildAccountSummariesOptions
): Promise<RebuildAccountSummariesResult> {
  const {
    network,
    batchSize = DEFAULT_BACKFILL_BATCH_SIZE,
    dryRun = false,
    acceptTruncatedHistory = false,
    onProgress,
  } = options;

  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error(`Invalid batchSize=${batchSize}: must be a positive integer.`);
  }

  // 1. Refuse to silently shrink lifetime totals when history has been pruned.
  const [oldestTransfer, oldestSummary] = await Promise.all([
    db.tokenTransfer.findFirst({
      where: { network },
      orderBy: [{ ledgerClosedAt: "asc" }, { id: "asc" }],
      select: { ledgerClosedAt: true },
    }),
    db.accountSummary.findFirst({
      where: { network },
      orderBy: [{ lastActivityAt: "asc" }, { id: "asc" }],
      select: { lastActivityAt: true },
    }),
  ]);

  if (oldestSummary !== null && !acceptTruncatedHistory) {
    if (oldestTransfer === null) {
      throw new TruncatedHistoryError(
        `Refusing to rebuild ${network} account summaries: existing summaries go back to ` +
          `${oldestSummary.lastActivityAt.toISOString()}, but no TokenTransfer rows remain for ` +
          `${network} (history has been pruned). Rebuilding would wipe lifetime totals. ` +
          `Re-run with --accept-truncated-history if you intend to replace them.`
      );
    }
    if (oldestTransfer.ledgerClosedAt.getTime() > oldestSummary.lastActivityAt.getTime()) {
      throw new TruncatedHistoryError(
        `Refusing to rebuild ${network} account summaries: oldest stored transfer ` +
          `(${oldestTransfer.ledgerClosedAt.toISOString()}) is newer than oldest summary ` +
          `(${oldestSummary.lastActivityAt.toISOString()}), indicating transfer history has been ` +
          `pruned by retention. Rebuilding would replace lifetime totals with retained-window ` +
          `totals. Re-run with --accept-truncated-history to proceed anyway.`
      );
    }
  }

  // 2. Scan all TokenTransfer rows for `network` using keyset pagination on `id`.
  const aggregates = new Map<string, ComputedAggregate>();
  let transfersProcessed = 0;
  let lastId: number | undefined;

  const touch = (
    address: string,
    contractId: string,
    sent: bigint,
    received: bigint,
    at: Date
  ) => {
    const key = `${address}\0${contractId}`;
    const prev = aggregates.get(key);
    if (!prev) {
      aggregates.set(key, {
        address,
        contractId,
        sent,
        received,
        txCount: 1,
        lastActivityAt: at,
      });
      return;
    }
    prev.sent += sent;
    prev.received += received;
    prev.txCount += 1;
    if (at.getTime() > prev.lastActivityAt.getTime()) {
      prev.lastActivityAt = at;
    }
  };

  while (true) {
    const batch = await db.tokenTransfer.findMany({
      where: {
        network,
        ...(lastId !== undefined ? { id: { gt: lastId } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: {
        id: true,
        contractId: true,
        fromAddress: true,
        toAddress: true,
        amount: true,
        ledgerClosedAt: true,
      },
    });

    if (batch.length === 0) break;

    for (const row of batch) {
      const amt = BigInt(row.amount);
      if (row.fromAddress) {
        touch(row.fromAddress, row.contractId, amt, 0n, row.ledgerClosedAt);
      }
      if (row.toAddress) {
        touch(row.toAddress, row.contractId, 0n, amt, row.ledgerClosedAt);
      }
    }

    transfersProcessed += batch.length;
    lastId = batch[batch.length - 1].id;
    onProgress?.({ processed: transfersProcessed, lastId });
  }

  // 3. Diff computed aggregates against existing AccountSummary rows for `network`.
  const existingRows = await db.accountSummary.findMany({
    where: { network },
    select: {
      id: true,
      address: true,
      contractId: true,
      totalSent: true,
      totalReceived: true,
      net: true,
      txCount: true,
      lastActivityAt: true,
    },
  });

  const existingByKey = new Map<string, AccountSummaryBackfillRow>();
  for (const row of existingRows) {
    existingByKey.set(`${row.address}\0${row.contractId}`, row);
  }

  const toCreate: Array<{
    network: Network;
    address: string;
    contractId: string;
    totalSent: string;
    totalReceived: string;
    net: string;
    txCount: number;
    lastActivityAt: Date;
  }> = [];

  const toUpdate: Array<{
    id: number;
    totalSent: string;
    totalReceived: string;
    net: string;
    txCount: number;
    lastActivityAt: Date;
  }> = [];

  let unchanged = 0;

  for (const [key, agg] of aggregates) {
    const totalSent = agg.sent.toString();
    const totalReceived = agg.received.toString();
    const net = (agg.received - agg.sent).toString();
    const existing = existingByKey.get(key);

    if (!existing) {
      toCreate.push({
        network,
        address: agg.address,
        contractId: agg.contractId,
        totalSent,
        totalReceived,
        net,
        txCount: agg.txCount,
        lastActivityAt: agg.lastActivityAt,
      });
      continue;
    }

    const isSame =
      existing.totalSent === totalSent &&
      existing.totalReceived === totalReceived &&
      existing.net === net &&
      existing.txCount === agg.txCount &&
      existing.lastActivityAt.getTime() === agg.lastActivityAt.getTime();

    if (isSame) {
      unchanged++;
    } else {
      toUpdate.push({
        id: existing.id,
        totalSent,
        totalReceived,
        net,
        txCount: agg.txCount,
        lastActivityAt: agg.lastActivityAt,
      });
    }
  }

  const toDeleteIds: number[] = [];
  for (const [key, existing] of existingByKey) {
    if (!aggregates.has(key)) {
      toDeleteIds.push(existing.id);
    }
  }

  const changed = toCreate.length + toUpdate.length + toDeleteIds.length;

  // 4. Write atomically inside one transaction (unless dry-run or no changes).
  if (!dryRun && changed > 0) {
    await db.$transaction(
      async (tx) => {
        for (const row of toUpdate) {
          await tx.accountSummary.update({
            where: { id: row.id },
            data: {
              totalSent: row.totalSent,
              totalReceived: row.totalReceived,
              net: row.net,
              txCount: row.txCount,
              lastActivityAt: row.lastActivityAt,
            },
          });
        }

        for (let i = 0; i < toCreate.length; i += CREATE_CHUNK_SIZE) {
          await tx.accountSummary.createMany({
            data: toCreate.slice(i, i + CREATE_CHUNK_SIZE),
          });
        }

        for (let i = 0; i < toDeleteIds.length; i += DELETE_CHUNK_SIZE) {
          await tx.accountSummary.deleteMany({
            where: {
              network,
              id: { in: toDeleteIds.slice(i, i + DELETE_CHUNK_SIZE) },
            },
          });
        }
      },
      { maxWait: 10_000, timeout: 60_000 }
    );
  }

  return {
    network,
    dryRun,
    transfersProcessed,
    totalSummaries: aggregates.size,
    created: toCreate.length,
    updated: toUpdate.length,
    deleted: toDeleteIds.length,
    unchanged,
    changed,
  };
}
