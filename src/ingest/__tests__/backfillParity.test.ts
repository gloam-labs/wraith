/**
 * Backfill vs. live indexer parity & notification suppression (#375).
 *
 * Verifies that:
 *  1. Running `runBackfill` across a ledger range produces the exact same rows
 *     in every table (TokenTransfer including SAC tags, NftTransfer including
 *     2-topic mint/burn and 4-topic transfer, NftMetadata, AccountSummary,
 *     HostFnLog, LpShareTransfer, TokenMetadata lookups) as `ingestWindow` on
 *     the live indexer for the same events.
 *  2. `--network mainnet` reads mainnet's RPC + watch list and tags every
 *     written row across every table with `"mainnet"`.
 *  3. Historical backfills suppress live `transferEmitter` and
 *     `hostFnLogEmitter` notifications by default, and emit them when
 *     `notifyLive: true` is passed explicitly.
 */

import { StrKey, Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { RawEvent } from "../../rpc";
import type { Network } from "../../network";
import type { BackfillCursorState } from "../../db";

type Row = Record<string, unknown>;

const mockStore = {
  transfers: new Map<string, Row>(),
  nftTransfers: new Map<string, Row>(),
  nftMetadata: new Map<string, Row>(),
  summaries: new Map<string, { network: Network; received: bigint; sent: bigint; txCount: number }>(),
  hostFn: new Map<string, Row>(),
  lp: new Map<string, Row>(),
  tokenMetadataLookups: new Set<string>(),
  backfillCursors: new Map<Network, BackfillCursorState>(),
  liveCursors: new Map<Network, number>(),
};

function mockResetStore(): void {
  mockStore.transfers.clear();
  mockStore.nftTransfers.clear();
  mockStore.nftMetadata.clear();
  mockStore.summaries.clear();
  mockStore.hostFn.clear();
  mockStore.lp.clear();
  mockStore.tokenMetadataLookups.clear();
  mockStore.backfillCursors.clear();
  mockStore.liveCursors.clear();
}

jest.mock("../../db", () => ({
  prisma: { $disconnect: jest.fn(async () => undefined) },
  getLastIndexedLedger: jest.fn(async (net: Network = "testnet") => mockStore.liveCursors.get(net) ?? null),
  setLastIndexedLedger: jest.fn(async (n: number, net: Network = "testnet") => {
    mockStore.liveCursors.set(net, n);
  }),
  pruneOldTransfers: jest.fn(async () => 0),
  getBackfillCursor: jest.fn(async (net: Network = "testnet") => mockStore.backfillCursors.get(net) ?? null),
  setBackfillCursor: jest.fn(async (c: BackfillCursorState, net: Network = "testnet") => {
    mockStore.backfillCursors.set(net, { ...c });
  }),
  clearBackfillCursor: jest.fn(async (net: Network = "testnet") => {
    mockStore.backfillCursors.delete(net);
  }),
  upsertTransfers: jest.fn(async (records: Row[], net: Network = "testnet") => {
    let added = 0;
    for (const r of records) {
      const key = `${net}:${String(r.eventId)}`;
      if (mockStore.transfers.has(key)) continue;
      mockStore.transfers.set(key, { ...r, network: net });
      added++;
    }
    return added;
  }),
  upsertAccountSummaries: jest.fn(async (records: Row[], net: Network = "testnet") => {
    for (const r of records) {
      for (const [address, side] of [[r.toAddress, "in"], [r.fromAddress, "out"]] as const) {
        if (!address) continue;
        const key = `${net}:${String(address)}:${String(r.contractId)}`;
        const s = mockStore.summaries.get(key) ?? {
          network: net,
          received: 0n,
          sent: 0n,
          txCount: 0,
        };
        if (side === "in") s.received += BigInt(String(r.amount));
        else s.sent += BigInt(String(r.amount));
        s.txCount++;
        mockStore.summaries.set(key, s);
      }
    }
  }),
  upsertNftTransfers: jest.fn(async (records: Row[], net: Network = "testnet") => {
    let added = 0;
    for (const r of records) {
      const key = `${net}:${String(r.eventId)}`;
      if (mockStore.nftTransfers.has(key)) continue;
      mockStore.nftTransfers.set(key, { ...r, network: net });
      added++;
    }
    return added;
  }),
  getNftMetadata: jest.fn(async (contractId: string, tokenId: string, net: Network = "testnet") =>
    mockStore.nftMetadata.get(`${net}:${contractId}:${tokenId}`) ?? null,
  ),
  upsertNftMetadata: jest.fn(
    async (contractId: string, tokenId: string, meta: Row, net: Network = "testnet") => {
      mockStore.nftMetadata.set(`${net}:${contractId}:${tokenId}`, {
        contractId,
        tokenId,
        network: net,
        ...meta,
      });
    },
  ),
}));

jest.mock("../../indexer/host-fn-log", () => ({
  ...jest.requireActual("../../indexer/host-fn-log"),
  upsertHostFnLogs: jest.fn(async (rows: Row[], net: Network = "testnet") => {
    for (const r of rows) {
      mockStore.hostFn.set(`${net}:${String(r.eventId)}`, {
        ...r,
        network: net,
        args: JSON.stringify(r.args),
        result: JSON.stringify(r.result),
        gasUsed: null,
      });
    }
  }),
}));

jest.mock("../../indexer/lp-shares", () => ({
  ...jest.requireActual("../../indexer/lp-shares"),
  loadKnownLpPools: jest.fn(async () => []),
  upsertLpShareTransfers: jest.fn(async (rows: Row[], net: Network = "testnet") => {
    let added = 0;
    for (const r of rows) {
      const key = `${net}:${String(r.eventId)}`;
      if (mockStore.lp.has(key)) continue;
      mockStore.lp.set(key, { ...r, network: net });
      added++;
    }
    return added;
  }),
}));

let mockSacA = "";
jest.mock("../../indexer/sac-detect", () => ({
  tagSacTransfers: jest.fn(
    async (records: Array<{ contractId: string; isSac?: boolean }>, _rpc?: unknown, net?: Network) => {
      for (const r of records) {
        r.isSac = r.contractId === mockSacA && (net === "testnet" || net === "mainnet");
      }
    },
  ),
}));

jest.mock("../../tokenCache", () => ({
  initTokenCache: jest.fn(async () => undefined),
  getTokenMetadata: jest.fn(async (contractId: string, net: Network = "testnet") => {
    mockStore.tokenMetadataLookups.add(`${net}:${contractId}`);
    return undefined;
  }),
}));

jest.mock("../../ingester/nft", () => ({
  ...jest.requireActual("../../ingester/nft"),
  fetchNftMetadata: jest.fn(async (contractId: string, _scVal: unknown, net: Network = "testnet") => ({
    name: `nft-${net}-${contractId.slice(-4)}`,
  })),
}));

const mockRequestedNetworks: Array<Network | undefined> = [];
let mockChainEvents: RawEvent[] = [];

jest.mock("../../rpc", () => ({
  ...jest.requireActual("../../rpc"),
  validateNetworkConfig: jest.fn((nets?: Network[]) => {
    if (nets) {
      for (const n of nets) {
        if (n === "mainnet" && !process.env.SOROBAN_RPC_URL_MAINNET) {
          throw new Error("SOROBAN_RPC_URL_MAINNET is required");
        }
      }
    }
  }),
}));

jest.mock("../../indexer/sources", () => ({
  createSourceSwitcherWithConfig: jest.fn((cfg: { network?: Network }) => ({
    getLatestLedger: async () => 1000,
    getActiveSourceName: async () => "rpc",
    fetchEvents: async (from: number, to: number, contractIds: string[]) => {
      mockRequestedNetworks.push(cfg.network);
      // Mirrors Soroban RPC: only returns events for requested contracts from `from` onwards.
      const events = mockChainEvents.filter(
        (e) => contractIds.includes(e.contractId) && e.ledger >= from && e.ledger <= to,
      );
      return { events, highestLedger: to };
    },
  })),
}));

import { createLoopState, ingestWindow } from "../../indexer";
import { runBackfill } from "../backfill";
import { transferEmitter, hostFnLogEmitter } from "../../events";

// Valid StrKeys generated from deterministic 32-byte buffers
const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const account = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));

