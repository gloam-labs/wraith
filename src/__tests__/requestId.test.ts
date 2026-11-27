/**
 * One id per request, from the first middleware to the last.
 *
 * `src/middleware/requestId.ts` existed for a long time without anything
 * mounting it, so no response carried `x-request-id` and no log line written
 * during a request said which request it belonged to. These tests pin the two
 * things that were missing: every answer carries the id — including the ones
 * that never reach a route handler — and the id a 500 reports is the id the
 * logs carry, so a support ticket and a log line meet each other.
 */
import type { Request, Response } from "express";
import express from "express";
import request from "supertest";

jest.mock("../db", () => ({
  getLastIndexedLedger: jest.fn().mockResolvedValue(1000),
  queryTransfers: jest.fn(),
  queryAllTransfers: jest.fn(),
  queryByTxHash: jest.fn(),
  querySummary: jest.fn(),
  queryNftTransfers: jest.fn(),
  getNftOwner: jest.fn(),
  getNftMetadata: jest.fn(),
  prisma: {
    $queryRawUnsafe: jest.fn(),
    $queryRaw: jest.fn(),
    webhookSubscription: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    offrampOrder: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn() },
  },
}));

jest.mock("../rpc", () => ({ getLatestLedger: jest.fn().mockResolvedValue(1050) }));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
  isIndexerRunning: jest.fn().mockReturnValue(false),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn(),
}));

// The real app is still the real app. Only GraphQL's background work is skipped.
jest.mock("../graphql/server", () => ({
  createGraphQLMiddleware: () => {
    const router = require("express").Router();
    router.post("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    router.get("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    return router;
  },
}));

jest.mock("../linq/client", () => ({
  ...jest.requireActual("../linq/client"),
  createOfframpOrder: jest.fn(),
  verifyBank: jest.fn(),
  checkStellarTrustline: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

import { createApp, clearRpcHealthCache } from "../api";
import { queryTransfers } from "../db";
import { getRequestId, logger, withRequestId } from "../logger";
import { isUsableRequestId, requestId } from "../middleware/requestId";

const HEADER = "x-request-id";
const MINTED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Run the middleware over a header value a caller sent.
 *
 * A socket cannot carry CRLF inside a header — Node refuses to write it — so
 * the values this module has to survive are handed to it directly. That is the
 * honest way to test what it does with a hostile id.
 */
function run(inbound: unknown): { echoed: string; insideContext: string | undefined } {
  let echoed = "";
  let insideContext: string | undefined;
  const req = { headers: inbound === undefined ? {} : { [HEADER]: inbound } } as unknown as Request;
  const res = {
    setHeader: (_name: string, value: unknown) => {
      echoed = String(value);
    },
  } as unknown as Response;

  requestId(req, res, () => {
    insideContext = getRequestId();
  });
  return { echoed, insideContext };
}

describe("what counts as a usable inbound id", () => {
  it("takes a plain id of any sensible length", () => {
    expect(isUsableRequestId("abc-123")).toBe(true);
    expect(isUsableRequestId("a".repeat(128))).toBe(true);
  });

  it("refuses an id that could end a log line or a header", () => {
    expect(isUsableRequestId("a".repeat(129))).toBe(false);
    expect(isUsableRequestId("")).toBe(false);
    expect(isUsableRequestId("   ")).toBe(false);
    expect(isUsableRequestId("ok\r\ninjected: line")).toBe(false);
    expect(isUsableRequestId("ok\ttab")).toBe(false);
    expect(isUsableRequestId("ok\u0000null")).toBe(false);
    expect(isUsableRequestId("café")).toBe(false);
    expect(isUsableRequestId(undefined)).toBe(false);
    expect(isUsableRequestId(["a", "b"])).toBe(false);
  });
});

describe("the middleware", () => {
  it("honours an id the caller sent, so a trace spans services", () => {
    expect(run("trace-from-the-app")).toEqual({
      echoed: "trace-from-the-app",
      insideContext: "trace-from-the-app",
    });
  });

  it("mints an id when the caller sent none", () => {
    const { echoed, insideContext } = run(undefined);
    expect(echoed).toMatch(MINTED);
    expect(insideContext).toBe(echoed);
  });

  it.each([
    ["a line break", "forged\r\nx-injected: 1"],
    ["a control character", "forged\tid"],
    ["a non-ASCII character", "forged☃id"],
    ["nothing but spaces", "     "],
    ["more than 128 characters", "a".repeat(200)],
  ])("replaces an id carrying %s instead of echoing it", (_name, inbound) => {
    const { echoed, insideContext } = run(inbound);
    expect(echoed).toMatch(MINTED);
    expect(echoed).not.toContain("forged");
    expect(insideContext).toBe(echoed);
  });

  it("carries the id into the handler it runs, and into the line it logs", async () => {
    const app = express();
    app.use(requestId);
    app.get("/probe", (req, res) => {
      logger.info("probe.handler", { route: "/probe" });
      res.json({ inside: getRequestId(), onReq: (req as unknown as { requestId: string }).requestId });
    });

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => void lines.push(String(line));
    try {
      const res = await request(app).get("/probe").set(HEADER, "trace-from-the-app");
      expect(res.body).toEqual({ inside: "trace-from-the-app", onReq: "trace-from-the-app" });
      // The line the handler wrote carries the id: that is the whole point.
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).requestId).toBe("trace-from-the-app");
    } finally {
      console.log = originalLog;
    }
  });

  it("keeps the id through an await, and drops it afterwards", async () => {
    expect(getRequestId()).toBeUndefined();
    await withRequestId("scoped", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getRequestId()).toBe("scoped");
    });
    expect(getRequestId()).toBeUndefined();
  });
});

