/**
 * Data-retention pruning as its own job (#373).
 *
 * Uses an in-memory stand-in for the four prunable tables so deletes are
 * observable as statements, with no database.
 */

type Row = { id: number; network: string; ledgerClosedAt: Date };
type AnyRecord = Record<string, any>;

const TABLES = ["tokenTransfer", "nftTransfer", "hostFnLog", "lpShareTransfer"] as const;
const OLD = new Date("2020-01-01T00:00:00Z");
const FRESH = new Date();

const store: Record<string, Row[]> = {};
const statements: Array<{ table: string; network: unknown; ids: number }> = [];
let failTable: string | null = null;

function matches(row: Row, where: AnyRecord): boolean {
  return (
    row.network === where.network &&
    row.ledgerClosedAt < where.ledgerClosedAt.lt &&
    (!where.id || where.id.in.includes(row.id))
  );
}

function table(name: string) {
  return {
    findMany: async ({ where, take }: AnyRecord) => {
      if (failTable === name) throw new Error("postgres://user:secret@host/db exploded");
      return store[name].filter((r) => matches(r, where)).slice(0, take).map((r) => ({ id: r.id }));
    },
    deleteMany: async ({ where }: AnyRecord) => {
      const doomed = store[name].filter((r) => matches(r, where));
      statements.push({ table: name, network: where.network, ids: doomed.length });
      store[name] = store[name].filter((r) => !doomed.includes(r));
      return { count: doomed.length };
    },
  };
}

(globalThis as AnyRecord).prisma = Object.fromEntries(TABLES.map((t) => [t, table(t)]));

import { pruneNetwork, resolveRetentionDays, _resetRetentionWarning } from "../db";
import { runDataPruningJob, startDataPruningJob } from "../jobs/dataPruning";
import { _resetMetrics, renderMetrics } from "../metrics";

