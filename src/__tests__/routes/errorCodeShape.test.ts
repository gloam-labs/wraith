/**
 * #394 — every JSON error the read API writes carries a machine-readable code.
 *
 * The rail surfaces already had one error shape (#287). The read API did not:
 * a client could meet `{ error }` on `/status` and `{ error, code }` on `/fees`,
 * so a failure was only branchable on some paths. These cases pin one failure
 * per route group to `{ error, code }`, and pin the code's value where the
 * meaning is already catalogued in `RAIL_ERROR_CODES`.
 *
 * `error` is prose and stays exactly as it was; only `code` is new. Nothing
 * here re-asserts the prose beyond proving it is still a non-empty string, so
 * a wording change does not fail this suite.
 */
import express from "express";
import request from "supertest";

jest.mock("../../db", () => ({
  getLastIndexedLedger: jest.fn(),
  getLastIndexedState: jest.fn(),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: {
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    webhookSubscription: { findUnique: jest.fn(), findMany: jest.fn() },
    webhookDelivery: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    tokenMetadata: { findMany: jest.fn() },
  },
}));

// `/fees` writes its ledger rows fire-and-forget; these cases only exercise
// the error paths, so the ledger is stubbed rather than reached.
jest.mock("../../api/feeLedger", () => ({
  recordFeeQuotes: jest.fn(),
  feeReport: jest.fn(),
}));

jest.mock("../../rpc", () => ({
  getLatestLedger: jest.fn(),
  validateNetworkConfig: jest.fn(),
}));

jest.mock("../../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest
    .fn()
    .mockReturnValue({ startedAt: "2024-01-01T00:00:00.000Z", uptimeSeconds: 0, totalIndexed: 0 }),
  isIndexerRunning: jest.fn().mockReturnValue(true),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn().mockReturnValue(undefined),
}));

jest.mock("../../workers/webhooks", () => ({
  ...jest.requireActual("../../workers/webhooks"),
  startWebhookWorker: jest.fn(),
}));

import { createApp } from "../../api";
import { createCandlesRouter } from "../../api/candles";
import { createWebhooksRouter } from "../../api/webhooks";
import { createOpsRouter } from "../../api/ops";
import { feesRouter } from "../../api/fees";
import { metricsAccessGuard } from "../../metrics";
import { getLastIndexedLedger, getNftOwner, getNftMetadata, prisma } from "../../db";

const mockGetLastIndexedLedger = getLastIndexedLedger as jest.MockedFunction<typeof getLastIndexedLedger>;
const mockGetNftOwner = getNftOwner as jest.MockedFunction<typeof getNftOwner>;
const mockGetNftMetadata = getNftMetadata as jest.MockedFunction<typeof getNftMetadata>;
const mockQueryRawUnsafe = prisma.$queryRawUnsafe as jest.MockedFunction<typeof prisma.$queryRawUnsafe>;

const CONTRACT = "CBC42KFZO33TYVFDOUXFRWXYYXHFGH7W5GM4IJQSXKGFINKL2XPP4XTE";
const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Both halves of the contract: prose still present, code present and as expected. */
function expectErrorCode(body: Record<string, unknown>, code: string): void {
  expect(typeof body.error).toBe("string");
  expect(String(body.error).length).toBeGreaterThan(0);
  expect(body.code).toBe(code);
}

function appWith(router: express.Router, mount: string) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  return app;
}

const app = createApp();

beforeEach(() => {
  delete process.env.OPS_TOKEN;
  delete process.env.VEIL_FEE_REPORT_TOKEN;
  delete process.env.METRICS_SCRAPE_TOKEN;
});

describe("read API (src/api.ts)", () => {
  it("/status: an unavailable database", async () => {
    mockGetLastIndexedLedger.mockRejectedValue(new Error("DB connection lost"));

    const res = await request(app).get("/status");

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expectErrorCode(res.body, "internal_error");
  });

  it("/nfts/owners/:contract/:token_id: no indexed owner", async () => {
    mockGetNftOwner.mockResolvedValue(null);
    mockGetNftMetadata.mockResolvedValue(null);

    const res = await request(app).get(`/nfts/owners/${CONTRACT}/1`);

    expect(res.status).toBe(404);
    expectErrorCode(res.body, "not_found");
  });

  it("/accounts/:address/transfers: an unreadable date", async () => {
    const res = await request(app).get(`/accounts/${ALICE}/transfers?fromDate=not-a-date`);

    expect(res.status).toBe(400);
    expectErrorCode(res.body, "invalid_request");
  });
});

describe("webhooks (src/api/webhooks.ts)", () => {
  it("DELETE /webhooks/:id: no such subscription", async () => {
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(appWith(createWebhooksRouter(), "/webhooks")).delete("/webhooks/999");

    expect(res.status).toBe(404);
    expectErrorCode(res.body, "not_found");
  });
});

describe("candles (src/api/candles.ts)", () => {
  const candles = appWith(createCandlesRouter(), "/candles");

  it("a failed aggregate query", async () => {
    mockQueryRawUnsafe.mockRejectedValue(new Error("relation does not exist"));

    const res = await request(candles).get(`/candles/1m/${CONTRACT}`);

    expect(res.status).toBe(500);
    expectErrorCode(res.body, "internal_error");
  });

  it("a bucket the schema does not accept", async () => {
    const res = await request(candles).get(`/candles/5m/${CONTRACT}`);

    expect(res.status).toBe(400);
    expectErrorCode(res.body, "invalid_request");
  });
});

describe("ops (src/api/ops.ts)", () => {
  const ops = appWith(createOpsRouter(), "/ops");

  it("an unconfigured deployment", async () => {
    const res = await request(ops).get("/ops/failures");

    expect(res.status).toBe(503);
    expectErrorCode(res.body, "not_configured");
  });

  it("a bad query parameter", async () => {
    process.env.OPS_TOKEN = "test-ops-token";

    const res = await request(ops)
      .get("/ops/failures?limit=not-a-number")
      .set("Authorization", "Bearer test-ops-token");

    expect(res.status).toBe(400);
    expectErrorCode(res.body, "invalid_request");
  });

  it("a missing operator token", async () => {
    process.env.OPS_TOKEN = "test-ops-token";

    const res = await request(ops).get("/ops/failures");

    expect(res.status).toBe(401);
    expectErrorCode(res.body, "unauthorized");
  });
});

describe("fees (src/api/fees.ts)", () => {
  const fees = appWith(feesRouter(), "/fees");

  it("an unconfigured fee report", async () => {
    const res = await request(fees).get("/fees/report");

    expect(res.status).toBe(503);
    expectErrorCode(res.body, "not_configured");
  });

  it("a malformed report range", async () => {
    process.env.VEIL_FEE_REPORT_TOKEN = "test-report-token";

    const res = await request(fees)
      .get("/fees/report?from=27-11-2026")
      .set("Authorization", "Bearer test-report-token");

    expect(res.status).toBe(400);
    expectErrorCode(res.body, "invalid_request");
  });
});

describe("shared gates", () => {
  it("the metrics scrape guard refuses a wrong token with a code", async () => {
    process.env.METRICS_SCRAPE_TOKEN = "test-scrape-token";
    const app = express();
    app.get("/metrics", metricsAccessGuard, (_req, res) => res.send("ok"));

    const res = await request(app).get("/metrics").set("Authorization", "Bearer wrong");

    expect(res.status).toBe(403);
    expectErrorCode(res.body, "forbidden");
  });

  it("the app-wide 404 carries a code", async () => {
    const res = await request(app).get("/no-such-route");

    expect(res.status).toBe(404);
    expectErrorCode(res.body, "not_found");
  });
});
