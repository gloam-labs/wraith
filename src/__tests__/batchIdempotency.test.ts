/**
 * Replay idempotency for AccountSummary updates and live transfer broadcasts (#367).
 *
 * `processEventBatch` previously checked `if (inserted > 0)` and then passed the
 * entire input `records` array to `upsertAccountSummaries` and `emitTransfer`.
 * Any overlapping batch containing at least one new transfer alongside already-
 * indexed transfers therefore double-counted those existing transfers in
 * `AccountSummary` and re-emitted them on `transfer:new` (triggering duplicate
 * WebSocket, GraphQL subscription, and webhook deliveries).
 *
 * This suite exercises the real `upsertTransfersReturning` (against a Prisma
 * client mock enforcing `(network, eventId)` uniqueness just like Postgres
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING "eventId"`), the real
 * `processEventBatch`, the real `pollParallel` dispatcher, and the real
 * `transferEmitter`.
 */

import { StrKey, Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { RawEvent } from "../rpc";
import type { Network } from "../network";
import type { TransferEvent } from "../events";

type SummaryEntry = {
  network: Network;
  sent: bigint;
  received: bigint;
  txCount: number;
};

type CreateManyAndReturnArgs = {
  data: Array<{ network: string; eventId: string } & Record<string, unknown>>;
  skipDuplicates?: boolean;
  select?: { eventId?: boolean };
};

const mockTransfersTable = new Map<string, Record<string, unknown>>();
const mockAccountSummaries = new Map<string, SummaryEntry>();
const mockCreateManyAndReturnCalls: CreateManyAndReturnArgs[] = [];

const mockCreateManyAndReturn = jest.fn(async (args: CreateManyAndReturnArgs) => {
  mockCreateManyAndReturnCalls.push(args);
  const inserted: Array<{ eventId: string }> = [];
  for (const row of args.data) {
    const key = `${row.network}:${row.eventId}`;
    if (mockTransfersTable.has(key)) {
      if (args.skipDuplicates) continue;
      throw new Error(`Unique constraint failed on (network, eventId): ${key}`);
    }
    mockTransfersTable.set(key, { ...row });
    inserted.push({ eventId: row.eventId });
  }
  return inserted;
});

type SqlLike = { strings: readonly string[]; values: unknown[] };

/**
 * Mirror the arithmetic of `upsertAccountSummaries` in src/db.ts for one row.
 * The bound parameters of a row are: networkName, address, contractId,
 * totalSent, totalReceived, net, txCount, lastActivityAt (`net` and
 * `lastActivityAt` are recomputed or compared, never accumulated).
 */
function applySummaryRow(values: unknown[]) {
  const [networkName, address, contractId, sentStr, receivedStr, , count] = values as [
    Network,
    string,
    string,
    string,
    string,
    string,
    number,
  ];
  const key = `${networkName}:${address}:${contractId}`;
  const prev = mockAccountSummaries.get(key) ?? {
    network: networkName,
    sent: 0n,
    received: 0n,
    txCount: 0,
  };
  mockAccountSummaries.set(key, {
    network: networkName,
    sent: prev.sent + BigInt(sentStr),
    received: prev.received + BigInt(receivedStr),
    txCount: prev.txCount + count,
  });
}

const mockExecuteRaw = jest.fn(async (query: unknown) => {
  // Since #450 the totals go out as one multi-row statement per chunk: the
  // statement binds the row list, and each row is its own Prisma.Sql carrying
  // that row's parameters. Anything else is treated as a single flat row.
  const statement = (query ?? {}) as SqlLike;
  const bound = Array.isArray(statement.values) ? statement.values : [];
  const batch = bound[0];
  const rows: Array<{ values: unknown[] }> = Array.isArray(batch)
    ? (batch as Array<{ values: unknown[] }>)
    : [{ values: bound }];

  for (const row of rows) applySummaryRow(row.values);
  return rows.length;
});

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    tokenTransfer: {
      createManyAndReturn: mockCreateManyAndReturn,
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    nftTransfer: {
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    nftMetadata: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => undefined),
    },
    indexerState: {
      upsert: jest.fn(async () => undefined),
    },
    // The batch upsert wraps every chunk in one transaction (#450).
    $transaction: jest.fn((ops: unknown) =>
      Array.isArray(ops) ? Promise.all(ops) : Promise.reject(new Error("interactive transaction not mocked"))
    ),
    $executeRaw: mockExecuteRaw,
    $queryRaw: jest.fn(async () => []),
    $on: jest.fn(),
  })),
  Prisma: {
    sql: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    join: jest.fn((arr: unknown[]) => arr),
    empty: "",
  },
}));

jest.mock("../indexer/sac-detect", () => ({
  tagSacTransfers: jest.fn(async () => undefined),
}));

jest.mock("../tokenCache", () => ({
  getTokenMetadata: jest.fn(async () => undefined),
}));

jest.mock("../indexer/host-fn-log", () => ({
  ...jest.requireActual("../indexer/host-fn-log"),
  upsertHostFnLogs: jest.fn(async () => 0),
}));