function seed(network: string, table: string, count: number, at: Date, start = 1) {
  for (let i = 0; i < count; i++) store[table].push({ id: start + i, network, ledgerClosedAt: at });
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
const ENV = ["NETWORKS", "STELLAR_NETWORK", "RETENTION_DAYS", "SKIP_INDEXER", "PRUNE_INTERVAL_MS"];

beforeEach(() => {
  for (const t of TABLES) store[t] = [];
  statements.length = 0;
  failTable = null;
  for (const k of ENV) delete process.env[k];
  _resetRetentionWarning();
  _resetMetrics();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe("batched deletes", () => {
  it("removes more rows than one batch over several statements", async () => {
    seed("testnet", "hostFnLog", 25, OLD);
    const result = await pruneNetwork("testnet", { batchSize: 10, pauseMs: 0 });

    expect(result.deleted.hostFnLogs).toBe(25);
    const stmts = statements.filter((s) => s.table === "hostFnLog");
    expect(stmts.map((s) => s.ids)).toEqual([10, 10, 5]);
    expect(store.hostFnLog).toHaveLength(0);
  });

  it("keeps rows inside the retention window", async () => {
    seed("testnet", "tokenTransfer", 3, OLD);
    seed("testnet", "tokenTransfer", 4, FRESH, 100);
    await pruneNetwork("testnet", { pauseMs: 0 });
    expect(store.tokenTransfer).toHaveLength(4);
  });

  it("stops at the time budget and reports the run as incomplete", async () => {
    seed("testnet", "hostFnLog", 50, OLD);
    const result = await pruneNetwork("testnet", { batchSize: 10, pauseMs: 0, budgetMs: 0 });
    expect(result.complete).toBe(false);
    expect(store.hostFnLog).toHaveLength(50);
  });
});

describe("network isolation", () => {
  it("never deletes another network's rows", async () => {
    for (const t of TABLES) {
      seed("testnet", t, 7, OLD);
      seed("mainnet", t, 7, OLD, 1000);
    }
    await pruneNetwork("testnet", { batchSize: 3, pauseMs: 0 });

    for (const t of TABLES) {
      expect(store[t].filter((r) => r.network === "testnet")).toHaveLength(0);
      expect(store[t].filter((r) => r.network === "mainnet")).toHaveLength(7);
    }
    expect(statements.every((s) => s.network === "testnet")).toBe(true);
  });
});

describe("the job", () => {
  it("prunes a network whose indexer loop never started, and with SKIP_INDEXER=true", async () => {
    process.env.NETWORKS = "testnet,mainnet";
    process.env.SKIP_INDEXER = "true";
    // No RPC URL is configured, so no loop exists for either network.
    seed("testnet", "hostFnLog", 5, OLD);
    seed("mainnet", "nftTransfer", 5, OLD);

    await runDataPruningJob({ pauseMs: 0 });

    expect(store.hostFnLog).toHaveLength(0);
    expect(store.nftTransfer).toHaveLength(0);
  });

  it("keeps going after one network fails, and only reports success for the other", async () => {
    process.env.NETWORKS = "testnet,mainnet";
    seed("mainnet", "lpShareTransfer", 2, OLD);
    failTable = "tokenTransfer";
    // Both networks hit the failing table first, so fail then recover per call.
    const original = (globalThis as AnyRecord).prisma.tokenTransfer.findMany;
    let calls = 0;
    (globalThis as AnyRecord).prisma.tokenTransfer.findMany = async (args: AnyRecord) => {
      calls += 1;
      if (calls === 1) return original(args);
      failTable = null;
      return original(args);
    };

    await expect(runDataPruningJob({ pauseMs: 0 })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    // Neither a connection string nor the raw error reaches the log.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret");
    const metrics = await renderMetrics();
    expect(metrics).toMatch(/prune_last_success_timestamp_seconds\{network="mainnet"\} \d/);
    expect(metrics).not.toMatch(/prune_last_success_timestamp_seconds\{network="testnet"\}/);
    (globalThis as AnyRecord).prisma.tokenTransfer.findMany = original;
  });

  it("exposes rows deleted and last success time in renderMetrics()", async () => {
    seed("testnet", "hostFnLog", 12, OLD);
    await runDataPruningJob({ batchSize: 5, pauseMs: 0 });

    const metrics = await renderMetrics();
    expect(metrics).toContain('prune_rows_deleted_total{network="testnet",table="hostFnLogs"} 12');
    expect(metrics).toMatch(/prune_last_success_timestamp_seconds\{network="testnet"\} \d/);
  });

  describe("scheduling", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("does not let two runs overlap", async () => {
      process.env.PRUNE_INTERVAL_MS = "1000";
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let started = 0;
      const original = (globalThis as AnyRecord).prisma.tokenTransfer.findMany;
      (globalThis as AnyRecord).prisma.tokenTransfer.findMany = async (args: AnyRecord) => {
        started += 1;
        await gate;
        return original(args);
      };

      const handle = startDataPruningJob();
      await jest.advanceTimersByTimeAsync(3500);
      expect(started).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("still in progress"));

      release();
      await jest.advanceTimersByTimeAsync(0);
      handle!.stop();
      (globalThis as AnyRecord).prisma.tokenTransfer.findMany = original;
    });

    it("returns a way to stop the timer", async () => {
      process.env.PRUNE_INTERVAL_MS = "1000";
      const handle = startDataPruningJob();
      await jest.advanceTimersByTimeAsync(0);
      handle!.stop();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});

describe("RETENTION_DAYS", () => {
  it.each(["abc", "", " ", "0", "-5", "1.5", "NaN", "99999", "30days"])(
    "falls back to 30 for %j",
    (raw) => {
      expect(resolveRetentionDays(raw)).toBe(30);
    }
  );

  it("accepts a valid value", () => {
    expect(resolveRetentionDays("7")).toBe(7);
  });

  it("warns once for a bad value, not on every run", () => {
    resolveRetentionDays("abc");
    resolveRetentionDays("abc");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("a bad value never deletes everything: fresh rows survive a run", async () => {
    process.env.RETENTION_DAYS = "0";
    seed("testnet", "tokenTransfer", 3, FRESH);
    await pruneNetwork("testnet", { pauseMs: 0 });
    expect(store.tokenTransfer).toHaveLength(3);
  });
});
