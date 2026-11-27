import { PrismaClient, Prisma } from "@prisma/client";
import {
  withReadReplicas,
  withPrimary,
  disconnectReplicas,
  isConnectionError,
  DEFAULT_REPLICA_MODELS,
} from "../router";
import { renderMetrics, _resetMetrics } from "../../metrics";

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client");
  const mPrismaClient = jest.fn(() => ({
    $queryRaw: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $extends: jest.fn().mockImplementation((config) => {
      const ext = {
        ...config,
        ...(config.client || {}),
        $queryRaw: jest.fn(),
      };
      return ext;
    }),
    user: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    tokenTransfer: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    nftTransfer: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    hostFnLog: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    lpShareTransfer: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    accountSummary: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    indexerState: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    tokenMetadata: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
  }));
  return { ...actual, PrismaClient: mPrismaClient };
});

describe("withReadReplicas router", () => {
  let primary: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    _resetMetrics();
    primary = new PrismaClient();
  });

  afterEach(async () => {
    await disconnectReplicas();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns primary directly if no replica URLs provided", () => {
    const router = withReadReplicas(primary, { replicaUrls: [] });
    expect(router).toBe(primary);
    expect(router.$primary).toBe(primary);
  });

  it("intercepts reads of allowlisted models and routes them to a replica", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-result");

    // The second PrismaClient created is the replica
    const replicaClient = (PrismaClient as jest.Mock).mock.results[1].value;
    replicaClient.tokenTransfer.findMany.mockResolvedValue("replica-result");

    // Top-level client has $transaction
    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await allOps.call({}, {
      model: "tokenTransfer",
      operation: "findMany",
      args: { where: { id: 1 } },
      query: queryMock,
    });

    expect(result).toBe("replica-result");
    expect(queryMock).not.toHaveBeenCalled();
    expect(replicaClient.tokenTransfer.findMany).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("routes reads of models outside the allowlist to the primary", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-metadata");

    const replicaClient = (PrismaClient as jest.Mock).mock.results[1].value;

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // tokenMetadata is NOT on the replica allowlist
    const result = await allOps.call({}, {
      model: "tokenMetadata",
      operation: "findUnique",
      args: { where: { contractId: "C123" } },
      query: queryMock,
    });

    expect(result).toBe("primary-metadata");
    expect(queryMock).toHaveBeenCalledWith({ where: { contractId: "C123" } });
    expect(replicaClient.tokenMetadata.findUnique).not.toHaveBeenCalled();

    // indexerState is NOT on the replica allowlist
    const cursorMock = jest.fn().mockResolvedValue({ lastIndexedLedger: 100 });
    const cursorResult = await allOps.call({}, {
      model: "indexerState",
      operation: "findUnique",
      args: { where: { network: "testnet" } },
      query: cursorMock,
    });
    expect(cursorResult).toEqual({ lastIndexedLedger: 100 });
    expect(cursorMock).toHaveBeenCalled();
    expect(replicaClient.indexerState.findUnique).not.toHaveBeenCalled();
  });

  it("routes writes to the primary", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-write-result");

    const result = await allOps.call({}, {
      model: "tokenTransfer",
      operation: "create",
      args: { data: { name: "test" } },
      query: queryMock,
    });

    expect(result).toBe("primary-write-result");
    expect(queryMock).toHaveBeenCalledWith({ data: { name: "test" } });
  });

  it("bypasses replicas when inside a transaction", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-tx-result");

    // Transaction client lacks $transaction method
    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({} as any);

    const result = await allOps.call({}, {
      model: "tokenTransfer",
      operation: "findMany",
      args: {},
      query: queryMock,
    });

    expect(result).toBe("primary-tx-result");
    expect(queryMock).toHaveBeenCalled();
  });

  it("round-robins across healthy replicas", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1", "rep2"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn();

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    const rep2 = (PrismaClient as jest.Mock).mock.results[2].value;
    rep1.tokenTransfer.count.mockResolvedValue(1);
    rep2.tokenTransfer.count.mockResolvedValue(2);

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // 1st request -> rep1
    const res1 = await allOps.call({}, { model: "tokenTransfer", operation: "count", args: {}, query: queryMock });
    // 2nd request -> rep2
    const res2 = await allOps.call({}, { model: "tokenTransfer", operation: "count", args: {}, query: queryMock });
    // 3rd request -> rep1
    const res3 = await allOps.call({}, { model: "tokenTransfer", operation: "count", args: {}, query: queryMock });

    expect(res1).toBe(1);
    expect(res2).toBe(2);
    expect(res3).toBe(1);
  });

  it("marks replica unhealthy immediately on connection error and falls back to primary", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-fallback");

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    // Simulate replica query failing with connection error
    rep1.tokenTransfer.findMany.mockRejectedValue(new Error("Connection lost"));

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });

    // Should catch connection error and fallback to primary query
    expect(result).toBe("primary-fallback");
    expect(queryMock).toHaveBeenCalled();

    // Next request should skip the replica IMMEDIATELY without waiting for health-check timer
    queryMock.mockClear();
    queryMock.mockResolvedValue("primary-direct");
    rep1.tokenTransfer.findMany.mockClear();

    const nextResult = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });
    expect(nextResult).toBe("primary-direct");
    expect(queryMock).toHaveBeenCalled();
    expect(rep1.tokenTransfer.findMany).not.toHaveBeenCalled();
  });

  it("does not fall back to primary when query fails due to query's own fault (bad argument)", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-should-not-run");

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    const queryError = new Prisma.PrismaClientValidationError("Invalid argument provided", { clientVersion: "5.22.0" });
    rep1.tokenTransfer.findMany.mockRejectedValue(queryError);

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // Query error should re-throw immediately and NOT retry on primary
    await expect(
      allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock })
    ).rejects.toThrow("Invalid argument provided");

    expect(queryMock).not.toHaveBeenCalled();

    // Replica should NOT be marked unhealthy by a query error
    rep1.tokenTransfer.findMany.mockResolvedValue("replica-healthy");
    const recovered = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });
    expect(recovered).toBe("replica-healthy");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("allows a caller to force the primary via forcePrimary in args", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("forced-primary");

    const replicaClient = (PrismaClient as jest.Mock).mock.results[1].value;
    replicaClient.tokenTransfer.findMany.mockResolvedValue("replica-result");

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await allOps.call({}, {
      model: "tokenTransfer",
      operation: "findMany",
      args: { where: { id: 1 }, forcePrimary: true },
      query: queryMock,
    });

    expect(result).toBe("forced-primary");
    // forcePrimary should be stripped before calling query
    expect(queryMock).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(replicaClient.tokenTransfer.findMany).not.toHaveBeenCalled();
  });

  it("allows a caller to force the primary via withPrimary helper", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("withPrimary-result");

    const replicaClient = (PrismaClient as jest.Mock).mock.results[1].value;
    replicaClient.tokenTransfer.findMany.mockResolvedValue("replica-result");

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    const result = await withPrimary(async () => {
      return allOps.call({}, {
        model: "tokenTransfer",
        operation: "findMany",
        args: { where: { id: 1 } },
        query: queryMock,
      });
    });

    expect(result).toBe("withPrimary-result");
    expect(queryMock).toHaveBeenCalled();
    expect(replicaClient.tokenTransfer.findMany).not.toHaveBeenCalled();

    // Also test router.$withPrimary method
    const result2 = await router.$withPrimary(async () => {
      return allOps.call({}, {
        model: "tokenTransfer",
        operation: "findMany",
        args: { where: { id: 1 } },
        query: queryMock,
      });
    });
    expect(result2).toBe("withPrimary-result");
  });

  it("exposes $primary on the extended client", () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["replica1"] });
    expect(router.$primary).toBe(primary);
  });

  it("marks replica unhealthy if background health check fails, and restores healthy when check succeeds", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"], healthCheckIntervalMs: 1000 });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-fallback");

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    rep1.$queryRaw.mockRejectedValueOnce(new Error("DB down"));

    // Advance timers so health check runs and fails
    await jest.advanceTimersByTimeAsync(1000);

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // Next request should hit primary because rep1 is marked unhealthy
    const result = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });
    expect(result).toBe("primary-fallback");

    // Advance timers so next health check runs and succeeds
    rep1.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await jest.advanceTimersByTimeAsync(1000);

    // Now replica should be healthy again
    rep1.tokenTransfer.findMany.mockResolvedValueOnce("replica-back");
    const restored = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });
    expect(restored).toBe("replica-back");
  });

  it("disconnects replica clients and cancels interval on $disconnect and $disconnectReplicas", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1", "rep2"] });
    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    const rep2 = (PrismaClient as jest.Mock).mock.results[2].value;

    await router.$disconnectReplicas();
    expect(rep1.$disconnect).toHaveBeenCalled();
    expect(rep2.$disconnect).toHaveBeenCalled();

    await router.$disconnect();
    expect(primary.$disconnect).toHaveBeenCalled();
  });

  it("supports custom allowlist in RouterOptions", async () => {
    const router: any = withReadReplicas(primary, {
      replicaUrls: ["rep1"],
      allowlist: ["customTable"],
    });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-result");

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    rep1.customTable = { findMany: jest.fn().mockResolvedValue("replica-custom") };

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // customTable is allowlisted
    const res1 = await allOps.call({}, { model: "customTable", operation: "findMany", args: {}, query: queryMock });
    expect(res1).toBe("replica-custom");

    // tokenTransfer is NOT allowlisted in this custom router
    const res2 = await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });
    expect(res2).toBe("primary-result");
  });

  it("records metrics for reads by target and fallbacks in renderMetrics()", async () => {
    const router: any = withReadReplicas(primary, { replicaUrls: ["rep1"] });
    const allOps = router.query.$allModels.$allOperations;
    const queryMock = jest.fn().mockResolvedValue("primary-result");

    const rep1 = (PrismaClient as jest.Mock).mock.results[1].value;
    rep1.tokenTransfer.findMany.mockResolvedValue("replica-result");

    jest.spyOn(Prisma, "getExtensionContext").mockReturnValue({ $transaction: jest.fn() } as any);

    // 1. Replica read
    await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });

    // 2. Primary read (non-allowlisted)
    await allOps.call({}, { model: "tokenMetadata", operation: "findMany", args: {}, query: queryMock });

    // 3. Fallback read on connection failure
    rep1.tokenTransfer.findMany.mockRejectedValueOnce(new Error("Connection reset by peer"));
    await allOps.call({}, { model: "tokenTransfer", operation: "findMany", args: {}, query: queryMock });

    const metricsText = await renderMetrics();

    // Check reads by target (1 replica, 2 primary: 1 non-allowlisted + 1 fallback)
    expect(metricsText).toContain('db_reads_total{target="replica"} 1');
    expect(metricsText).toContain('db_reads_total{target="primary"} 2');
    // Check fallback counter
    expect(metricsText).toContain('db_read_fallbacks_total 1');
  });
});

describe("isConnectionError", () => {
  it("identifies network and connection errors", () => {
    expect(isConnectionError(new Error("Connection lost"))).toBe(true);
    expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
    expect(isConnectionError(new Error("server has closed the connection"))).toBe(true);
    expect(isConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isConnectionError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isConnectionError({ code: "P1001" })).toBe(true);
    expect(isConnectionError({ code: "P1017" })).toBe(true);
    expect(isConnectionError({ code: "P2024" })).toBe(true);
    expect(isConnectionError(new Prisma.PrismaClientInitializationError("Can't reach db", "5.22.0"))).toBe(true);
  });

  it("identifies query errors as non-connection errors", () => {
    expect(isConnectionError(new Prisma.PrismaClientValidationError("Unknown arg", { clientVersion: "5.22.0" }))).toBe(false);
    expect(isConnectionError({ code: "P2002" })).toBe(false);
    expect(isConnectionError({ code: "P2025" })).toBe(false);
    expect(isConnectionError(new Error("Invalid value provided for argument id"))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError("string error")).toBe(false);
  });
});
