import "dotenv/config";
import { createSourceSwitcherWithConfig, type SourceSwitcher } from "../indexer/sources";
import { validateNetworkConfig } from "../rpc";
import {
  getBackfillCursor,
  setBackfillCursor,
  clearBackfillCursor,
  prisma,
} from "../db";
import type { Network } from "../network";
import { resolveNetwork, isNetwork } from "../network";
import { resolveWatchedContractIds } from "../indexer";
import { resolveLpPoolIds, loadKnownLpPools } from "../indexer/lp-shares";
import { initTokenCache } from "../tokenCache";
import { processEventBatch, batchTotal, type BatchContext } from "../indexer/batch";

const DEFAULT_CHUNK_SIZE = 64;
const DEFAULT_CONCURRENCY = 4;
const BATCH_SIZE = parseInt(process.env.EVENTS_BATCH_SIZE ?? "10000", 10);

export interface BackfillOptions {
  fromLedger: number;
  toLedger: number;
  /** Target chain to backfill; defaults to `STELLAR_NETWORK` via `resolveNetwork`. */
  network?: Network;
  chunkSize?: number;
  concurrency?: number;
  signal?: AbortSignal;
  force?: boolean;
  /** Explicit contract watch-list override (`--contracts <id,id>`). */
  contracts?: string[];
  /**
   * Emit live WebSocket/GraphQL/webhook notifications for backfilled records.
   * Defaults to `false` so historical catch-up never replays old transfers as new.
   */
  notifyLive?: boolean;
}

export interface Chunk {
  start: number;
  end: number;
}

export function chunkRange(from: number, to: number, chunkSize: number): Chunk[] {
  if (from >= to) return [];
  const chunks: Chunk[] = [];
  for (let i = from; i < to; i += chunkSize) {
    chunks.push({ start: i, end: Math.min(i + chunkSize, to) });
  }
  return chunks;
}

/**
 * Resolve the contract IDs a backfill will request for `network`.
 *
 * Uses the live indexer's own `resolveWatchedContractIds(network)` unless the
 * caller supplied an explicit `override` (`--contracts <id,id>`). Refuses an
 * empty watch list in both cases: `fetchEvents` omits the contract filter when
 * handed `[]`, which would pull every contract event on the chain.
 */
export function resolveBackfillContractIds(
  network: Network,
  override?: string[],
): string[] {
  const ids =
    override !== undefined
      ? [...new Set(override.map((s) => s.trim()).filter(Boolean))]
      : resolveWatchedContractIds(network);

  if (ids.length === 0) {
    const suffix = network.toUpperCase();
    throw new Error(
      `[backfill/${network}] No contracts to watch on ${network}. ` +
        `Set SAC_CONTRACT_IDS_${suffix} and/or NFT_CONTRACT_IDS_${suffix} ` +
        `(or pass --contracts <id,id>). An empty watch list is refused because ` +
        `it would fetch every contract event on the chain.`,
    );
  }

  return ids;
}

function createSource(network: Network): SourceSwitcher {
  const suffix = network.toUpperCase();
  return createSourceSwitcherWithConfig({
    network,
    horizonUrl: process.env[`HORIZON_URL_${suffix}`] || process.env.HORIZON_URL || undefined,
    horizonEventsPath: process.env.HORIZON_EVENTS_PATH,
    fetchImpl: (globalThis as {
      fetch?: (input: string, init?: Record<string, unknown>) => Promise<{
        ok: boolean; status: number; json(): Promise<unknown>;
      }>;
    }).fetch as (
      input: string,
      init?: { headers?: Record<string, string> }
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
  });
}

async function processChunk(
  chunk: Chunk,
  contracts: string[],
  source: SourceSwitcher,
  ctx: BatchContext,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) return 0;

  const { events } = await source.fetchEvents(
    chunk.start,
    chunk.end,
    contracts,
    BATCH_SIZE,
  );

  if (events.length === 0) return 0;

  const relevant = events.filter(
    (e) => e.ledger >= chunk.start && e.ledger < chunk.end,
  );
  if (relevant.length === 0) return 0;

  try {
    const result = await processEventBatch(relevant, ctx);
    return batchTotal(result);
  } catch (err) {
    console.error(`[backfill] Chunk ${chunk.start}-${chunk.end} failed:`, err);
    return 0;
  }
}