const SAC_A = contract(1);
const SAC_B = contract(2);
const POOL = contract(3);
const NFT_C = contract(4);
const ADMIN = contract(5);
const UNWATCHED_CONTRACT = contract(9);
const ALICE = account(1);
const BOB = account(2);
mockSacA = SAC_A;

let seq = 0;
function ev(
  contractId: string,
  ledger: number,
  topic: RawEvent["topic"],
  value: RawEvent["value"],
): RawEvent {
  seq++;
  return {
    id: `${String(ledger).padStart(19, "0")}-${String(seq).padStart(5, "0")}`,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-01-15T00:00:00Z",
    contractId,
    txHash: `${ledger.toString(16).padStart(32, "0")}${seq.toString(16).padStart(32, "0")}`,
    topic,
    value,
  };
}

const sym = (s: string) => nativeToScVal(s, { type: "symbol" });
const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u32 = (n: number) => nativeToScVal(n, { type: "u32" });
const u128 = (n: bigint) => nativeToScVal(n, { type: "u128" });

function buildFixtureEvents(): RawEvent[] {
  seq = 0;
  return [
    // Fungible SAC transfer (tags isSac=true, updates AccountSummary, TokenMetadata, HostFnLog)
    ev(SAC_A, 10, [sym("transfer"), addr(ALICE), addr(BOB)], i128(250n)),
    // Fungible non-SAC transfer + mint
    ev(SAC_B, 11, [sym("transfer"), addr(BOB), addr(ALICE)], i128(90n)),
    ev(SAC_B, 12, [sym("mint"), addr(ADMIN), addr(ALICE)], i128(40n)),
    // 4-topic NFT transfers (two unique tokens 7 and 8, with token 7 transferred twice)
    ev(NFT_C, 13, [sym("transfer"), addr(ALICE), addr(BOB), u128(7n)], nativeToScVal(null)),
    ev(NFT_C, 14, [sym("transfer"), addr(ALICE), addr(BOB), u128(8n)], nativeToScVal(null)),
    ev(NFT_C, 15, [sym("transfer"), addr(BOB), addr(ALICE), u128(7n)], nativeToScVal(null)),
    // 2-topic NFT mint and burn (u32 token IDs — previously dropped by backfill's isNftTransferEvent)
    ev(NFT_C, 16, [sym("mint"), addr(ALICE)], u32(99)),
    ev(NFT_C, 17, [sym("burn"), addr(ALICE)], u32(99)),
    // LP pool explicit deposit followed by bare mint in a later chunk (knownLpPools propagation)
    ev(POOL, 18, [sym("deposit"), addr(ALICE)], i128(1000n)),
    ev(POOL, 21, [sym("mint"), addr(ADMIN), addr(BOB)], i128(500n)),
    // Event from an unwatched contract — neither path should request or store it
    ev(UNWATCHED_CONTRACT, 19, [sym("transfer"), addr(ALICE), addr(BOB)], i128(999n)),
  ];
}

