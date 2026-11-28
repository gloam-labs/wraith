/**
 * Unit tests for reconcileOfframpOrder that run the real function.
 *
 * The route-level tests in src/__tests__/routes/offramp.test.ts mock
 * reconcileOfframpOrder entirely, so they cannot catch bugs inside it.
 * These tests mock prisma and the counter instead, and exercise the real
 * reconciliation logic directly.
 *
 * What is covered:
 *   - Polling a failed order twice records exactly one failure — the counter
 *     and the upsert fire only on the status transition, never on a repeat
 *     poll of an already-failed row.
 *   - A missing amount (provider omitted the field) leaves settledStableCoin
 *     and settledNGN untouched — no write of the text "undefined".
 *   - Settled figures are only written on a settlement transition, not on
 *     intermediate status changes like "processing".
 *   - An unchanged status returns true without writing the order row, but
 *     still applies any extra fields (txHash, settled amounts) the event
 *     carries.
 */

import type { OfframpOrder } from "@prisma/client";

// ─── Mock prisma ─────────────────────────────────────────────────────────────

type Row = Partial<OfframpOrder> & Record<string, unknown>;

let store: Row | null = null;

const mockFindUnique = jest.fn(async (_args?: unknown) => store);
const mockUpdate = jest.fn(async (args?: unknown) => {
  const { data } = (args ?? {}) as { data?: Row };
  if (data) Object.assign(store!, data);
  return store;
});
const mockUpsert = jest.fn(async (_args?: unknown) => ({}));

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: {
      findUnique: (args: unknown) => mockFindUnique(args),
      update: (args: unknown) => mockUpdate(args),
    },
    moneyFailure: {
      upsert: (args: unknown) => mockUpsert(args),
    },
  },
}));

// ─── Mock metrics counter (prom-client throws outside a real registry) ───────

const mockMoneyFailuresInc = jest.fn();
const mockOrderTerminalInc = jest.fn();