export async function runBackfill(options: BackfillOptions): Promise<void> {
  const {
    fromLedger,
    toLedger,
    network,
    chunkSize = DEFAULT_CHUNK_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
    force,
    notifyLive = false,
  } = options;

  if (options.network !== undefined && !isNetwork(options.network)) {
    throw new Error(
      `[backfill] Invalid network "${String(options.network)}". Expected "testnet" or "mainnet".`,
    );
  }
  const net = resolveNetwork(options.network);

  validateNetworkConfig([net]);

  const contracts = resolveBackfillContractIds(net, options.contracts);

  let cursor = await getBackfillCursor(net);
  if (cursor) {
    if (cursor.startLedger === fromLedger && cursor.endLedger === toLedger) {
      if (cursor.nextLedger >= toLedger) {
        console.log(`[backfill/${net}] Range already fully processed.`);
        await clearBackfillCursor(net);
        return;
      }
      console.log(
        `[backfill/${net}] Resuming from cursor: nextLedger=${cursor.nextLedger} (${fromLedger} → ${toLedger})`,
      );
    } else if (force) {
      console.log(
        `[backfill/${net}] Forcing new range ${fromLedger}→${toLedger} (cursor was ${cursor.startLedger}→${cursor.endLedger})`,
      );
      cursor = { startLedger: fromLedger, endLedger: toLedger, nextLedger: fromLedger };
    } else {
      console.warn(
        `[backfill/${net}] Existing cursor (${cursor.startLedger}→${cursor.endLedger}) differs from requested range ` +
        `(${fromLedger}→${toLedger}). Use --force to override.`,
      );
      return;
    }
  } else {
    cursor = { startLedger: fromLedger, endLedger: toLedger, nextLedger: fromLedger };
  }

  const chunks = chunkRange(cursor.nextLedger, toLedger, chunkSize);

  if (chunks.length === 0) {
    console.log(`[backfill/${net}] No chunks to process.`);
    await clearBackfillCursor(net);
    return;
  }

  const source = createSource(net);

  await initTokenCache(net).catch(() => undefined);

  const knownLpPools = new Set<string>(resolveLpPoolIds(net));
  try {
    for (const poolId of await loadKnownLpPools(net)) {
      knownLpPools.add(poolId);
    }
  } catch {
    console.error(`[backfill/${net}] Could not seed known LP pools from database`);
  }

  const batchCtx: BatchContext = {
    network: net,
    knownLpPools,
    notifyLive,
  };

  console.log(
    `[backfill/${net}] Processing ${chunks.length} chunks (size=${chunkSize}, concurrency=${concurrency})`,
    `contracts=[${contracts.join(",")}]`,
  );

  let totalInserted = 0;

  for (let i = 0; i < chunks.length; i += concurrency) {
    if (signal?.aborted) {
      console.log(`[backfill/${net}] Aborting — signal received.`);
      return;
    }

    const wave = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      wave.map((c) =>
        processChunk(c, contracts, source, batchCtx, signal).catch((err) => {
          console.error(`[backfill] Chunk ${c.start}-${c.end} failed:`, err);
          return 0;
        }),
      ),
    );

    const waveInserted = results.reduce((s, v) => s + v, 0);
    totalInserted += waveInserted;

    const lastChunk = wave[wave.length - 1];
    cursor.nextLedger = lastChunk.end;
    await setBackfillCursor(cursor, net);

    const pct = (((lastChunk.end - fromLedger) / (toLedger - fromLedger)) * 100).toFixed(1);
    const waveNum = Math.floor(i / concurrency) + 1;
    console.log(
      `[backfill/${net}] Wave ${waveNum} done — ledger ${lastChunk.end} (${pct}%), ${totalInserted} records inserted`,
    );
  }

  console.log(
    `[backfill/${net}] Complete — ${totalInserted} records inserted across ledgers ${fromLedger}→${toLedger}`,
  );

  await clearBackfillCursor(net);
  await prisma.$disconnect();
}
