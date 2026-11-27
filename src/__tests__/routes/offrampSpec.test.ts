/**
 * Spec–handler agreement for the offramp routes (#467).
 *
 * Each test calls the real router with a mocked provider and validates the
 * response body against the Zod schema registered in src/openapi/schemas.ts
 * for that status code.  If the schema and the handler disagree, the test
 * fails — which is what prevents the two from drifting silently again.
 *
 * What is covered:
 *   - POST /offramp/orders → 201 (create)
 *   - POST /offramp/orders → 200 (replay)
 *   - GET  /offramp/orders/:id → 200 live (provider answered)
 *   - GET  /offramp/orders/:id → 200 cache (provider down)
 *   - GET  /offramp/orders/:id → 401 (no token)
 *   - GET  /offramp/orders/:id → 404 (wrong token)
 *   - POST /offramp/orders → 409 (idempotency conflict)
 *
 * No bank details, real names, phone numbers or real-looking tokens appear
 * anywhere below.  All ids and secrets are plainly fake.
 */
import express from "express";
import request from "supertest";
import {
  offrampOrderResponseSchema,
  offrampOrderStatusResponseSchema,
  railErrorResponseSchema,
} from "../../openapi/schemas";
import { createOfframpRouter } from "../../api/offramp";
import { networkMiddleware } from "../../middleware/network";

process.env.LINQ_API_KEY = "test-key-spec";

// ─── Mocks ────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const rows: Row[] = [];
let nextId = 1;

const mockFindUnique = jest.fn(async ({ where }: { where: Row }) => {
  const [key, value] = Object.entries(where)[0] as [string, Row];
  const fields = key.split("_");
  return rows.find((r) => fields.every((f) => r[f] === (value as Row)[f])) ?? null;
});

const mockUpdate = jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
  const row = (where as { id?: number }).id
    ? rows.find((r) => r.id === (where as { id: number }).id)
    : rows.find(
        (r) =>
          r.network === (where.network_orderId as Row)?.network &&
          r.orderId === (where.network_orderId as Row)?.orderId,
      ) ??
      rows.find(
        (r) =>
          r.network === (where.network_publicId as Row)?.network &&
          r.publicId === (where.network_publicId as Row)?.publicId,
      );
  Object.assign(row!, data);
  return row;
});

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: (args: unknown) => mockFindUnique(args as { where: Row }),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: nextId++, createdAt: new Date("2026-01-01T00:00:00Z"), ...data };
        rows.push(row);
        return row;
      }),
      update: (args: unknown) => mockUpdate(args as { where: Row; data: Row }),
    },
  },
}));

jest.mock("../../linq/client", () => ({
  ...jest.requireActual("../../linq/client"),
  createOfframpOrder: jest.fn(),
  getOfframpStatus: jest.fn(),
}));

jest.mock("../../linq/offrampOrders", () => ({
  reconcileOfframpOrder: jest.fn().mockResolvedValue(true),
}));

jest.mock("../../api/ngn", () => ({
  ngnPerCoin: jest.fn(),
}));

import { createOfframpOrder, getOfframpStatus, LinqError } from "../../linq/client";

const mockCreate = createOfframpOrder as jest.Mock;
const mockStatus = getOfframpStatus as jest.Mock;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A deposit wallet address — no real addresses. */
const DEPOSIT_WALLET = "GDEPOSITFAKEWALLETTESTADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/offramp", createOfframpRouter());
  return app;
}

/** A minimal valid create body — no bank details, plainly fake. */
const CREATE_BODY = {
  amountStableCoin: 50,
  bankAccount: "0000000000",
  bankCode: "000",
  bankName: "Fake Bank",
  accountName: "Spec Test Account",
  walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  idempotencyKey: "spec-key-001",
};