function tableSnapshot() {
  const sorted = (m: Map<string, unknown>) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    transfers: sorted(mockStore.transfers),
    nftTransfers: sorted(mockStore.nftTransfers),
    nftMetadata: sorted(mockStore.nftMetadata),
    summaries: sorted(mockStore.summaries as unknown as Map<string, unknown>),
    hostFn: sorted(mockStore.hostFn),
    lp: sorted(mockStore.lp),
    tokenMetadataLookups: [...mockStore.tokenMetadataLookups].sort(),
  };
}

const ORIGINAL_ENV = process.env;

describe("backfill parity with live indexer & live notification control", () => {
  beforeEach(() => {
    mockResetStore();
    mockRequestedNetworks.length = 0;
    mockChainEvents = buildFixtureEvents();
    process.env = { ...ORIGINAL_ENV };
    process.env.STELLAR_NETWORK = "testnet";
    process.env.SAC_CONTRACT_IDS_TESTNET = [SAC_A, SAC_B, POOL].join(",");
    process.env.NFT_CONTRACT_IDS_TESTNET = NFT_C;
    delete process.env.SAC_CONTRACT_IDS_MAINNET;
    delete process.env.NFT_CONTRACT_IDS_MAINNET;
    delete process.env.SOROBAN_RPC_URL_MAINNET;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("validates all fixture contract and account StrKeys", () => {
    for (const id of [SAC_A, SAC_B, POOL, NFT_C, ADMIN, UNWATCHED_CONTRACT]) {
      expect(StrKey.isValidContract(id)).toBe(true);
    }
    for (const pk of [ALICE, BOB]) {
      expect(StrKey.isValidEd25519PublicKey(pk)).toBe(true);
    }
  });

  it("produces identical rows across every table as the live indexer for the same events", async () => {
    // 1. Run live indexer across [1, 50]
    const loop = createLoopState("testnet");
    await ingestWindow(loop, 1, 50, 1);
    const liveSnap = tableSnapshot();

    // Sanity-check that every record family actually populated
    expect(liveSnap.transfers).toHaveLength(4); // SAC_A transfer, SAC_B transfer+mint, POOL bare mint
    expect(liveSnap.nftTransfers).toHaveLength(5); // 3 transfers + 1 mint + 1 burn
    expect(liveSnap.nftMetadata).toHaveLength(3); // tokens 7, 8, and 99
    expect(liveSnap.summaries.length).toBeGreaterThan(0);
    expect(liveSnap.hostFn).toHaveLength(10); // all 10 watched events
    expect(liveSnap.lp).toHaveLength(2); // explicit deposit + learned-pool bare mint
    expect(liveSnap.tokenMetadataLookups).toEqual(
      [`testnet:${SAC_A}`, `testnet:${SAC_B}`, `testnet:${POOL}`].sort(),
    );

    // 2. Reset DB store and run backfill across [1, 50) in small chunks
    mockResetStore();
    await runBackfill({
      fromLedger: 1,
      toLedger: 50,
      chunkSize: 4,
      concurrency: 1,
      network: "testnet",
    });
    const backfillSnap = tableSnapshot();

    expect(backfillSnap).toEqual(liveSnap);
  });

  it("--network mainnet reads mainnet RPC/watch list and writes every row tagged mainnet", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    process.env.SOROBAN_RPC_URL_MAINNET = "https://rpc-mainnet.example.org";
    process.env.SAC_CONTRACT_IDS_MAINNET = [SAC_A, POOL].join(",");
    process.env.NFT_CONTRACT_IDS_MAINNET = NFT_C;
    // Give testnet a completely different watch list so reading the wrong env var would miss events
    process.env.SAC_CONTRACT_IDS_TESTNET = UNWATCHED_CONTRACT;
    delete process.env.NFT_CONTRACT_IDS_TESTNET;

    await runBackfill({
      fromLedger: 1,
      toLedger: 30,
      chunkSize: 15,
      concurrency: 2,
      network: "mainnet",
    });

    expect(mockRequestedNetworks.length).toBeGreaterThan(0);
    expect(mockRequestedNetworks.every((n) => n === "mainnet")).toBe(true);

    const snap = tableSnapshot();
    expect(snap.transfers.length).toBeGreaterThan(0);
    expect(snap.nftTransfers.length).toBeGreaterThan(0);
    expect(snap.nftMetadata.length).toBeGreaterThan(0);
    expect(snap.summaries.length).toBeGreaterThan(0);
    expect(snap.hostFn.length).toBeGreaterThan(0);
    expect(snap.lp.length).toBeGreaterThan(0);

    for (const [, row] of snap.transfers) expect((row as Row).network).toBe("mainnet");
    for (const [, row] of snap.nftTransfers) expect((row as Row).network).toBe("mainnet");
    for (const [, row] of snap.nftMetadata) expect((row as Row).network).toBe("mainnet");
    for (const [, row] of snap.summaries) expect((row as Row).network).toBe("mainnet");
    for (const [, row] of snap.hostFn) expect((row as Row).network).toBe("mainnet");
    for (const [, row] of snap.lp) expect((row as Row).network).toBe("mainnet");
    for (const key of snap.tokenMetadataLookups) expect(key.startsWith("mainnet:")).toBe(true);
  });

  it("suppresses live transfer and host-fn notifications by default, unless notifyLive is true", async () => {
    const emittedTransfers: unknown[] = [];
    const emittedHostFns: unknown[] = [];
    const onTransfer = (ev: unknown) => emittedTransfers.push(ev);
    const onHostFn = (ev: unknown) => emittedHostFns.push(ev);

    transferEmitter.on("transfer:new", onTransfer);
    hostFnLogEmitter.on("hostfnlog:new", onHostFn);

    try {
      // Default backfill: stores rows, emits zero live events
      await runBackfill({
        fromLedger: 1,
        toLedger: 30,
        chunkSize: 30,
        network: "testnet",
      });

      expect(mockStore.transfers.size).toBeGreaterThan(0);
      expect(mockStore.hostFn.size).toBeGreaterThan(0);
      expect(emittedTransfers).toHaveLength(0);
      expect(emittedHostFns).toHaveLength(0);

      // Opt-in notifyLive: emits live events for newly inserted records
      mockResetStore();
      await runBackfill({
        fromLedger: 1,
        toLedger: 30,
        chunkSize: 30,
        network: "testnet",
        notifyLive: true,
      });

      expect(emittedTransfers.length).toBe(mockStore.transfers.size);
      expect(emittedHostFns.length).toBe(mockStore.hostFn.size);
    } finally {
      transferEmitter.off("transfer:new", onTransfer);
      hostFnLogEmitter.off("hostfnlog:new", onHostFn);
    }
  });
});
