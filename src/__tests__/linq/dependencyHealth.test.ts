/**
 * Tests for how `linqCall` classifies provider outcomes into `/status`
 * dependency health (#456).
 *
 * Covers:
 * - Mocked `fetch` through `linqCall` for 400, 401, 403, 404, 429, 500,
 *   timeout, unreachable host, and last-call-wins (5xx followed by 400), each
 *   followed by `getDependencyStatus()`.
 * - Route test: a 4xx from `POST /offramp/verify-bank` leaves `GET /status`
 *   healthy (`railsUsable: true`) and `/status` makes zero provider calls.
 * - Strict key-set and leakage assertions proving no provider message, URL, or
 *   order id ever reaches `/status`.
 */
import request from "supertest";

jest.mock("../../db", () => ({
  getLastIndexedLedger: jest.fn(),
  getLastIndexedState: jest.fn(),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
}));

jest.mock("../../rpc", () => ({
  getLatestLedger: jest.fn(),
}));

jest.mock("../../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2026-11-26T00:00:00.000Z", uptimeSeconds: 100, totalIndexed: 50 }),
  isIndexerRunning: jest.fn().mockReturnValue(true),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn().mockReturnValue(undefined),
}));

import { clearRpcHealthCache, createApp } from "../../api";
import { getLastIndexedLedger, prisma } from "../../db";
import { _resetDependencyOutcomes, getDependencyStatus } from "../../dependencies";
import { linqCall } from "../../linq/http";
import { getLatestLedger } from "../../rpc";

const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetLatestLedger = getLatestLedger as jest.MockedFunction<typeof getLatestLedger>;
const mockQueryRaw = prisma.$queryRaw as jest.MockedFunction<typeof prisma.$queryRaw>;

const ALLOWED_DEPENDENCY_KEYS = new Set(["status", "lastChecked", "latencyMs", "error"]);
const ALLOWED_ERROR_WORDS = new Set(["timeout", "error", "rate_limited"]);

