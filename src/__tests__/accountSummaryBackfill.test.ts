import { StrKey } from "@stellar/stellar-sdk";
import {
  DEFAULT_BACKFILL_BATCH_SIZE,
  TruncatedHistoryError,
  parseBackfillArgs,
  parseBackfillBatchSize,
  rebuildAccountSummaries,
  type BackfillPrismaClient,
  type BackfillTxClient,
} from "../accountSummaryBackfill";
import type { Network } from "../network";

const ALICE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const BOB = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const CAROL = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const CONTRACT_A = StrKey.encodeContract(Buffer.alloc(32, 10));
const CONTRACT_B = StrKey.encodeContract(Buffer.alloc(32, 11));

interface StoredTransfer {
  id: number;
  network: Network;
  contractId: string;
  fromAddress: string | null;
  toAddress: string | null;
  amount: string;
  ledgerClosedAt: Date;
}

interface StoredSummary {
  id: number;
  network: Network;
  address: string;
  contractId: string;
  totalSent: string;
  totalReceived: string;
  net: string;
  txCount: number;
  lastActivityAt: Date;
}

function createInMemoryBackfillDb(options?: {
  transfers?: StoredTransfer[];
  summaries?: StoredSummary[];
  onTransferPage?: () => void;
}) {
  let transfers: StoredTransfer[] = (options?.transfers ?? []).map((t) => ({ ...t }));
  let summaries: StoredSummary[] = (options?.summaries ?? []).map((s) => ({ ...s }));
  let nextSummaryId = summaries.reduce((m, s) => Math.max(m, s.id), 0) + 1;

  const findManyTransferCalls: Array<Record<string, unknown>> = [];
  const writeOps: Array<{ op: string; args: unknown }> = [];
  let transactionCount = 0;

  const makeTx = (targetSummaries: StoredSummary[]): BackfillTxClient => ({
    accountSummary: {
      async createMany(args) {
        writeOps.push({ op: "createMany", args });
        for (const row of args.data) {
          const dup = targetSummaries.find(
            (s) =>
              s.network === row.network &&
              s.address === row.address &&
              s.contractId === row.contractId
          );
          if (dup) {
            throw new Error(
              `Duplicate AccountSummary key (${row.network}, ${row.address}, ${row.contractId})`
            );
          }
          targetSummaries.push({ id: nextSummaryId++, ...row });
        }
        return { count: args.data.length };
      },
      async update(args) {
        writeOps.push({ op: "update", args });
        const row = targetSummaries.find((s) => s.id === args.where.id);
        if (!row) throw new Error(`Summary row ${args.where.id} not found`);
        Object.assign(row, args.data);
        return row;
      },
      async deleteMany(args) {
        writeOps.push({ op: "deleteMany", args });
        const ids = new Set(args.where.id.in);
        const before = targetSummaries.length;
        const kept = targetSummaries.filter(
          (s) => !(s.network === args.where.network && ids.has(s.id))
        );
        targetSummaries.length = 0;
        targetSummaries.push(...kept);
        return { count: before - targetSummaries.length };
      },
    },
  });

  const directTx = makeTx(summaries);

  const client: BackfillPrismaClient = {
    tokenTransfer: {
      async findFirst(args) {
        const matching = transfers
          .filter((t) => t.network === args.where.network)
          .sort((a, b) => a.ledgerClosedAt.getTime() - b.ledgerClosedAt.getTime() || a.id - b.id);
        return matching[0] ? { ledgerClosedAt: matching[0].ledgerClosedAt } : null;
      },
      async findMany(args) {
        findManyTransferCalls.push(args as unknown as Record<string, unknown>);
        options?.onTransferPage?.();
        const gt = args.where.id?.gt;
        return transfers
          .filter((t) => t.network === args.where.network && (gt === undefined || t.id > gt))
          .sort((a, b) => a.id - b.id)
          .slice(0, args.take)
          .map((t) => ({
            id: t.id,
            contractId: t.contractId,
            fromAddress: t.fromAddress,
            toAddress: t.toAddress,
            amount: t.amount,
            ledgerClosedAt: t.ledgerClosedAt,
          }));
      },
    },
    accountSummary: {
      ...directTx.accountSummary,
      async findFirst(args) {
        const matching = summaries
          .filter((s) => s.network === args.where.network)
          .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime() || a.id - b.id);
        return matching[0] ? { lastActivityAt: matching[0].lastActivityAt } : null;
      },
      async findMany(args) {
        return summaries
          .filter((s) => s.network === args.where.network)
          .map((s) => ({ ...s }));
      },
    },
    async $transaction(fn) {
      transactionCount++;
      // Stage writes into a clone and commit atomically on return (simulates DB MVCC).
      const staged = summaries.map((s) => ({ ...s }));
      const tx = makeTx(staged);
      const res = await fn(tx);
      summaries = staged;
      return res;
    },
  };

  return {
    client,
    getSummaries: (network?: Network) =>
      network ? summaries.filter((s) => s.network === network) : [...summaries],
    getTransfers: () => [...transfers],
    findManyTransferCalls,
    writeOps,
    getTransactionCount: () => transactionCount,
  };
}

