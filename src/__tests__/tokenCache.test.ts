import {
  getTokenMetadata,
  initTokenCache,
  getAllCachedTokens,
  getCachedTokenDecimals,
  _resetTokenCache,
} from "../tokenCache";
import { prisma } from "../db";
import { fetchTokenMetadata } from "../rpc";
import { _resetMetrics, renderMetrics } from "../metrics";

jest.mock("../db", () => ({
  prisma: {
    tokenMetadata: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

jest.mock("../rpc", () => ({
  fetchTokenMetadata: jest.fn(),
}));

describe("Token Cache", () => {
  const mockToken = {
    network: "testnet" as const,
    contractId: "C123",
    symbol: "TKN",
    name: "Token",
    decimals: 7,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The cache is module-level state and survives between tests. Clearing it
    // keeps each case independent — otherwise a "hit" in one test can be
    // satisfied by a value some earlier test happened to leave behind.
    _resetTokenCache();
    _resetMetrics();
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.tokenMetadata.findUnique as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("populates cache from DB on init", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);

    await initTokenCache("testnet");

    expect(prisma.tokenMetadata.findMany).toHaveBeenCalledWith({
      where: { network: "testnet" },
    });
    expect(getAllCachedTokens()).toContainEqual(mockToken);
  });

  it("returns cached metadata without an RPC call", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    const result = await getTokenMetadata("C123", "testnet");

    expect(result).toEqual(mockToken);
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it("fetches from RPC and persists to DB on cache miss", async () => {
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "NEW",
      name: "New Token",
      decimals: 9,
    });

    const result = await getTokenMetadata("C456", "testnet");

    expect(result.symbol).toBe("NEW");
    expect(fetchTokenMetadata).toHaveBeenCalledWith("C456", "testnet");
    expect(prisma.tokenMetadata.upsert).toHaveBeenCalledWith({
      where: { network_contractId: { network: "testnet", contractId: "C456" } },
      create: expect.objectContaining({ symbol: "NEW", network: "testnet" }),
      update: expect.objectContaining({ symbol: "NEW", network: "testnet" }),
    });
  });

  it("does not serve one network's token for the same id on another", async () => {
    // A contract id is only unique within a chain. Sharing a cache entry across
    // networks would serve the wrong symbol and, far worse, the wrong
    // `decimals` — silently rescaling every amount rendered from that token.
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "MAIN",
      name: "Mainnet Token",
      decimals: 2,
    });

    const result = await getTokenMetadata("C123", "mainnet");

    expect(result.symbol).toBe("MAIN");
    expect(result.decimals).toBe(2);
    expect(fetchTokenMetadata).toHaveBeenCalledWith("C123", "mainnet");
  });

  it("asks the RPC for the same network it caches the answer under", async () => {
    // Querying the wrong chain returns nothing or a different token, and that
    // answer would then be cached under the network that was asked for.
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "X",
      name: "X",
      decimals: 7,
    });

    await getTokenMetadata("CXYZ", "mainnet");

    expect(fetchTokenMetadata).toHaveBeenCalledWith("CXYZ", "mainnet");
    expect(getAllCachedTokens("mainnet")).toHaveLength(1);
    expect(getAllCachedTokens("testnet")).toHaveLength(0);
  });

  it("narrows getAllCachedTokens to one network when asked", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([mockToken]);
    await initTokenCache("testnet");

    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "M",
      name: "M",
      decimals: 7,
    });
    await getTokenMetadata("CMAIN", "mainnet");

    expect(getAllCachedTokens()).toHaveLength(2);
    expect(getAllCachedTokens("testnet").map((t) => t.contractId)).toEqual(["C123"]);
    expect(getAllCachedTokens("mainnet").map((t) => t.contractId)).toEqual(["CMAIN"]);
  });

  it("reads cached decimals without triggering DB or RPC", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([
      { ...mockToken, decimals: 6 },
    ]);
    await initTokenCache("testnet");
    jest.clearAllMocks();

    expect(getCachedTokenDecimals("C123", "testnet")).toBe(6);
    expect(getCachedTokenDecimals("CMISSING", "testnet")).toBeUndefined();
    expect(prisma.tokenMetadata.findUnique).not.toHaveBeenCalled();
    expect(fetchTokenMetadata).not.toHaveBeenCalled();
  });

  it("keeps serving from RPC when the DB seed fails", async () => {
    // A cold cache is recoverable; refusing to start is not.
    (prisma.tokenMetadata.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "OK",
      name: "OK",
      decimals: 7,
    });

    await expect(initTokenCache("testnet")).resolves.toBeUndefined();
    await expect(getTokenMetadata("CANY", "testnet")).resolves.toMatchObject({ symbol: "OK" });
  });

  it("suppresses failed RPC lookups during the cooldown", async () => {
    jest.useFakeTimers();
    (fetchTokenMetadata as jest.Mock).mockRejectedValue(new Error("RPC unavailable"));

    await expect(getTokenMetadata("CFAIL", "testnet")).rejects.toThrow("RPC unavailable");
    await expect(getTokenMetadata("CFAIL", "testnet")).rejects.toThrow(
      "temporarily suppressed",
    );

    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    expect(prisma.tokenMetadata.upsert).not.toHaveBeenCalled();
  });

  it("retries after the cooldown expires", async () => {
    jest.useFakeTimers();
    (fetchTokenMetadata as jest.Mock)
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValueOnce({ symbol: "OK", name: "Okay", decimals: 18 });

    await expect(getTokenMetadata("CRETRY", "testnet")).rejects.toThrow("RPC unavailable");
    jest.advanceTimersByTime(30 * 60 * 1000);
    await expect(getTokenMetadata("CRETRY", "testnet")).resolves.toMatchObject({
      symbol: "OK",
    });

    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it("increases the cooldown after repeated RPC failures", async () => {
    jest.useFakeTimers();
    (fetchTokenMetadata as jest.Mock)
      .mockRejectedValue(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValueOnce({ symbol: "OK", name: "Okay", decimals: 7 });

    await expect(getTokenMetadata("CBACKOFF", "testnet")).rejects.toThrow();
    jest.advanceTimersByTime(30 * 60 * 1000);
    await expect(getTokenMetadata("CBACKOFF", "testnet")).rejects.toThrow();

    jest.advanceTimersByTime(30 * 60 * 1000);
    await expect(getTokenMetadata("CBACKOFF", "testnet")).rejects.toThrow(
      "temporarily suppressed",
    );
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(30 * 60 * 1000);
    await expect(getTokenMetadata("CBACKOFF", "testnet")).resolves.toMatchObject({
      symbol: "OK",
    });
    expect(fetchTokenMetadata).toHaveBeenCalledTimes(3);
  });

  it("deduplicates concurrent lookups for the same token", async () => {
    let resolveMetadata!: (value: { symbol: string; name: string; decimals: number }) => void;
    (fetchTokenMetadata as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        }),
    );

    const first = getTokenMetadata("CSHARED", "testnet");
    const second = getTokenMetadata("CSHARED", "testnet");
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchTokenMetadata).toHaveBeenCalledTimes(1);
    resolveMetadata({ symbol: "SHARED", name: "Shared", decimals: 7 });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(prisma.tokenMetadata.findUnique).toHaveBeenCalledTimes(1);
  });

  it("fetches different tokens independently", async () => {
    (fetchTokenMetadata as jest.Mock).mockImplementation(async (contractId: string) => ({
      symbol: contractId,
      name: contractId,
      decimals: 7,
    }));

    await Promise.all([
      getTokenMetadata("CFIRST", "testnet"),
      getTokenMetadata("CSECOND", "testnet"),
    ]);

    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);
    expect(prisma.tokenMetadata.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not suppress a failed lookup on another network", async () => {
    jest.useFakeTimers();
    (fetchTokenMetadata as jest.Mock)
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValueOnce({ symbol: "MAIN", name: "Mainnet", decimals: 7 });

    await expect(getTokenMetadata("CSAME", "testnet")).rejects.toThrow("RPC unavailable");
    await expect(getTokenMetadata("CSAME", "mainnet")).resolves.toMatchObject({
      symbol: "MAIN",
    });

    expect(fetchTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it.each([0, 18, 38])("accepts decimals value %i", async (decimals) => {
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "VALID",
      name: "Valid",
      decimals,
    });

    await expect(getTokenMetadata(`CVALID${decimals}`, "testnet")).resolves.toMatchObject({
      decimals,
    });
    expect(prisma.tokenMetadata.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([-1, 1.5, 39, NaN, Infinity])("rejects invalid decimals value %s", async (decimals) => {
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "INVALID",
      name: "Invalid",
      decimals,
    });

    await expect(getTokenMetadata(`CINVALID${String(decimals)}`, "testnet")).rejects.toThrow(
      "invalid decimals",
    );
    expect(prisma.tokenMetadata.upsert).not.toHaveBeenCalled();
    expect(getAllCachedTokens()).toHaveLength(0);
    expect(getCachedTokenDecimals(`CINVALID${String(decimals)}`, "testnet")).toBeUndefined();
  });

  it("does not accept a non-number decimal representation", async () => {
    (fetchTokenMetadata as jest.Mock).mockResolvedValue({
      symbol: "INVALID",
      name: "Invalid",
      decimals: "18",
    });

    await expect(getTokenMetadata("CINVALIDSTRING", "testnet")).rejects.toThrow(
      "invalid decimals",
    );
    expect(prisma.tokenMetadata.upsert).not.toHaveBeenCalled();
    expect(getCachedTokenDecimals("CINVALIDSTRING", "testnet")).toBeUndefined();
  });

  it("does not seed invalid decimals from the database into memory", async () => {
    (prisma.tokenMetadata.findMany as jest.Mock).mockResolvedValue([
      { ...mockToken, decimals: 39 },
    ]);

    await initTokenCache("testnet");

    expect(getAllCachedTokens()).toHaveLength(0);
    expect(getCachedTokenDecimals("C123", "testnet")).toBeUndefined();
  });

  it("records and renders all token metadata lookup outcomes", async () => {
    (fetchTokenMetadata as jest.Mock)
      .mockResolvedValueOnce({ symbol: "HIT", name: "Hit", decimals: 7 })
      .mockRejectedValueOnce(new Error("RPC unavailable"));

    await getTokenMetadata("CHIT", "testnet");
    await getTokenMetadata("CHIT", "testnet");
    await expect(getTokenMetadata("CFAILED", "testnet")).rejects.toThrow();
    await expect(getTokenMetadata("CFAILED", "testnet")).rejects.toThrow(
      "temporarily suppressed",
    );

    const metrics = await renderMetrics();
    for (const outcome of ["hit", "miss", "failed", "skipped_recent_failure"] as const) {
      expect(metrics).toContain(`token_metadata_lookups_total{outcome="${outcome}"} 1`);
    }
  });
});