function mockJsonResponse(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  _resetDependencyOutcomes();
  clearRpcHealthCache();
  process.env.LINQ_API_KEY = "biz_test_key_456";
  process.env.LINQ_BASE_URL = "https://provider.invalid/secret-path-token";
  process.env.STELLAR_NETWORK = "testnet";
  process.env.NETWORKS = "testnet";
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockGetLastIndexedLedger.mockResolvedValue(1_000);
  mockGetLatestLedger.mockResolvedValue(1_002);
  mockQueryRaw.mockResolvedValue([{ 1: 1 }]);
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("linqCall -> getDependencyStatus classification (#456)", () => {
  it("keeps railsUsable true and dependency healthy on HTTP 400", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(400, {
        message: "Unknown bank code 999 for order ord_leak_400 at https://provider.invalid/secret-path-token",
        code: "invalid_bank_code",
      }),
    );

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(true);
    expect(depStatus.dependencies.linq).toMatchObject({ status: "healthy" });
    expect(depStatus.dependencies.linq.error).toBeUndefined();
    expect(Object.keys(depStatus.dependencies.linq).every((k) => ALLOWED_DEPENDENCY_KEYS.has(k))).toBe(true);
  });

  it("keeps railsUsable true and dependency healthy on HTTP 404", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(404, {
        message: "Order ord_missing_404 not found",
        code: "order_not_found",
      }),
    );

    await expect(
      linqCall("/b2b/status", {
        operation: "offramp_status",
        query: { id: "ord_missing_404" },
      }),
    ).rejects.toMatchObject({ status: 404 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(true);
    expect(depStatus.dependencies.linq).toMatchObject({ status: "healthy" });
    expect(depStatus.dependencies.linq.error).toBeUndefined();
  });

  it("marks HTTP 401 unavailable with bounded error 'error' and leaks no secrets", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(401, {
        message: "Revoked API key biz_test_key_456 at https://provider.invalid/secret-path-token ord_401",
        code: "invalid_api_key",
      }),
    );

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
      }),
    ).rejects.toMatchObject({ status: 401 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "error",
    });
    expect(Object.keys(depStatus.dependencies.linq).every((k) => ALLOWED_DEPENDENCY_KEYS.has(k))).toBe(true);
    expect(ALLOWED_ERROR_WORDS.has(depStatus.dependencies.linq.error!)).toBe(true);
    const raw = JSON.stringify(depStatus);
    expect(raw).not.toContain("biz_test_key_456");
    expect(raw).not.toContain("secret-path-token");
    expect(raw).not.toContain("ord_401");
    expect(raw).not.toContain("Revoked API key");
  });

  it("marks HTTP 403 unavailable with bounded error 'error' and leaks no secrets", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(403, {
        message: "Forbidden for key biz_test_key_456 on https://provider.invalid/secret-path-token ord_403",
        code: "forbidden",
      }),
    );

    await expect(
      linqCall("/b2b/offramp", {
        method: "POST",
        operation: "offramp_order",
        body: { orderId: "ord_403" },
      }),
    ).rejects.toMatchObject({ status: 403 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "error",
    });
    expect(Object.keys(depStatus.dependencies.linq).every((k) => ALLOWED_DEPENDENCY_KEYS.has(k))).toBe(true);
    expect(ALLOWED_ERROR_WORDS.has(depStatus.dependencies.linq.error!)).toBe(true);
    const raw = JSON.stringify(depStatus);
    expect(raw).not.toContain("biz_test_key_456");
    expect(raw).not.toContain("secret-path-token");
    expect(raw).not.toContain("ord_403");
    expect(raw).not.toContain("Forbidden for key");
  });

  it("applies last-call-wins semantics: a 400 immediately clears a prior 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(mockJsonResponse(503, { message: "Upstream service down" }))
      .mockResolvedValueOnce(
        mockJsonResponse(400, {
          message: "Unknown bank code",
          code: "invalid_bank_code",
        }),
      );

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
      }),
    ).rejects.toMatchObject({ status: 503 });

    expect(getDependencyStatus().railsUsable).toBe(false);
    expect(getDependencyStatus().dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "error",
    });

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(true);
    expect(depStatus.dependencies.linq).toMatchObject({ status: "healthy" });
    expect(depStatus.dependencies.linq.error).toBeUndefined();
  });

  it("marks surfaced HTTP 429 unavailable with bounded error 'rate_limited'", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(
        429,
        {
          message: "Rate limit exceeded on https://provider.invalid/secret-path-token for ord_rl_429",
          code: "rate_limited",
        },
        { "retry-after": "5" },
      ),
    );

    await expect(
      linqCall("/b2b/offramp", {
        method: "POST",
        operation: "offramp_order",
        body: { orderId: "ord_rl_429" },
        rateLimitRetries: 0,
      }),
    ).rejects.toMatchObject({ status: 429 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "rate_limited",
    });
    expect(ALLOWED_ERROR_WORDS.has(depStatus.dependencies.linq.error!)).toBe(true);
  });

  it("marks HTTP 500 unavailable with bounded error 'error'", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(500, {
        message: "Database crashed at https://provider.invalid/secret-path-token ord_500",
      }),
    );

    await expect(
      linqCall("/b2b/offramp", {
        method: "POST",
        operation: "offramp_order",
        body: {},
      }),
    ).rejects.toMatchObject({ status: 500 });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "error",
    });
  });

  it("marks a timeout unavailable with bounded error 'timeout'", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ status: 504, code: "provider_timeout" });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "timeout",
    });
  });

  it("marks an unreachable host unavailable with bounded error 'error'", async () => {
    fetchMock.mockRejectedValueOnce(
      new TypeError("fetch failed: ECONNREFUSED https://provider.invalid/secret-path-token ord_down_1"),
    );

    await expect(
      linqCall("/b2b/verify-bank", {
        method: "POST",
        operation: "offramp_verify_bank",
        body: { bankCode: "000", accountNumber: "0000000000" },
      }),
    ).rejects.toMatchObject({ status: 502, transport: "unreachable" });

    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(false);
    expect(depStatus.dependencies.linq).toMatchObject({
      status: "unavailable",
      error: "error",
    });
  });

  it("keeps railsUsable true when a 429 is absorbed by retry and the retry succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(429, { message: "Slow down" }, { "retry-after": "0" }),
      )
      .mockResolvedValueOnce(mockJsonResponse(200, { ok: true }));

    const result = await linqCall<{ ok: boolean }>("/b2b/rate", {
      operation: "offramp_rate",
      rateLimitRetries: 1,
    });

    expect(result).toEqual({ ok: true });
    const depStatus = getDependencyStatus();
    expect(depStatus.railsUsable).toBe(true);
    expect(depStatus.dependencies.linq).toMatchObject({ status: "healthy" });
    expect(depStatus.dependencies.linq.error).toBeUndefined();
  });
});

