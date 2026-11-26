/**
 * Status-poll behaviour for GET /ngn/bills/:orderId and
 * GET /ngn/onramp/orders/:orderId (#464).
 *
 * This file pins three things the existing test suite left unguarded:
 *
 *   1. The bills route translates the provider's status word so installed apps
 *      can recognise it (billStatusForClients). If the translation is removed
 *      the tests here fail.
 *
 *   2. The raw provider word is returned alongside the translated one as
 *      providerStatus. No test file in the repo mentioned that field before
 *      this one.
 *
 *   3. orders_terminal_total is incremented exactly once — the first time an
 *      ending is seen — via the shared reconcileTerminalStatus path. If the
 *      route starts reconciling on the translated value instead of the raw one
 *      the counter test fails (a translated "settled (completed)" does not
 *      parse as a terminal status via terminalStatusOf).
 *
 * No phone number, meter number or NIN appears anywhere below. All ids and
 * references are plainly fake.
 *
 * The provider-down fallback is not tested here; that is open issue #419.
 */
import express from "express";
import request from "supertest";

import { createNgnRouter } from "../../api/ngn";
import { networkMiddleware } from "../../middleware/network";
import { registry, _resetMetrics } from "../../metrics";

process.env.LINQ_API_KEY = "biz_live_test_status";

// ─── Mocks (mirror the setup in ngn.test.ts) ─────────────────────────────────

jest.mock("../../linq/onramp", () => {
  const actual = jest.requireActual("../../linq/onramp");
  return {
    ...actual,
    provisionCustomer: jest.fn(),
    getCustomerStatus: jest.fn(),
    submitCustomerKyc: jest.fn(),
    getOnrampRate: jest.fn(),
    createOnrampOrder: jest.fn(),
    getOnrampStatus: jest.fn(),
  };
});

jest.mock("../../linq/bills", () => {
  const actual = jest.requireActual("../../linq/bills");
  return { ...actual, payBill: jest.fn(), getBillStatus: jest.fn() };
});

jest.mock("../../linq/client", () => {
  const actual = jest.requireActual("../../linq/client");
  return { ...actual, getRate: jest.fn() };
});

jest.mock("../../linq/ngnOrders", () => ({
  recordNgnOrder: jest.fn().mockResolvedValue(undefined),
  findNgnOrder: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../linq/coinPrice", () => ({
  usdPerCoin: jest.fn(),
  __clearCoinPriceCache: jest.fn(),
}));

import { getBillStatus } from "../../linq/bills";
import { getOnrampStatus } from "../../linq/onramp";
import { findNgnOrder, recordNgnOrder } from "../../linq/ngnOrders";
import { __clearNgnRateCache } from "../../api/ngn";

const mockGetBillStatus   = getBillStatus   as jest.Mock;
const mockGetOnrampStatus = getOnrampStatus as jest.Mock;
const mockFindNgnOrder    = findNgnOrder    as jest.Mock;
const mockRecordNgnOrder  = recordNgnOrder  as jest.Mock;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(networkMiddleware);
  app.use("/ngn", createNgnRouter());
  return app;
}

/** All these routes are mainnet-only. */
const mainnet = (r: request.Test) => r.set("x-network", "mainnet");

/**
 * A minimal stored row for the order — no personal data, no bank details.
 * `status` defaults to "initiated" so reconcileTerminalStatus sees a
 * non-terminal previous status and counts exactly one transition.
 */
