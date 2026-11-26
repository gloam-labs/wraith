/**
 * A request body never reaches the log.
 *
 * When the body parser cannot read a request, the error it raises carries the
 * whole raw body. The global handler used to log that error as it was, so a
 * malformed request to a route that takes a national ID number or bank details
 * would have written them to the service log. These tests send a body with a
 * marker in it and check the marker is nowhere in what was logged.
 */

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
    webhookSubscription: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    offrampOrder: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1050),
}));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
  isIndexerRunning: jest.fn().mockReturnValue(false),
  isIndexerStopped: jest.fn().mockReturnValue(false),
  getIndexerUnstartedReason: jest.fn(),
}));

// The real application still mounts its routers and middleware. Only the
// GraphQL server is replaced, to avoid starting its background work.
jest.mock("../graphql/server", () => ({
  createGraphQLMiddleware: () => {
    const router = require("express").Router();
    router.post("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    router.get("/", (_req: unknown, res: { json: (body: unknown) => void }) => res.json({ data: {} }));
    return router;
  },
}));

import { createApp } from "../api";
import { bodyParseFailure, loggableError } from "../utils/bodyError";

// A stand-in for something private. Not a real identifier of any kind.
const MARKER = "PRIVATE-MARKER-0000";

function logged(...spies: jest.SpyInstance[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) =>
      call
        .map((part: unknown) =>
          part instanceof Error
            ? `${part.message} ${JSON.stringify(part, Object.getOwnPropertyNames(part))}`
            : typeof part === "string"
              ? part
              : JSON.stringify(part),
        )
        .join(" "),
    )
    .join(" | ");
}

describe("an unreadable request body", () => {
  let error: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(console, "error").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    log = jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const paths = ["/ngn/customers/kyc", "/offramp/orders", "/webhooks"];

  it.each(paths)("is answered 400 on %s, not 500", async (path) => {
    const res = await request(createApp())
      .post(path)
      .set("Content-Type", "application/json")
      .send(`{"value":"${MARKER}",`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "The request body could not be read", code: "invalid_request" });
    expect(JSON.stringify(res.body)).not.toContain(MARKER);
  });

  it.each(paths)("is not written to the log on %s", async (path) => {
    await request(createApp())
      .post(path)
      .set("Content-Type", "application/json")
      .send(`{"value":"${MARKER}",`);

    expect(logged(error, warn, log)).not.toContain(MARKER);
  });
});

describe("bodyParseFailure", () => {
  it("recognises the body parser's own failures", () => {
    expect(bodyParseFailure({ type: "entity.parse.failed", status: 400, body: "x" })).toEqual({
      status: 400,
      type: "entity.parse.failed",
    });
    expect(bodyParseFailure({ type: "entity.too.large", statusCode: 413 })).toEqual({
      status: 413,
      type: "entity.too.large",
    });
  });

  it("leaves every other error alone", () => {
    expect(bodyParseFailure(new Error("boom"))).toBeNull();
    expect(bodyParseFailure({ type: "something.else", status: 400 })).toBeNull();
    expect(bodyParseFailure({ type: "entity.parse.failed", status: 500 })).toBeNull();
    expect(bodyParseFailure(null)).toBeNull();
    expect(bodyParseFailure("entity.parse.failed")).toBeNull();
  });
});

describe("loggableError", () => {
  it("keeps the name, message and stack and drops everything attached", () => {
    const err = Object.assign(new Error("driver failed"), { body: MARKER, config: { headers: { a: MARKER } } });
    const safe = loggableError(err);
    expect(safe.message).toBe("driver failed");
    expect(safe.stack).toContain("driver failed");
    expect(JSON.stringify(safe)).not.toContain(MARKER);
  });

  it("does not print a thrown object", () => {
    expect(JSON.stringify(loggableError({ secret: MARKER }))).not.toContain(MARKER);
  });
});