describe("GET /status integration with bank check 4xx and leakage guard (#456)", () => {
  const app = createApp();

  it("leaves GET /status healthy after a 4xx from POST /offramp/verify-bank and never probes the provider", async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(400, {
        message: "Account could not be resolved for ord_bank_typo_456 at https://provider.invalid/secret-path-token",
        code: "invalid_bank_account",
      }),
    );

    const bankRes = await request(app)
      .post("/offramp/verify-bank")
      .send({ bankCode: "000", accountNumber: "0000000000" });

    expect(bankRes.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const statusRes = await request(app).get("/status");

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("healthy");
    expect(statusRes.body.dependencies.railsUsable).toBe(true);
    expect(statusRes.body.dependencies.dependencies.linq).toMatchObject({
      status: "healthy",
    });
    expect(statusRes.body.dependencies.dependencies.linq.error).toBeUndefined();
    // /status must remain purely passive and never invoke fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(statusRes.body)).not.toContain("ord_bank_typo_456");
    expect(JSON.stringify(statusRes.body)).not.toContain("secret-path-token");
  });

  it("never exposes provider messages, URLs, or order IDs in GET /status key sets on any failure", async () => {
    const scenarios = [
      () =>
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(401, {
            message: "Invalid key biz_test_key_456 at https://provider.invalid/secret-path-token order=ord_secret_401",
          }),
        ),
      () =>
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(403, {
            message: "Access denied at https://provider.invalid/secret-path-token order=ord_secret_403",
          }),
        ),
      () =>
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(429, {
            message: "Quota hit for https://provider.invalid/secret-path-token order=ord_secret_429",
          }),
        ),
      () =>
        fetchMock.mockResolvedValueOnce(
          mockJsonResponse(503, {
            message: "Upstream error at https://provider.invalid/secret-path-token order=ord_secret_503",
          }),
        ),
      () =>
        fetchMock.mockRejectedValueOnce(
          new Error("ECONNREFUSED https://provider.invalid/secret-path-token ord_secret_net"),
        ),
    ];

    for (const setup of scenarios) {
      _resetDependencyOutcomes();
      clearRpcHealthCache();
      setup();

      await request(app)
        .post("/offramp/verify-bank")
        .send({ bankCode: "000", accountNumber: "0000000000" });

      const callsBeforeStatus = fetchMock.mock.calls.length;
      const statusRes = await request(app).get("/status");

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toBe("degraded");
      expect(statusRes.body.dependencies.railsUsable).toBe(false);
      // Still zero calls made by /status itself.
      expect(fetchMock).toHaveBeenCalledTimes(callsBeforeStatus);

      const linqDep = statusRes.body.dependencies.dependencies.linq;
      expect(Object.keys(linqDep).sort()).toEqual(["error", "lastChecked", "latencyMs", "status"]);
      expect(ALLOWED_ERROR_WORDS.has(linqDep.error)).toBe(true);

      const raw = JSON.stringify(statusRes.body);
      expect(raw).not.toContain("provider.invalid");
      expect(raw).not.toContain("secret-path-token");
      expect(raw).not.toContain("biz_test_key_456");
      expect(raw).not.toContain("ord_secret_");
      expect(raw).not.toContain("Invalid key");
      expect(raw).not.toContain("Access denied");
      expect(raw).not.toContain("Quota hit");
      expect(raw).not.toContain("Upstream error");
      expect(raw).not.toContain("ECONNREFUSED");
    }
  });
});
