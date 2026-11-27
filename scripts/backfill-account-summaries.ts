/**
 * Backfill script — AccountSummary
 *
 * Rebuilds materialized AccountSummary rows for a single network from
 * TokenTransfer using keyset pagination, without wiping the table while
 * readers are active, and refuses to shrink pruned history unless
 * `--accept-truncated-history` is given.
 *
 * Usage:
 *   npm run backfill:summaries -- --network testnet|mainnet [options]
 *
 * Options:
 *   --network <testnet|mainnet>    Target network (required)
 *   --dry-run                      Compute totals and print diff without writing
 *   --accept-truncated-history     Allow rebuild when transfers were pruned
 *   --batch-size <num>             Rows per keyset page (default: BACKFILL_BATCH_SIZE or 5000)
 *   --help, -h                     Show usage
 */

import "dotenv/config";
import { prisma } from "../src/db";
import {
  parseBackfillArgs,
  rebuildAccountSummaries,
  type BackfillPrismaClient,
} from "../src/accountSummaryBackfill";

const USAGE = `Usage:
  npm run backfill:summaries -- --network <testnet|mainnet> [options]

Options:
  --network <testnet|mainnet>    Target network to rebuild (required)
  --dry-run                      Compute totals and report row changes without writing
  --accept-truncated-history     Proceed even if older transfers were pruned by retention
  --batch-size <num>             Transfers per keyset page (default: BACKFILL_BATCH_SIZE or 5000)
  --help, -h                     Show this help message
`;

async function main() {
  const options = parseBackfillArgs(process.argv.slice(2));
  if (options.help || !options.network) {
    console.log(USAGE);
    return;
  }

  console.log(
    `[backfill] Starting account summary rebuild for ${options.network}` +
      `${options.dryRun ? " (dry-run)" : ""} (batchSize=${options.batchSize})…`
  );

  const result = await rebuildAccountSummaries(
    prisma as unknown as BackfillPrismaClient,
    {
      network: options.network,
      batchSize: options.batchSize,
      dryRun: options.dryRun,
      acceptTruncatedHistory: options.acceptTruncatedHistory,
      onProgress: ({ processed, lastId }) => {
        console.log(`[backfill] [${options.network}] Processed ${processed} transfers (cursor id=${lastId})`);
      },
    }
  );

  if (result.dryRun) {
    console.log(
      `[backfill] [dry-run] [${result.network}] Scanned ${result.transfersProcessed} transfers → ` +
        `${result.totalSummaries} summary rows: ${result.changed} would change ` +
        `(${result.created} insert, ${result.updated} update, ${result.deleted} delete, ${result.unchanged} unchanged). ` +
        `No changes written.`
    );
  } else {
    console.log(
      `[backfill] [${result.network}] Done. Scanned ${result.transfersProcessed} transfers → ` +
        `${result.totalSummaries} summary rows: ${result.changed} changed ` +
        `(${result.created} inserted, ${result.updated} updated, ${result.deleted} deleted, ${result.unchanged} unchanged).`
    );
  }
}

main()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] Error: ${message}`);
    if (message.includes("--network") || message.includes("Unknown argument")) {
      console.error("\n" + USAGE);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