function storedRow(orderId: string, status = "initiated") {
  return {
    orderId,
    customerRef: "ref-test-001",
    walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
    status,
    kind: "bill",
    coin: "xlm",
    amountStableCoin: "0.75",
    amountNGN: "1000",
    rate: "1333",
    billCategory: "airtime",
    provider: "FAKEMTN",
    settledStableCoin: null,
    settledNGN: null,
    txHash: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** A minimal live BillStatus payload from the provider — no personal data. */
function liveStatus(orderId: string, status: string) {
  return {
    orderId,
    customerRef: "ref-test-001",
    status,
    billCategory: "airtime",
    amountNgn: 1000,
    amountStableCoin: 0.75,
    wallet: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
    description: "Fake airtime top-up for testing",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:01Z",
  };
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  process.env.LINQ_API_KEY = "biz_live_test_status";
  process.env.NETWORKS = "testnet,mainnet";
  jest.clearAllMocks();
  __clearNgnRateCache();
  _resetMetrics();
});

// ─── Bills status poll ────────────────────────────────────────────────────────

describe("GET /ngn/bills/:orderId — status translation (#464)", () => {
  const ORDER_ID   = "bill-fake-0001";
  const CUST_REF   = "ref-test-001";
  const BILL_URL   = `/ngn/bills/${ORDER_ID}?customerRef=${CUST_REF}`;

  /**
   * "settled" is what Linq says. The bills screen ends on words like
   * "completed", "delivered", "success". Without billStatusForClients
   * the screen spins forever after a successful vend.
   *
   * Falsifiability: remove billStatusForClients from the route and this test
   * fails because res.body.status would be "settled" instead of
   * "settled (completed)".
   */
  it("translates 'settled' into a word the bills screen ends on", async () => {
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));

    const res = await mainnet(request(makeApp()).get(BILL_URL));

    expect(res.status).toBe(200);
    // The translated value must contain "completed" so the bills screen
    // recognises it as a win and leaves the waiting state.
    expect(res.body.status).toContain("completed");
    // The raw provider word is preserved alongside the translation.
    expect(res.body.providerStatus).toBe("settled");
  });

  it("translates 'disbursed' the same way", async () => {
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "disbursed"));

    const res = await mainnet(request(makeApp()).get(BILL_URL));

    expect(res.status).toBe(200);
    expect(res.body.status).toContain("completed");
    expect(res.body.providerStatus).toBe("disbursed");
  });

  it("translates a failed bill into a word the screen knows as a loss", async () => {
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "failed"));

    const res = await mainnet(request(makeApp()).get(BILL_URL));

    expect(res.status).toBe(200);
    // "failed" is already in the vocabulary — the status passes through.
    expect(res.body.status).toContain("failed");
    expect(res.body.providerStatus).toBe("failed");
  });

  it("translates a refunded bill into a loss word the screen knows", async () => {
    // "refunded" is NOT in the bills screen vocabulary but statusForClients
    // appends "(failed)" for refund/cancel/reverse endings so it reaches the
    // failure state rather than the spinner.
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "refunded"));

    const res = await mainnet(request(makeApp()).get(BILL_URL));

    expect(res.status).toBe(200);
    expect(res.body.status).toContain("failed");
    expect(res.body.providerStatus).toBe("refunded");
  });

  it("passes an in-progress status through unchanged", async () => {
    // "processing" is not a terminal word and needs no translation.
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "processing"));

    const res = await mainnet(request(makeApp()).get(BILL_URL));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processing");
    expect(res.body.providerStatus).toBe("processing");
  });

  /**
   * The route must reconcile on the raw provider word, never the translated one.
   *
   * Falsifiability: change the route to reconcile on
   * billStatusForClients(live.status) instead of live.status and this test
   * fails: terminalStatusOf("settled (completed)") returns null because the
   * translated string is not in its vocabulary, so no terminal transition is
   * recorded and the counter stays at 0.
   */
  it("writes the provider's raw word into the row, not the translated word", async () => {
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));

    await mainnet(request(makeApp()).get(BILL_URL));

    // recordNgnOrder is the write path inside reconcileTerminalStatus.
    // Its `status` argument must be the raw provider word.
    const writeCall = mockRecordNgnOrder.mock.calls.find(
      (args: unknown[]) => (args[0] as Record<string, unknown>)?.orderId === ORDER_ID,
    );
    expect(writeCall).toBeDefined();
    // The row must carry "settled", not "settled (completed)".
    expect((writeCall![0] as Record<string, unknown>).status).toBe("settled");
  });

  /**
   * orders_terminal_total goes up by one the first time an ending is seen,
   * and does not go up on the second poll.
   *
   * Falsifiability: reconcile on the translated value and this test fails
   * (counter stays at 0 because the translation is not terminal).
   * Additionally, if the route called recordOrderTerminal directly (instead of
   * going through reconcileTerminalStatus) the second-poll assertion would fail.
   */
  it("increments orders_terminal_total once on the first ending poll", async () => {
    const app = makeApp();
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));

    await mainnet(request(app).get(BILL_URL));

    const after1 = await registry.metrics();
    expect(after1).toContain('orders_terminal_total{rail="bills",status="settled"} 1');
  });

  it("does not increment orders_terminal_total on the second poll (wasTerminal guard)", async () => {
    const app = makeApp();
    // First poll: row was non-terminal, provider says settled.
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID, "initiated"));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));
    await mainnet(request(app).get(BILL_URL));

    // Second poll: row is now terminal (simulate the write having persisted).
    mockFindNgnOrder.mockResolvedValue(storedRow(ORDER_ID, "settled"));
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));
    await mainnet(request(app).get(BILL_URL));

    const text = await registry.metrics();
    // Still exactly 1, not 2.
    expect(text).toContain('orders_terminal_total{rail="bills",status="settled"} 1');
  });

  it("does not increment orders_terminal_total when there is no stored row", async () => {
    // No recorded row means no transition to observe. The counter documents
    // "transitions", not "polls of a finished order".
    mockFindNgnOrder.mockResolvedValue(null);
    mockGetBillStatus.mockResolvedValue(liveStatus(ORDER_ID, "settled"));

    await mainnet(request(makeApp()).get(BILL_URL));

    const text = await registry.metrics();
    expect(text).not.toContain("orders_terminal_total{");
  });
});