function linqOrderResponse(over: Partial<typeof CREATE_BODY & { id: string }> = {}) {
  return {
    id: over.id ?? "linq-fake-spec-0001",
    walletAddress: DEPOSIT_WALLET,
    coinType: "usdc",
    coin: "usdc",
    chain: "stellar",
    amountStableCoin: 50,
    amountNGN: 82750,
    rate: 1655,
    currency: "NGN",
    status: "initiated",
  };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  rows.length = 0;
  nextId = 1;
  mockCreate.mockReset();
  mockStatus.mockReset();
  mockFindUnique.mockClear();
  mockCreate.mockImplementation(async () => linqOrderResponse());
  mockStatus.mockImplementation(async () => ({
    id: "linq-fake-spec-0001",
    status: "initiated",
    amountStableCoin: 50,
    amountNGN: 82750,
    currency: "NGN",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
  }));
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Parse a Zod schema against a value and return the parse result.
 * Uses safeParse so a failure produces a readable Jest diff rather than a throw.
 */
function validate<T>(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: unknown[] } } }, value: T) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Schema validation failed:\n${JSON.stringify(result.error?.issues, null, 2)}\n\nReceived:\n${JSON.stringify(value, null, 2)}`,
    );
  }
  return result;
}

// ─── POST /offramp/orders — 201 create ───────────────────────────────────────

describe("POST /offramp/orders — 201 create body matches offrampOrderResponseSchema", () => {
  it("response body is valid against the schema", async () => {
    const app = makeApp();
    const res = await request(app).post("/offramp/orders").send(CREATE_BODY);

    expect(res.status).toBe(201);
    // The key assertion: the schema must accept what the handler sends.
    expect(() => validate(offrampOrderResponseSchema, res.body)).not.toThrow();
  });

  it("accessToken is present and starts with 'oft_'", async () => {
    const app = makeApp();
    const res = await request(app).post("/offramp/orders").send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(typeof res.body.accessToken).toBe("string");
    expect(res.body.accessToken).toMatch(/^oft_/);
  });

  it("id is present and starts with 'ofr_'", async () => {
    const app = makeApp();
    const res = await request(app).post("/offramp/orders").send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^ofr_/);
  });
});

// ─── POST /offramp/orders — 200 replay ───────────────────────────────────────

describe("POST /offramp/orders — 200 replay body matches offrampOrderResponseSchema", () => {
  it("replay response body is valid against the schema", async () => {
    const app = makeApp();
    // First create
    await request(app).post("/offramp/orders").send(CREATE_BODY);
    // Replay
    const res = await request(app).post("/offramp/orders").send(CREATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(() => validate(offrampOrderResponseSchema, res.body)).not.toThrow();
  });

  it("replay includes accessToken", async () => {
    const app = makeApp();
    await request(app).post("/offramp/orders").send(CREATE_BODY);
    const res = await request(app).post("/offramp/orders").send(CREATE_BODY);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^oft_/);
  });
});

// ─── GET /offramp/orders/:id — 200 live ──────────────────────────────────────

describe("GET /offramp/orders/:id — 200 live body matches offrampOrderStatusResponseSchema", () => {
  it("live response body is valid against the schema", async () => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);
    expect(created.status).toBe(201);

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("live");
    expect(() => validate(offrampOrderStatusResponseSchema, res.body)).not.toThrow();
  });

  it("providerStatus is present and equals the raw provider word", async () => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);
    mockStatus.mockResolvedValue({
      id: "linq-fake-spec-0001",
      status: "settled",
      amountStableCoin: 50,
      amountNGN: 82750,
      currency: "NGN",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:01Z",
    });

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.providerStatus).toBe("settled");
    // The translated status may differ (statusForClients) but must still parse.
    expect(() => validate(offrampOrderStatusResponseSchema, res.body)).not.toThrow();
  });

  /**
   * The old offrampOrderStatus enum listed only
   * pending / waiting_for_deposit / processing / completed / failed / expired.
   * The handler sends the provider's raw word (e.g. "settled", "disbursed",
   * "refunded (failed)"). These must all pass the schema now that status is
   * z.string() with a description.
   */
  it.each([
    ["initiated"],
    ["processing"],
    ["settled"],
    ["disbursed"],
    ["failed"],
    ["expired"],
    ["refunded"],
    ["refunded (failed)"],
    ["cancelled (failed)"],
    ["expired (timeout)"],
  ])("status value '%s' is accepted by the schema", async (providerStatus) => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);
    mockStatus.mockResolvedValue({
      id: "linq-fake-spec-0001",
      status: providerStatus,
      amountStableCoin: 50,
      amountNGN: 82750,
      currency: "NGN",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:01Z",
    });

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(() => validate(offrampOrderStatusResponseSchema, res.body)).not.toThrow();
  });
});

// ─── GET /offramp/orders/:id — 200 cache ─────────────────────────────────────

describe("GET /offramp/orders/:id — 200 cache body matches offrampOrderStatusResponseSchema", () => {
  it("cached response body is valid against the schema", async () => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);
    expect(created.status).toBe(201);

    // Provider unreachable
    mockStatus.mockRejectedValue(new LinqError("Provider down", 503));

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(created.body.accessToken));

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("cache");
    expect(() => validate(offrampOrderStatusResponseSchema, res.body)).not.toThrow();
  });
});

// ─── GET /offramp/orders/:id — 401 ───────────────────────────────────────────

describe("GET /offramp/orders/:id — 401 error body matches railErrorResponseSchema", () => {
  it("missing token returns a body valid against railErrorResponseSchema", async () => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);

    const res = await request(app).get(`/offramp/orders/${created.body.id}`);

    expect(res.status).toBe(401);
    expect(() => validate(railErrorResponseSchema, res.body)).not.toThrow();
    expect(res.body.code).toBe("unauthorized");
  });
});

// ─── GET /offramp/orders/:id — 404 ───────────────────────────────────────────

describe("GET /offramp/orders/:id — 404 error body matches railErrorResponseSchema", () => {
  it("wrong token returns a body valid against railErrorResponseSchema", async () => {
    const app = makeApp();
    const created = await request(app).post("/offramp/orders").send(CREATE_BODY);
    const other = await request(app)
      .post("/offramp/orders")
      .send({ ...CREATE_BODY, idempotencyKey: "spec-key-002" });

    const res = await request(app)
      .get(`/offramp/orders/${created.body.id}`)
      .set(auth(other.body.accessToken));

    expect(res.status).toBe(404);
    expect(() => validate(railErrorResponseSchema, res.body)).not.toThrow();
    expect(res.body.code).toBe("order_not_found");
  });
});

// ─── POST /offramp/orders — 409 idempotency conflict ─────────────────────────

describe("POST /offramp/orders — 409 idempotency conflict body matches railErrorResponseSchema", () => {
  it("conflicting replay returns a body valid against railErrorResponseSchema", async () => {
    const app = makeApp();
    // First create
    await request(app).post("/offramp/orders").send(CREATE_BODY);
    // Same key, different amount → conflict
    const res = await request(app)
      .post("/offramp/orders")
      .send({ ...CREATE_BODY, amountStableCoin: 999 });

    expect(res.status).toBe(409);
    expect(() => validate(railErrorResponseSchema, res.body)).not.toThrow();
    expect(res.body.code).toMatch(/idempotency_conflict/);
  });
});