jest.mock("../indexer/lp-shares", () => ({
  ...jest.requireActual("../indexer/lp-shares"),
  upsertLpShareTransfers: jest.fn(async () => 0),
}));

import { processEventBatch } from "../indexer/batch";
import { partitionByContract, pollParallel } from "../indexer/parallel";
import { upsertTransfersReturning, type TransferRecord } from "../db";
import { transferEmitter } from "../events";

const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const account = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));

const CONTRACT_A = contract(1);
// Pick a second valid contract ID that hashes into the opposite shard under
// partitionByContract(..., 2) so the parallel test genuinely runs two workers.
const CONTRACT_B = (() => {
  for (let i = 2; i < 64; i++) {
    const candidate = contract(i);
    if (partitionByContract([CONTRACT_A, candidate], 2).length === 2) return candidate;
  }
  throw new Error("Could not find two contracts in distinct partitions");
})();
const ALICE = account(41);
const BOB = account(42);
const CAROL = account(43);

const sym = (s: string) => nativeToScVal(s, { type: "symbol" });
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });

function makeTransferEvent(
  eventId: string,
  contractId: string,
  from: string,
  to: string,
  amount: bigint,
  ledger: number,
): RawEvent {
  return {
    id: eventId,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-01-15T00:00:00Z",
    contractId,
    txHash: `tx-${eventId}`,
    topic: [sym("transfer"), addr(from), addr(to)],
    value: i128(amount),
  };
}