// ─── Onramp status poll ───────────────────────────────────────────────────────

describe("GET /ngn/onramp/orders/:orderId — provider body pinned (#464)", () => {
  const ORDER_ID   = "onramp-fake-0001";
  const CUST_REF   = "ref-test-002";
  const ONRAMP_URL = `/ngn/onramp/orders/${ORDER_ID}?customerRef=${CUST_REF}`;

  function liveOnrampStatus(status: string) {
    return {
      orderId: ORDER_ID,
      customerRef: CUST_REF,
      status,
      amountNgn: 8137,
      amountStableCoin: 6,
      walletAddress: "GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
      accountNumber: "0000000000",
      bankName: "Test Bank",
      accountName: "Test Account",
      fee: 0,
      expiresAt: "2026-01-01T01:00:00Z",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:01Z",
    };
  }

  /**
   * The onramp route answers the provider's body as-is (no translation).
   * Pin it so a change — intentional or not — becomes a decision, not an accident.
   */
  it("passes the provider's status through unchanged", async () => {
    mockFindNgnOrder.mockResolvedValue(null);
    mockGetOnrampStatus.mockResolvedValue(liveOnrampStatus("completed"));

    const res = await mainnet(request(makeApp()).get(ONRAMP_URL));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    // The onramp route does not add providerStatus; pin that it is absent.
    expect(res.body.providerStatus).toBeUndefined();
  });

  it("passes an in-progress onramp status through unchanged", async () => {
    mockFindNgnOrder.mockResolvedValue(null);
    mockGetOnrampStatus.mockResolvedValue(liveOnrampStatus("processing"));

    const res = await mainnet(request(makeApp()).get(ONRAMP_URL));

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processing");
  });

  it("increments orders_terminal_total once when an onramp order ends", async () => {
    const app = makeApp();
    // Row exists with a non-terminal status so the transition is counted.
    mockFindNgnOrder.mockResolvedValue({
      ...storedRow(ORDER_ID),
      kind: "onramp",
      billCategory: null,
      provider: null,
      status: "initiated",
    });
    mockGetOnrampStatus.mockResolvedValue(liveOnrampStatus("completed"));

    await mainnet(request(app).get(ONRAMP_URL));

    const text = await registry.metrics();
    expect(text).toContain('orders_terminal_total{rail="onramp",status="completed"} 1');
  });
});
