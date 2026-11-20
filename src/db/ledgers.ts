import { resolveNetwork, type Network } from "../network";
import { observeDbQuery } from "../metrics";
import { prisma } from "./client";
import type { BackfillCursorState } from "./types";

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

// ─── Backfill cursor helpers ───────────────────────────────────────────────
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