describe("the real API", () => {
  const originalEnv = { ...process.env };
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    process.env.NETWORKS = "testnet";
    process.env.STELLAR_NETWORK = "testnet";
    process.env.CACHE_ENABLED = "false";
    process.env.LINQ_API_KEY = "test-key";
    process.env.LINQ_WEBHOOK_SECRET = "whsec_test";
    // One failed lookup per window, so a test can meet a real 429 without
    // sending sixty requests. Read when the router is built, i.e. right here.
    process.env.OFFRAMP_LOOKUP_MAX_FAILURES = "1";
    clearRpcHealthCache();
    app = createApp();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("carries the id on an ordinary response", async () => {
    const res = await request(app).get("/healthz").set(HEADER, "health-check-1");
    expect(res.status).toBeLessThan(500);
    expect(res.headers[HEADER]).toBe("health-check-1");
  });

  it("carries it on a 404, which never reaches a handler", async () => {
    const res = await request(app).get("/no-such-route").set(HEADER, "missing-1");
    expect(res.status).toBe(404);
    expect(res.headers[HEADER]).toBe("missing-1");
  });

  it("carries it on a 429, which the limiter answers before any route runs", async () => {
    const first = await request(app).get("/offramp/orders/order-1");
    expect(first.status).toBe(401);

    const second = await request(app).get("/offramp/orders/order-1").set(HEADER, "throttled-1");
    expect(second.status).toBe(429);
    expect(second.headers[HEADER]).toBe("throttled-1");
  });

  it("carries it on the raw-body webhook, mounted before the JSON parser", async () => {
    const res = await request(app)
      .post("/webhooks/linq")
      .set(HEADER, "callback-1")
      .set("x-linq-signature", "sha256=nope")
      .send({ event: "order.completed" });
    expect(res.headers[HEADER]).toBe("callback-1");
  });

  it("carries it on a Discord interaction and on an origin CORS refuses", async () => {
    const interaction = await request(app).post("/discord/interactions").set(HEADER, "discord-1").send({});
    expect(interaction.headers[HEADER]).toBe("discord-1");

    const refused = await request(app)
      .get("/ngn/onramp/rate")
      .set(HEADER, "cors-1")
      .set("Origin", "https://evil.example");
    expect(refused.status).toBe(403);
    expect(refused.headers[HEADER]).toBe("cors-1");
  });

  it("mints its own id when the caller sends one that is too long", async () => {
    const res = await request(app).get("/healthz").set(HEADER, "a".repeat(200));
    expect(res.headers[HEADER]).toMatch(MINTED);
  });

  it("answers with one id: a 500's correlationId is the id on its header", async () => {
    // This is the case the two ids used to get wrong. A person reports a failed
    // cash-out by the id on their screen, and the provider call that failed
    // logged its lines under that same id rather than an unrelated one.
    (queryTransfers as jest.Mock).mockRejectedValueOnce(new Error("connect to postgres://secret-host failed"));

    const res = await request(app).get("/transfers/incoming/GABCDEF").set(HEADER, "one-id-only");

    expect(res.status).toBe(500);
    expect(res.headers[HEADER]).toBe("one-id-only");
    expect(res.body.correlationId).toBe("one-id-only");
    expect(JSON.stringify(res.body)).not.toContain("secret-host");
    expect(JSON.stringify(res.body)).not.toContain("postgres://");
  });

  it("tells a browser page it may read the id", async () => {
    const open = await request(app).get("/tokens").set("Origin", "https://anyone.example");
    expect(open.headers["access-control-allow-origin"]).toBe("*");
    expect(open.headers["access-control-expose-headers"]).toMatch(/x-request-id/i);

    const listed = await request(app).get("/offramp/availability").set("Origin", "https://wallet.example.com");
    expect(listed.headers["access-control-expose-headers"]).toMatch(/x-request-id/i);
  });

  it("still gives the provider callback no CORS headers at all", async () => {
    const res = await request(app)
      .post("/webhooks/linq")
      .set("Origin", "https://anyone.example")
      .set("x-linq-signature", "sha256=nope")
      .send({ event: "order.completed" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-expose-headers"]).toBeUndefined();
  });
});
