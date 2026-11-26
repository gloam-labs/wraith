import { StrKey } from "@stellar/stellar-sdk";

const mockFetchEvents = jest.fn(async () => ({ events: [], highestLedger: 0 }));

jest.mock("../../indexer/sources", () => ({
  createSourceSwitcherWithConfig: jest.fn(() => ({
    getLatestLedger: jest.fn(),
    fetchEvents: mockFetchEvents,
    getActiveSourceName: jest.fn(),
  })),
}));

jest.mock("../../rpc", () => ({
  validateNetworkConfig: jest.fn(),
  fetchEventsSafe: jest.fn(),
  getLatestLedger: jest.fn(),
}));

jest.mock("../../db", () => ({
  getBackfillCursor: jest.fn(),
  setBackfillCursor: jest.fn(),
  clearBackfillCursor: jest.fn(),
  upsertTransfers: jest.fn(async () => 0),
  upsertAccountSummaries: jest.fn(async () => undefined),
  upsertNftTransfers: jest.fn(async () => 0),
  getNftMetadata: jest.fn(async () => null),
  upsertNftMetadata: jest.fn(async () => undefined),
  getLastIndexedLedger: jest.fn(),
  setLastIndexedLedger: jest.fn(),
  prisma: { $disconnect: jest.fn() },
}));

jest.mock("../../indexer/lp-shares", () => ({
  ...jest.requireActual("../../indexer/lp-shares"),
  loadKnownLpPools: jest.fn(async () => []),
  upsertLpShareTransfers: jest.fn(async () => 0),
}));

jest.mock("../../tokenCache", () => ({
  initTokenCache: jest.fn(async () => undefined),
  getTokenMetadata: jest.fn(async () => undefined),
}));

import { chunkRange, resolveBackfillContractIds, runBackfill } from "../backfill";
import { USAGE, parseArgs, resolveCliBackfillFlags } from "../../cli";
import { createSourceSwitcherWithConfig } from "../../indexer/sources";
import { validateNetworkConfig } from "../../rpc";
import {
  getBackfillCursor,
  setBackfillCursor,
  clearBackfillCursor,
  upsertTransfers,
  type BackfillCursorState,
} from "../../db";
import { DEFAULT_XLM_SAC_TESTNET } from "../../indexer";
import type { Network } from "../../network";

const mockGetBackfillCursor = getBackfillCursor as jest.MockedFunction<typeof getBackfillCursor>;
const mockSetBackfillCursor = setBackfillCursor as jest.MockedFunction<typeof setBackfillCursor>;
const mockClearBackfillCursor = clearBackfillCursor as jest.MockedFunction<typeof clearBackfillCursor>;
const mockUpsertTransfers = upsertTransfers as jest.MockedFunction<typeof upsertTransfers>;
const mockValidateNetworkConfig = validateNetworkConfig as jest.MockedFunction<typeof validateNetworkConfig>;
const mockCreateSourceSwitcher = createSourceSwitcherWithConfig as jest.MockedFunction<
  typeof createSourceSwitcherWithConfig
>;

const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const MAINNET_SAC = contract(11);
const MAINNET_NFT = contract(12);
const OVERRIDE_A = contract(21);
const OVERRIDE_B = contract(22);

const ORIGINAL_ENV = process.env;

describe("chunkRange", () => {
  it("splits a range into equal-sized chunks", () => {
    const result = chunkRange(1, 10, 3);
    expect(result).toEqual([
      { start: 1, end: 4 },
      { start: 4, end: 7 },
      { start: 7, end: 10 },
    ]);
  });

  it("returns a single chunk when range fits in one", () => {
    const result = chunkRange(100, 105, 10);
    expect(result).toEqual([{ start: 100, end: 105 }]);
  });

  it("returns empty array for empty range", () => {
    expect(chunkRange(10, 10, 5)).toEqual([]);
    expect(chunkRange(10, 5, 5)).toEqual([]);
  });

  it("handles exact multiples", () => {
    const result = chunkRange(0, 100, 25);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ start: 0, end: 25 });
    expect(result[3]).toEqual({ start: 75, end: 100 });
  });

  it("handles chunkSize of 1", () => {
    const result = chunkRange(5, 8, 1);
    expect(result).toEqual([
      { start: 5, end: 6 },
      { start: 6, end: 7 },
      { start: 7, end: 8 },
    ]);
  });
});