jest.mock("../../metrics", () => ({
  ...jest.requireActual("../../metrics"),
  moneyFailuresTotal: { inc: (...args: unknown[]) => mockMoneyFailuresInc(...args) },
  transfersStoredTotal: { inc: jest.fn() },
  ordersTerminalTotal: { inc: (...args: unknown[]) => mockOrderTerminalInc(...args) },
  terminalStatusOf: jest.requireActual("../../metrics").terminalStatusOf,
  recordOrderTerminal: jest.requireActual("../../metrics").recordOrderTerminal,
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { reconcileOfframpOrder } from "../offrampOrders";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRow(over: Partial<Row> = {}): Row {
  return {
    id: 1,
    network: "testnet",
    orderId: "linq-order-001",
    publicId: "ofr_AAAAAAAAAAAAAAAAAAAAAA",
    accessTokenHash: "abc123",
    idempotencyKey: "key-1",
    walletAddress: "GAAA",
    requestHash: null,
    depositAddress: "GDEP",
    chain: "stellar",
    coin: "usdc",
    amountStableCoin: "50",
    amountNGN: "82750",
    rate: "1655",
    status: "initiated",
    settledStableCoin: null,
    settledNGN: null,
    depositTxHash: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const BASE_EVENT = {
  orderId: "linq-order-001",
  network: "testnet",
  event: "failed",
  status: "failed",
  amountStableCoin: 50,
  amountNGN: 82750,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  store = makeRow();
  mockFindUnique.mockClear();
  mockUpdate.mockClear();
  mockUpsert.mockClear();
  mockMoneyFailuresInc.mockClear();
  mockOrderTerminalInc.mockClear();
});

describe("reconcileOfframpOrder — idempotency on repeated polls", () => {
  it("polling a failed order twice records one failure, not two", async () => {
    // First poll: status changes initiated → failed.
    await reconcileOfframpOrder(BASE_EVENT);

    // moneyFailuresTotal.inc fires once, and one upsert is attempted.
    expect(mockMoneyFailuresInc).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // Second poll: status is already "failed" in the store. Neither the
    // counter nor the upsert should fire again — the failure was recorded on
    // the transition, not on every subsequent sighting.
    mockMoneyFailuresInc.mockClear();
    mockUpsert.mockClear();
    mockUpdate.mockClear();

    await reconcileOfframpOrder(BASE_EVENT);

    // Row update skipped — no second write to the order row.
    expect(mockUpdate).not.toHaveBeenCalled();
    // Counter and upsert must not fire on a repeat poll of an already-failed order.
    expect(mockMoneyFailuresInc).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("returns true on the second (no-op) poll without a row update", async () => {
    await reconcileOfframpOrder(BASE_EVENT);
    const result = await reconcileOfframpOrder(BASE_EVENT);
    expect(result).toBe(true);
    // Update was called only on the first poll.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileOfframpOrder — missing amounts", () => {
  it("does not store 'undefined' when the provider omits amounts", async () => {
    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "processing",
      status: "processing",
      amountStableCoin: undefined,
      amountNGN: undefined,
    });

    // The update must not carry settledStableCoin or settledNGN at all.
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = (mockUpdate.mock.calls[0][0] as { data: Row }).data;
    expect(written).not.toHaveProperty("settledStableCoin");
    expect(written).not.toHaveProperty("settledNGN");
    // And the string "undefined" must never appear in the written data.
    expect(JSON.stringify(written)).not.toContain("undefined");
  });

  it("leaves settled fields untouched on a non-settlement transition", async () => {
    store = makeRow({ settledStableCoin: null, settledNGN: null });

    // A "processing" update with amounts present — not a settlement.
    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "processing",
      status: "processing",
      amountStableCoin: 50,
      amountNGN: 82750,
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = (mockUpdate.mock.calls[0][0] as { data: Row }).data;
    // Amounts must not have been written on a non-settlement transition.
    expect(written).not.toHaveProperty("settledStableCoin");
    expect(written).not.toHaveProperty("settledNGN");
  });
});

describe("reconcileOfframpOrder — settled figures on settlement only", () => {
  it("writes settledStableCoin and settledNGN only when the transition is to settled", async () => {
    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "settled",
      status: "settled",
      amountStableCoin: 50,
      amountNGN: 82750,
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = (mockUpdate.mock.calls[0][0] as { data: Row }).data;
    expect(written.settledStableCoin).toBe("50");
    expect(written.settledNGN).toBe("82750");
  });

  it("does not write settled amounts on a non-terminal transition", async () => {
    // "processing" is not terminal — amounts must not be stored.
    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "processing",
      status: "processing",
      amountStableCoin: 50,
      amountNGN: 82750,
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = (mockUpdate.mock.calls[0][0] as { data: Row }).data;
    expect(written).not.toHaveProperty("settledStableCoin");
    expect(written).not.toHaveProperty("settledNGN");
  });
});

describe("reconcileOfframpOrder — no-op on unchanged status", () => {
  it("does write when the status changes even if amounts are the same", async () => {
    store = makeRow({ status: "initiated" });

    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "processing",
      status: "processing",
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it("writes txHash when the event carries one, even if the status is unchanged", async () => {
    store = makeRow({ status: "settled", depositTxHash: null });

    await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "settled",
      status: "settled",
      txHash: "abc123txhash",
    });

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const written = (mockUpdate.mock.calls[0][0] as { data: Row }).data;
    expect(written.depositTxHash).toBe("abc123txhash");
    // The money-failure counter must not fire — no status change.
    expect(mockMoneyFailuresInc).not.toHaveBeenCalled();
  });

  it("does not write when the status is unchanged and no extra fields are present", async () => {
    store = makeRow({ status: "processing" });

    const result = await reconcileOfframpOrder({
      orderId: "linq-order-001",
      network: "testnet",
      event: "processing",
      status: "processing",
    });

    expect(result).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
