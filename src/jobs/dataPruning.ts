/**
 * Scheduled data-retention pruning.
 *
 * This used to run inside each network's poll loop, which meant it only ran for
 * a network whose loop was running and busy, and it blocked indexing while it
 * deleted. It now has its own timer and covers every enabled network, whether
 * or not its indexer started, and also when SKIP_INDEXER=true.
 *
 * Each run is bounded (batched deletes, time budget) and runs never overlap.
 * A failure is logged and counted out of the success gauge; it never throws out
 * of the timer, so it cannot stop the service or the indexer.
 */

import { pruneNetwork, type PruneOptions } from "../db";
import { pruneLastSuccessTimestampSeconds, pruneRowsDeletedTotal } from "../metrics";
import { enabledNetworks } from "../network";

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface DataPruningHandle {
  stop(): void;
}

/** Prune every enabled network once. A failing network does not skip the rest. */
export async function runDataPruningJob(options: PruneOptions = {}): Promise<void> {
  for (const network of enabledNetworks()) {
    try {
      const result = await pruneNetwork(network, options);
      for (const [table, count] of Object.entries(result.deleted)) {
        if (count > 0) pruneRowsDeletedTotal.inc({ network, table }, count);
      }
      pruneLastSuccessTimestampSeconds.set({ network }, Date.now() / 1000);
    } catch (error) {
      // The message only: a raw database error can carry a connection string.
      const reason = error instanceof Error ? error.name : "unknown error";
      console.error(`[prune] ${network} run failed (${reason})`);
    }
  }
}

export function startDataPruningJob(): DataPruningHandle | null {
  const intervalMs = Number(process.env.PRUNE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    console.warn("[prune] PRUNE_INTERVAL_MS is not a positive integer; pruning job not started");
    return null;
  }

  // A run can outlast the interval when there is a large backlog; two at once
  // would delete the same rows twice and double the lock pressure.
  let running = false;
  const run = () => {
    if (running) {
      console.warn("[prune] previous run still in progress, skipping this tick");
      return;
    }
    running = true;
    void runDataPruningJob()
      .catch(() => console.error("[prune] job failed"))
      .finally(() => {
        running = false;
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