describe("runBackfill", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    process.env.STELLAR_NETWORK = "testnet";
    delete process.env.SAC_CONTRACT_IDS;
    delete process.env.SAC_CONTRACT_IDS_TESTNET;
    delete process.env.SAC_CONTRACT_IDS_MAINNET;
    delete process.env.NFT_CONTRACT_IDS;
    delete process.env.NFT_CONTRACT_IDS_TESTNET;
    delete process.env.NFT_CONTRACT_IDS_MAINNET;
    delete process.env.CONTRACT_IDS;
    delete process.env.HORIZON_URL;
    delete process.env.HORIZON_URL_TESTNET;
    delete process.env.HORIZON_URL_MAINNET;
    mockFetchEvents.mockResolvedValue({ events: [], highestLedger: 0 });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("uses valid contract StrKeys in test fixtures", () => {
    for (const id of [MAINNET_SAC, MAINNET_NFT, OVERRIDE_A, OVERRIDE_B, DEFAULT_XLM_SAC_TESTNET]) {
      expect(StrKey.isValidContract(id)).toBe(true);
    }
  });

  it("clears cursor when range is already complete", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 200,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 100, toLedger: 200 });

    expect(mockGetBackfillCursor).toHaveBeenCalledWith("testnet");
    expect(mockClearBackfillCursor).toHaveBeenCalledWith("testnet");
    expect(mockSetBackfillCursor).not.toHaveBeenCalled();
  });

  it("resumes from cursor when range matches", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 150,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 100, toLedger: 200, chunkSize: 64 });

    const expectedChunks = chunkRange(150, 200, 64);
    expect(expectedChunks).toHaveLength(1);
    expect(expectedChunks[0]).toEqual({ start: 150, end: 200 });

    expect(mockSetBackfillCursor).toHaveBeenCalled();
    const lastCall = mockSetBackfillCursor.mock.calls[mockSetBackfillCursor.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({
      startLedger: 100,
      endLedger: 200,
      nextLedger: 200,
    });
    expect(lastCall[1]).toBe("testnet");
  });

  it("respects force flag to override existing cursor", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 180,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 300, toLedger: 400, force: true });

    expect(mockSetBackfillCursor).toHaveBeenCalled();
    const lastCall = mockSetBackfillCursor.mock.calls[mockSetBackfillCursor.mock.calls.length - 1];
    expect(lastCall[0]).toEqual({
      startLedger: 300,
      endLedger: 400,
      nextLedger: 400,
    });
    expect(lastCall[1]).toBe("testnet");
    expect(mockClearBackfillCursor).toHaveBeenCalledWith("testnet");
  });

  it("does not process if cursor range differs without force", async () => {
    const cursor: BackfillCursorState = {
      startLedger: 100,
      endLedger: 200,
      nextLedger: 150,
    };
    mockGetBackfillCursor.mockResolvedValue(cursor);

    await runBackfill({ fromLedger: 300, toLedger: 400, force: false });

    expect(mockUpsertTransfers).not.toHaveBeenCalled();
    expect(mockClearBackfillCursor).not.toHaveBeenCalled();
  });

  it("starts fresh when no cursor exists", async () => {
    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({ fromLedger: 1, toLedger: 10, chunkSize: 10 });

    expect(mockSetBackfillCursor).toHaveBeenCalledWith(
      { startLedger: 1, endLedger: 10, nextLedger: 10 },
      "testnet",
    );
  });

  it("aborts cleanly when signal is received", async () => {
    mockGetBackfillCursor.mockResolvedValue(null);
    const signal = AbortSignal.abort();

    await runBackfill({ fromLedger: 1, toLedger: 1000, chunkSize: 10, signal });

    expect(mockUpsertTransfers).not.toHaveBeenCalled();
  });

  it("does not call IndexerState functions", async () => {
    const { getLastIndexedLedger, setLastIndexedLedger } = await import("../../db");

    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({ fromLedger: 1, toLedger: 10, chunkSize: 10 });

    expect(getLastIndexedLedger).not.toHaveBeenCalled();
    expect(setLastIndexedLedger).not.toHaveBeenCalled();
  });

  it("reads and writes the backfill cursor strictly for the chosen network", async () => {
    process.env.SAC_CONTRACT_IDS_MAINNET = MAINNET_SAC;
    const cursors = new Map<Network, BackfillCursorState>([
      ["testnet", { startLedger: 10, endLedger: 50, nextLedger: 25 }],
    ]);

    mockGetBackfillCursor.mockImplementation(async (net?: Network) =>
      cursors.get(net ?? "testnet") ?? null,
    );
    mockSetBackfillCursor.mockImplementation(async (c: BackfillCursorState, net?: Network) => {
      cursors.set(net ?? "testnet", { ...c });
    });
    mockClearBackfillCursor.mockImplementation(async (net?: Network) => {
      cursors.delete(net ?? "testnet");
    });

    await runBackfill({
      fromLedger: 500,
      toLedger: 520,
      chunkSize: 10,
      network: "mainnet",
    });

    // Mainnet cursor was read, advanced twice (510, 520), and cleared; testnet cursor stayed untouched.
    expect(mockGetBackfillCursor).toHaveBeenCalledTimes(1);
    expect(mockGetBackfillCursor).toHaveBeenCalledWith("mainnet");
    expect(mockSetBackfillCursor.mock.calls.every(([, net]) => net === "mainnet")).toBe(true);
    expect(mockClearBackfillCursor).toHaveBeenCalledWith("mainnet");
    expect(cursors.get("testnet")).toEqual({ startLedger: 10, endLedger: 50, nextLedger: 25 });
  });

  it("passes mainnet to config validation, source switcher, Horizon URL, and watch list", async () => {
    process.env.STELLAR_NETWORK = "testnet";
    process.env.SAC_CONTRACT_IDS_MAINNET = MAINNET_SAC;
    process.env.NFT_CONTRACT_IDS_MAINNET = MAINNET_NFT;
    process.env.HORIZON_URL_MAINNET = "https://horizon.stellar.org";
    process.env.HORIZON_URL_TESTNET = "https://horizon-testnet.stellar.org";
    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({
      fromLedger: 1000,
      toLedger: 1010,
      chunkSize: 10,
      network: "mainnet",
    });

    expect(mockValidateNetworkConfig).toHaveBeenCalledWith(["mainnet"]);
    expect(mockCreateSourceSwitcher).toHaveBeenCalledWith(
      expect.objectContaining({
        network: "mainnet",
        horizonUrl: "https://horizon.stellar.org",
      }),
    );
    expect(mockFetchEvents).toHaveBeenCalledWith(
      1000,
      1010,
      [MAINNET_SAC, MAINNET_NFT],
      expect.any(Number),
    );
  });

  it("refuses to run when the watch list is empty and never fetches every contract", async () => {
    // Mainnet has no default SAC watch list unless configured explicitly.
    await expect(
      runBackfill({ fromLedger: 1, toLedger: 50, network: "mainnet" }),
    ).rejects.toThrow(/SAC_CONTRACT_IDS_MAINNET.*NFT_CONTRACT_IDS_MAINNET/);

    expect(mockFetchEvents).not.toHaveBeenCalled();
    expect(mockGetBackfillCursor).not.toHaveBeenCalled();
    expect(mockSetBackfillCursor).not.toHaveBeenCalled();
  });

  it("honours an explicit --contracts override and rejects an empty override", async () => {
    mockGetBackfillCursor.mockResolvedValue(null);

    await runBackfill({
      fromLedger: 10,
      toLedger: 20,
      chunkSize: 10,
      network: "mainnet",
      contracts: [` ${OVERRIDE_A} `, OVERRIDE_B, OVERRIDE_A],
    });

    expect(mockFetchEvents).toHaveBeenCalledWith(
      10,
      20,
      [OVERRIDE_A, OVERRIDE_B],
      expect.any(Number),
    );

    mockFetchEvents.mockClear();
    await expect(
      runBackfill({
        fromLedger: 10,
        toLedger: 20,
        network: "testnet",
        contracts: [" ", ""],
      }),
    ).rejects.toThrow(/SAC_CONTRACT_IDS_TESTNET/);
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });

  it("rejects an invalid network name with a clear message", async () => {
    await expect(
      runBackfill({
        fromLedger: 1,
        toLedger: 10,
        network: "futurenet" as unknown as Network,
      }),
    ).rejects.toThrow(/Expected "testnet" or "mainnet"/);
    expect(mockFetchEvents).not.toHaveBeenCalled();
  });
});

