/**
 * Batch-insert throughput benchmark (issue #107)
 *
 * Measures rows-per-second for upsertTransfers across different batch sizes,
 * and (issue #450) the time upsertAccountSummaries takes for a batch touching a
 * given number of distinct addresses.
 * Run:  npm run bench
 * Output: bench/results.json
 */
import { Bench } from "tinybench";
import { writeFileSync } from "fs";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma, upsertAccountSummaries } from "../src/db";
import type { TransferRecord } from "../src/db";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRecord(i: number, batchId: string): TransferRecord {
  return {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    eventType: "transfer",
    fromAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    toAddress:   "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWWHF",
    amount:      "10000000",
    ledger:      1000 + i,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash:      `bench-tx-${batchId}-${i}`,
    eventId:     `bench-${batchId}-${i}`,
  };
}

function makeBatch(size: number, batchId: string): TransferRecord[] {
  return Array.from({ length: size }, (_, i) => makeRecord(i, batchId));
}

/** A valid ed25519 public key that belongs to nobody, unique per `n`. */
function benchAddress(n: number): string {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(n, 0);
  return StrKey.encodeEd25519PublicKey(seed);
}

/** One outgoing transfer per distinct address, so the totals touch `size` pairs. */
function makeSummaryBatch(size: number, batchId: string): TransferRecord[] {
  return Array.from({ length: size }, (_, i) => ({
    ...makeRecord(i, batchId),
    fromAddress: benchAddress(i),
    toAddress: null,
  }));
}

// ── run ───────────────────────────────────────────────────────────────────────

async function main() {
  const BATCH_SIZES = [10, 100, 500, 1000, 5000];
  const ITERATIONS  = 5; // enough for stable numbers, keeps total time <1 min

  const bench = new Bench({ iterations: ITERATIONS });
  let callId = 0;

  for (const size of BATCH_SIZES) {
    bench.add(`upsertTransfers batch=${size}`, async () => {
      const id = `${size}-${callId++}`;
      await prisma.tokenTransfer.createMany({
        data: makeBatch(size, id),
        skipDuplicates: true,
      });
    });
  }

  // #450: one outgoing transfer per address, so the pair count equals `size`.
  const SUMMARY_SIZES = [100, 1000, 5000];
  for (const size of SUMMARY_SIZES) {
    bench.add(`upsertAccountSummaries addresses=${size}`, async () => {
      const id = `summary-${size}-${callId++}`;
      await upsertAccountSummaries(makeSummaryBatch(size, id));
    });
  }

  console.log("Running batch-insert benchmark…");
  await bench.run();

  const results = bench.tasks.map((t) => {
    // tinybench ≥3 nests stats under result.latency and result.throughput
    const r    = t.result as unknown as Record<string, unknown> | undefined;
    const lat  = (r?.latency  ?? {}) as Record<string, number>;
    const tput = (r?.throughput ?? {}) as Record<string, number>;
    const size = Number(t.name.match(/(?:batch|addresses)=(\d+)/)?.[1] ?? 0);
    const opsPerSec = tput.mean ?? 0;
    return {
      name:          t.name,
      batchSize:     size,
      opsPerSec:     parseFloat(opsPerSec.toFixed(4)),
      rowsPerSecond: parseFloat((opsPerSec * size).toFixed(2)),
      p50ms:         parseFloat((lat.p50 ?? 0).toFixed(3)),
      p99ms:         parseFloat((lat.p99 ?? 0).toFixed(3)),
      samples:       lat.samplesCount ?? 0,
    };
  });

  console.table(results.map(({ name, rowsPerSecond, p50ms, p99ms }) => ({
    name, rowsPerSecond, p50ms, p99ms,
  })));

  const output = { timestamp: new Date().toISOString(), results };
  writeFileSync("bench/results.json", JSON.stringify(output, null, 2));
  console.log("Results saved to bench/results.json");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