describe("accountSummaryBackfill (#382)", () => {
  it("uses valid Stellar strkey test fixtures", () => {
    expect(StrKey.isValidEd25519PublicKey(ALICE)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(BOB)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(CAROL)).toBe(true);
    expect(StrKey.isValidContract(CONTRACT_A)).toBe(true);
    expect(StrKey.isValidContract(CONTRACT_B)).toBe(true);
  });

  it("rebuilds one network, sets the right network on new rows, and leaves the other network untouched", async () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-02T00:00:00Z");
    const mainnetExisting: StoredSummary = {
      id: 99,
      network: "mainnet",
      address: ALICE,
      contractId: CONTRACT_A,
      totalSent: "9000",
      totalReceived: "12000",
      net: "3000",
      txCount: 7,
      lastActivityAt: t1,
    };

    const db = createInMemoryBackfillDb({
      transfers: [
        { id: 1, network: "testnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "100", ledgerClosedAt: t1 },
        { id: 2, network: "mainnet", contractId: CONTRACT_A, fromAddress: CAROL, toAddress: ALICE, amount: "999999", ledgerClosedAt: t2 },
        { id: 3, network: "testnet", contractId: CONTRACT_A, fromAddress: null, toAddress: ALICE, amount: "250", ledgerClosedAt: t2 },
        { id: 4, network: "testnet", contractId: CONTRACT_B, fromAddress: BOB, toAddress: null, amount: "40", ledgerClosedAt: t2 },
      ],
      summaries: [mainnetExisting],
    });

    const result = await rebuildAccountSummaries(db.client, { network: "testnet" });

    expect(result).toEqual({
      network: "testnet",
      dryRun: false,
      transfersProcessed: 3,
      totalSummaries: 3,
      created: 3,
      updated: 0,
      deleted: 0,
      unchanged: 0,
      changed: 3,
    });

    // Mainnet row is completely untouched
    expect(db.getSummaries("mainnet")).toEqual([mainnetExisting]);

    // Testnet rows all carry network === "testnet" with accurate aggregates
    const testnetRows = db.getSummaries("testnet");
    expect(testnetRows).toHaveLength(3);
    for (const row of testnetRows) {
      expect(row.network).toBe("testnet");
    }

    const aliceA = testnetRows.find((r) => r.address === ALICE && r.contractId === CONTRACT_A);
    expect(aliceA).toMatchObject({
      network: "testnet",
      totalSent: "100",
      totalReceived: "250",
      net: "150",
      txCount: 2,
      lastActivityAt: t2,
    });

    const bobA = testnetRows.find((r) => r.address === BOB && r.contractId === CONTRACT_A);
    expect(bobA).toMatchObject({
      network: "testnet",
      totalSent: "0",
      totalReceived: "100",
      net: "100",
      txCount: 1,
      lastActivityAt: t1,
    });

    const bobB = testnetRows.find((r) => r.address === BOB && r.contractId === CONTRACT_B);
    expect(bobB).toMatchObject({
      network: "testnet",
      totalSent: "40",
      totalReceived: "0",
      net: "-40",
      txCount: 1,
      lastActivityAt: t2,
    });
  });

  it("pages transfers by id keyset without using skip", async () => {
    const t1 = new Date("2026-02-01T00:00:00Z");
    const db = createInMemoryBackfillDb({
      transfers: [
        { id: 10, network: "mainnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "10", ledgerClosedAt: t1 },
        { id: 25, network: "mainnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "20", ledgerClosedAt: t1 },
        { id: 31, network: "mainnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "30", ledgerClosedAt: t1 },
        { id: 44, network: "mainnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "40", ledgerClosedAt: t1 },
        { id: 58, network: "mainnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "50", ledgerClosedAt: t1 },
      ],
    });

    const progress: Array<{ processed: number; lastId: number }> = [];
    const result = await rebuildAccountSummaries(db.client, {
      network: "mainnet",
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    });

    expect(result.transfersProcessed).toBe(5);
    expect(progress).toEqual([
      { processed: 2, lastId: 25 },
      { processed: 4, lastId: 44 },
      { processed: 5, lastId: 58 },
    ]);

    // 4 findMany calls: id > undefined, id > 25, id > 44, id > 58 (empty)
    expect(db.findManyTransferCalls).toHaveLength(4);
    for (const call of db.findManyTransferCalls) {
      expect(call).not.toHaveProperty("skip");
      expect(call.orderBy).toEqual({ id: "asc" });
      expect(call.take).toBe(2);
    }
    expect((db.findManyTransferCalls[0].where as Record<string, unknown>).id).toBeUndefined();
    expect((db.findManyTransferCalls[1].where as Record<string, unknown>).id).toEqual({ gt: 25 });
    expect((db.findManyTransferCalls[2].where as Record<string, unknown>).id).toEqual({ gt: 44 });
    expect((db.findManyTransferCalls[3].where as Record<string, unknown>).id).toEqual({ gt: 58 });

    const alice = db.getSummaries("mainnet").find((r) => r.address === ALICE);
    expect(alice?.totalSent).toBe("150");
    expect(alice?.txCount).toBe(5);
  });

  it("refuses to shrink pruned history unless --accept-truncated-history is set", async () => {
    const prunedSummaryAt = new Date("2026-01-01T00:00:00Z");
    const oldestRemainingTransferAt = new Date("2026-02-01T00:00:00Z");

    const db = createInMemoryBackfillDb({
      transfers: [
        {
          id: 100,
          network: "testnet",
          contractId: CONTRACT_A,
          fromAddress: ALICE,
          toAddress: BOB,
          amount: "500",
          ledgerClosedAt: oldestRemainingTransferAt,
        },
      ],
      summaries: [
        {
          id: 1,
          network: "testnet",
          address: CAROL,
          contractId: CONTRACT_A,
          totalSent: "9000",
          totalReceived: "0",
          net: "-9000",
          txCount: 4,
          lastActivityAt: prunedSummaryAt,
        },
      ],
    });

    await expect(
      rebuildAccountSummaries(db.client, { network: "testnet" })
    ).rejects.toThrow(TruncatedHistoryError);

    await expect(
      rebuildAccountSummaries(db.client, { network: "testnet" })
    ).rejects.toThrow(/--accept-truncated-history/);

    // Nothing modified when refused
    expect(db.writeOps).toHaveLength(0);
    expect(db.getSummaries("testnet")).toHaveLength(1);
    expect(db.getSummaries("testnet")[0].address).toBe(CAROL);

    // Allowed when explicitly opted in
    const res = await rebuildAccountSummaries(db.client, {
      network: "testnet",
      acceptTruncatedHistory: true,
    });
    expect(res).toMatchObject({ created: 2, updated: 0, deleted: 1, changed: 3 });
    expect(db.getSummaries("testnet").map((s) => s.address).sort()).toEqual([ALICE, BOB].sort());
  });

  it("refuses when all transfers for the network were pruned while summaries still exist", async () => {
    const db = createInMemoryBackfillDb({
      transfers: [],
      summaries: [
        {
          id: 1,
          network: "mainnet",
          address: ALICE,
          contractId: CONTRACT_A,
          totalSent: "100",
          totalReceived: "0",
          net: "-100",
          txCount: 1,
          lastActivityAt: new Date("2026-01-10T00:00:00Z"),
        },
      ],
    });

    await expect(
      rebuildAccountSummaries(db.client, { network: "mainnet" })
    ).rejects.toThrow(/no TokenTransfer rows remain for mainnet/i);
    expect(db.writeOps).toHaveLength(0);
  });

  it("--dry-run computes row changes and writes nothing", async () => {
    const t1 = new Date("2026-03-01T00:00:00Z");
    const t2 = new Date("2026-03-02T00:00:00Z");
    const db = createInMemoryBackfillDb({
      transfers: [
        { id: 1, network: "testnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "100", ledgerClosedAt: t1 },
        { id: 2, network: "testnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "50", ledgerClosedAt: t2 },
      ],
      summaries: [
        // Unchanged
        {
          id: 1,
          network: "testnet",
          address: ALICE,
          contractId: CONTRACT_A,
          totalSent: "150",
          totalReceived: "0",
          net: "-150",
          txCount: 2,
          lastActivityAt: t2,
        },
        // Stale wrong totals -> should count as update
        {
          id: 2,
          network: "testnet",
          address: BOB,
          contractId: CONTRACT_A,
          totalSent: "0",
          totalReceived: "999",
          net: "999",
          txCount: 1,
          lastActivityAt: t2,
        },
        // Orphaned row -> should count as delete
        {
          id: 3,
          network: "testnet",
          address: CAROL,
          contractId: CONTRACT_A,
          totalSent: "10",
          totalReceived: "0",
          net: "-10",
          txCount: 1,
          lastActivityAt: t2,
        },
      ],
    });

    const before = db.getSummaries("testnet");
    const result = await rebuildAccountSummaries(db.client, {
      network: "testnet",
      dryRun: true,
    });

    expect(result).toEqual({
      network: "testnet",
      dryRun: true,
      transfersProcessed: 2,
      totalSummaries: 2,
      created: 0,
      updated: 1,
      deleted: 1,
      unchanged: 1,
      changed: 2,
    });
    expect(db.getTransactionCount()).toBe(0);
    expect(db.writeOps).toHaveLength(0);
    expect(db.getSummaries("testnet")).toEqual(before);
  });

  it("never leaves AccountSummary empty for concurrent readers during a rebuild", async () => {
    const t1 = new Date("2026-04-01T00:00:00Z");
    const observedCountsDuringScan: number[] = [];

    const db = createInMemoryBackfillDb({
      transfers: [
        { id: 1, network: "testnet", contractId: CONTRACT_A, fromAddress: ALICE, toAddress: BOB, amount: "100", ledgerClosedAt: t1 },
        { id: 2, network: "testnet", contractId: CONTRACT_A, fromAddress: BOB, toAddress: CAROL, amount: "200", ledgerClosedAt: t1 },
      ],
      summaries: [
        {
          id: 1,
          network: "testnet",
          address: ALICE,
          contractId: CONTRACT_A,
          totalSent: "50",
          totalReceived: "0",
          net: "-50",
          txCount: 1,
          lastActivityAt: t1,
        },
      ],
      onTransferPage: () => {
        observedCountsDuringScan.push(db.getSummaries("testnet").length);
      },
    });

    await rebuildAccountSummaries(db.client, { network: "testnet", batchSize: 1 });

    // Every transfer page scan still sees the existing summary rows intact
    expect(observedCountsDuringScan.length).toBeGreaterThan(0);
    expect(observedCountsDuringScan.every((count) => count > 0)).toBe(true);

    // No blanket wipe occurred; writes ran inside one transaction
    expect(db.getTransactionCount()).toBe(1);
    const deleteCalls = db.writeOps.filter((w) => w.op === "deleteMany");
    expect(deleteCalls).toHaveLength(0);
    expect(db.getSummaries("testnet")).toHaveLength(3);
  });
});

describe("parseBackfillArgs & parseBackfillBatchSize", () => {
  it("requires --network and accepts testnet/mainnet in either flag form", () => {
    expect(() => parseBackfillArgs([], {})).toThrow(/--network/);
    expect(() => parseBackfillArgs(["--network", "futurenet"], {})).toThrow(/Invalid --network/);

    expect(parseBackfillArgs(["--network", "testnet"], {})).toEqual({
      help: false,
      network: "testnet",
      dryRun: false,
      acceptTruncatedHistory: false,
      batchSize: DEFAULT_BACKFILL_BATCH_SIZE,
    });

    expect(
      parseBackfillArgs(
        ["--network=MAINNET", "--dry-run", "--accept-truncated-history", "--batch-size=250"],
        {}
      )
    ).toEqual({
      help: false,
      network: "mainnet",
      dryRun: true,
      acceptTruncatedHistory: true,
      batchSize: 250,
    });
  });

  it("validates BACKFILL_BATCH_SIZE and --batch-size strictly", () => {
    expect(parseBackfillBatchSize(undefined)).toBe(5000);
    expect(parseBackfillBatchSize("")).toBe(5000);
    expect(parseBackfillBatchSize(" 1000 ")).toBe(1000);

    for (const bad of ["0", "-10", "12.5", "abc"]) {
      expect(() => parseBackfillBatchSize(bad)).toThrow(/Invalid BACKFILL_BATCH_SIZE/);
    }
    expect(() => parseBackfillArgs(["--network", "testnet"], { BACKFILL_BATCH_SIZE: "nope" })).toThrow(
      /Invalid BACKFILL_BATCH_SIZE/
    );
    expect(() => parseBackfillArgs(["--network", "testnet", "--bogus"], {})).toThrow(/Unknown argument/);
  });
});