describe("resolveBackfillContractIds & CLI backfill flags", () => {
  const SAVED = process.env;

  beforeEach(() => {
    process.env = { ...SAVED };
    delete process.env.SAC_CONTRACT_IDS;
    delete process.env.SAC_CONTRACT_IDS_MAINNET;
    delete process.env.NFT_CONTRACT_IDS;
    delete process.env.NFT_CONTRACT_IDS_MAINNET;
  });

  afterAll(() => {
    process.env = SAVED;
  });

  it("documents --network and --contracts in USAGE", () => {
    expect(USAGE).toContain("--network <net>");
    expect(USAGE).toContain("testnet | mainnet");
    expect(USAGE).toContain("--contracts <id,id>");
    expect(USAGE).toContain("SAC_CONTRACT_IDS_MAINNET");
    expect(USAGE).toContain("NFT_CONTRACT_IDS_MAINNET");
  });

  it("parses --network testnet|mainnet, defaults when omitted, and rejects anything else", () => {
    expect(resolveCliBackfillFlags(parseArgs(["--from", "1", "--to", "10"]))).toEqual({
      network: undefined,
      contracts: undefined,
    });

    expect(
      resolveCliBackfillFlags(parseArgs(["--from", "1", "--to", "10", "--network", "mainnet"])),
    ).toEqual({
      network: "mainnet",
      contracts: undefined,
    });

    expect(
      resolveCliBackfillFlags(
        parseArgs([
          "--from",
          "1",
          "--to",
          "10",
          "--network",
          "testnet",
          "--contracts",
          `${OVERRIDE_A},${OVERRIDE_B}`,
        ]),
      ),
    ).toEqual({
      network: "testnet",
      contracts: [OVERRIDE_A, OVERRIDE_B],
    });

    expect(() =>
      resolveCliBackfillFlags(parseArgs(["--from", "1", "--to", "10", "--network", "devnet"])),
    ).toThrow(/--network must be "testnet" or "mainnet"/);

    expect(() =>
      resolveCliBackfillFlags(parseArgs(["--from", "1", "--to", "10", "--network"])),
    ).toThrow(/--network must be "testnet" or "mainnet"/);

    expect(() =>
      resolveCliBackfillFlags(parseArgs(["--from", "1", "--to", "10", "--contracts"])),
    ).toThrow(/--contracts requires a comma-separated list/);
  });

  it("resolveBackfillContractIds throws naming the per-network env vars when empty", () => {
    expect(() => resolveBackfillContractIds("mainnet")).toThrow(
      /SAC_CONTRACT_IDS_MAINNET.*NFT_CONTRACT_IDS_MAINNET/,
    );
  });
});