describe("processEventBatch replay idempotency (#367)", () => {
  const emitted: TransferEvent[] = [];
  const onTransfer = (ev: TransferEvent) => {
    emitted.push(ev);
  };

  beforeEach(() => {
    mockTransfersTable.clear();
    mockAccountSummaries.clear();
    mockCreateManyAndReturnCalls.length = 0;
    mockCreateManyAndReturn.mockClear();
    mockExecuteRaw.mockClear();
    emitted.length = 0;
    transferEmitter.on("transfer:new", onTransfer);
  });

  afterEach(() => {
    transferEmitter.off("transfer:new", onTransfer);
  });

  it("replaying an identical batch leaves AccountSummary unchanged and emits no duplicate events", async () => {
    const batch = [
      makeTransferEvent("0000100-00001", CONTRACT_A, ALICE, BOB, 100n, 100),
      makeTransferEvent("0000101-00001", CONTRACT_A, BOB, CAROL, 40n, 101),
    ];
    const ctx = { network: "testnet" as const, knownLpPools: new Set<string>() };

    const first = await processEventBatch(batch, ctx);
    expect(first.fungibleInserted).toBe(2);
    expect(emitted.map((e) => e.eventId)).toEqual(["0000100-00001", "0000101-00001"]);

    const aliceBefore = { ...mockAccountSummaries.get(`testnet:${ALICE}:${CONTRACT_A}`)! };
    const bobBefore = { ...mockAccountSummaries.get(`testnet:${BOB}:${CONTRACT_A}`)! };
    const carolBefore = { ...mockAccountSummaries.get(`testnet:${CAROL}:${CONTRACT_A}`)! };
    expect(aliceBefore).toEqual({ network: "testnet", sent: 100n, received: 0n, txCount: 1 });
    expect(bobBefore).toEqual({ network: "testnet", sent: 40n, received: 100n, txCount: 2 });
    expect(carolBefore).toEqual({ network: "testnet", sent: 0n, received: 40n, txCount: 1 });

    emitted.length = 0;
    mockExecuteRaw.mockClear();

    // Replay the exact same batch: zero new rows, zero summary writes, zero events.
    const second = await processEventBatch(batch, ctx);
    expect(second.fungibleInserted).toBe(0);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
    expect(mockAccountSummaries.get(`testnet:${ALICE}:${CONTRACT_A}`)).toEqual(aliceBefore);
    expect(mockAccountSummaries.get(`testnet:${BOB}:${CONTRACT_A}`)).toEqual(bobBefore);
    expect(mockAccountSummaries.get(`testnet:${CAROL}:${CONTRACT_A}`)).toEqual(carolBefore);
  });

  it("updates AccountSummary and emits transfer:new ONLY for the new record in a mixed (existing + new) batch", async () => {
    // Regression test for #367: on main this fails because `inserted > 0` forwarded
    // the entire `records` array (including the already-indexed eventA) to
    // `upsertAccountSummaries` and `emitTransfer`, leaving ALICE with sent=450, txCount=3
    // and emitting `eventA` twice.
    const eventA = makeTransferEvent("0000200-00001", CONTRACT_A, ALICE, BOB, 100n, 200);
    const eventB = makeTransferEvent("0000201-00001", CONTRACT_A, ALICE, BOB, 250n, 201);
    const ctx = { network: "testnet" as const, knownLpPools: new Set<string>() };

    // Pass 1: ingest eventA alone.
    const pass1 = await processEventBatch([eventA], ctx);
    expect(pass1.fungibleInserted).toBe(1);
    expect(emitted.map((e) => e.eventId)).toEqual([eventA.id]);

    emitted.length = 0;

    // Pass 2: replay eventA alongside a new eventB in the same batch.
    const pass2 = await processEventBatch([eventA, eventB], ctx);
    expect(pass2.fungibleInserted).toBe(1);

    // AccountSummary must reflect eventA + eventB exactly once (100 + 250 = 350, txCount = 2).
    expect(mockAccountSummaries.get(`testnet:${ALICE}:${CONTRACT_A}`)).toEqual({
      network: "testnet",
      sent: 350n,
      received: 0n,
      txCount: 2,
    });
    expect(mockAccountSummaries.get(`testnet:${BOB}:${CONTRACT_A}`)).toEqual({
      network: "testnet",
      sent: 0n,
      received: 350n,
      txCount: 2,
    });

    // Live subscribers must receive ONLY eventB, never a duplicate of eventA.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].eventId).toBe(eventB.id);
    expect(emitted[0].amount).toBe("250");
    expect(emitted[0].network).toBe("testnet");
  });

  it("uses a single createManyAndReturn query with skipDuplicates, deduplicates within-batch duplicates, and isolates networks", async () => {
    const duplicateInBatch = makeTransferEvent("0000300-00001", CONTRACT_A, ALICE, BOB, 75n, 300);
    const testnetCtx = { network: "testnet" as const, knownLpPools: new Set<string>() };
    const mainnetCtx = { network: "mainnet" as const, knownLpPools: new Set<string>() };

    // Same eventId appearing twice in one batch must only insert, summarize, and emit once.
    const resTestnet = await processEventBatch([duplicateInBatch, duplicateInBatch], testnetCtx);
    expect(resTestnet.fungibleInserted).toBe(1);
    expect(mockCreateManyAndReturnCalls).toHaveLength(1);
    expect(mockCreateManyAndReturnCalls[0].skipDuplicates).toBe(true);
    expect(mockCreateManyAndReturnCalls[0].select).toEqual({ eventId: true });
    expect(mockAccountSummaries.get(`testnet:${ALICE}:${CONTRACT_A}`)).toEqual({
      network: "testnet",
      sent: 75n,
      received: 0n,
      txCount: 1,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].network).toBe("testnet");

    emitted.length = 0;

    // The same eventId on mainnet is distinct under `(network, eventId)` and must insert cleanly.
    const resMainnet = await processEventBatch([duplicateInBatch], mainnetCtx);
    expect(resMainnet.fungibleInserted).toBe(1);
    expect(mockAccountSummaries.get(`mainnet:${ALICE}:${CONTRACT_A}`)).toEqual({
      network: "mainnet",
      sent: 75n,
      received: 0n,
      txCount: 1,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].network).toBe("mainnet");
  });

  it("keeps the sharded pollParallel path idempotent across overlapping replays", async () => {
    const evA1 = makeTransferEvent("0000400-00001", CONTRACT_A, ALICE, BOB, 120n, 400);
    const evB1 = makeTransferEvent("0000400-00002", CONTRACT_B, BOB, CAROL, 60n, 400);
    const evA2 = makeTransferEvent("0000401-00001", CONTRACT_A, ALICE, BOB, 80n, 401);
    const knownLpPools = new Set<string>();
    let fetchCalls = 0;

    const runWindow = (sourceEvents: RawEvent[]) =>
      pollParallel([CONTRACT_A, CONTRACT_B], 400, 401, 1000, 2, "testnet", {
        fetchEvents: async (_from, _to, ids) => {
          fetchCalls++;
          return {
            events: sourceEvents.filter((e) => ids.includes(e.contractId)),
            highestLedger: 401,
          };
        },
        processBatch: (events) =>
          processEventBatch(events, { network: "testnet", knownLpPools }),
      });

    // Pass 1: ingest evA1 and evB1 across two contract shards.
    const firstRun = await runWindow([evA1, evB1]);
    expect(fetchCalls).toBe(2);
    expect(firstRun.totalInserted).toBe(2);
    expect(emitted.map((e) => e.eventId).sort()).toEqual([evA1.id, evB1.id].sort());

    emitted.length = 0;

    // Pass 2: replay evA1 and evB1 together with one new event evA2.
    const secondRun = await runWindow([evA1, evB1, evA2]);
    expect(secondRun.totalInserted).toBe(1);
    expect(emitted.map((e) => e.eventId)).toEqual([evA2.id]);
    expect(mockAccountSummaries.get(`testnet:${ALICE}:${CONTRACT_A}`)).toEqual({
      network: "testnet",
      sent: 200n,
      received: 0n,
      txCount: 2,
    });
    expect(mockAccountSummaries.get(`testnet:${BOB}:${CONTRACT_B}`)).toEqual({
      network: "testnet",
      sent: 60n,
      received: 0n,
      txCount: 1,
    });
  });

  it("upsertTransfersReturning returns [] without querying Prisma on empty input", async () => {
    const result: TransferRecord[] = await upsertTransfersReturning([], "testnet");
    expect(result).toEqual([]);
    expect(mockCreateManyAndReturn).not.toHaveBeenCalled();
  });
});
