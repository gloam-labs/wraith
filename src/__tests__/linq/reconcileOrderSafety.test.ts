/**
 * Order-safety tests for offramp and NGN (onramp/bill) reconciliation (#448).
 *
 * Proves that a late non-terminal delivery (such as `order.processing` after
 * `order.completed` or `order.failed`) never downgrades a finished order, never
 * overwrites settled amounts, logs one line, returns true, and keeps
 * `orders_terminal_total` at exactly 1 for both the webhook and the periodic
 * sweep.
 */
import express from "express";
import request from "supertest";

type Row = Record<string, any>;

const tables: { offrampOrder: Row[]; ngnOrder: Row[] } = {
  offrampOrder: [],
  ngnOrder: [],
};

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") return (expected as Row[]).some((part) => matches(row, part));
    if (expected !== null && typeof expected === "object") {
      if ("lt" in expected) {
        const actual = row[key];
        return actual != null && new Date(actual).getTime() < new Date(expected.lt).getTime();
      }
      if ("notIn" in expected) return !(expected.notIn as unknown[]).includes(row[key]);
      return Object.entries(expected as Row).every(([field, value]) => row[field] === value);
    }
    return row[key] === expected;
  });
}

function model(table: keyof typeof tables) {
  return {
    findMany: jest.fn(async ({ where, orderBy, take }: Row) => {
      const rows = tables[table]
        .filter((row) => matches(row, where))
        .sort((a, b) => {
          if (orderBy?.createdAt === "asc") {
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          }
          return 0;
        });
      return typeof take === "number" ? rows.slice(0, take) : rows;
    }),
    findUnique: jest.fn(async ({ where }: { where: Row }) => {
      return tables[table].find((row) => matches(row, where)) ?? null;
    }),
    update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const row = tables[table].find((candidate) => matches(candidate, where));
      if (!row) throw new Error("Record not found");
      Object.assign(row, data);
      return row;
    }),
  };
}

jest.mock("../../db", () => ({
  prisma: {
    offrampOrder: model("offrampOrder"),
    ngnOrder: model("ngnOrder"),
    moneyFailure: {
      upsert: jest.fn(async () => ({})),
    },
  },
}));

jest.mock("../../linq/onramp", () => ({ getOnrampStatus: jest.fn() }));
jest.mock("../../linq/bills", () => ({ getBillStatus: jest.fn() }));
jest.mock("../../linq/client", () => ({ getOfframpStatus: jest.fn() }));

import { createLinqWebhookRouter } from "../../api/linqWebhook";
import { prisma } from "../../db";
import { runOrderReconciliationJob } from "../../jobs/orderReconciliation";
import { getBillStatus } from "../../linq/bills";
import { getOfframpStatus } from "../../linq/client";
import { reconcileNgnOrder } from "../../linq/ngnOrders";
import { reconcileOfframpOrder } from "../../linq/offrampOrders";
import { getOnrampStatus } from "../../linq/onramp";
import { computeSignature, SIGNATURE_HEADER } from "../../linq/webhook";
import { _resetMetrics, registry } from "../../metrics";

const mockOnramp = getOnrampStatus as jest.Mock;
const mockBill = getBillStatus as jest.Mock;
const mockOfframp = getOfframpStatus as jest.Mock;

const SECRET = "whsec_test_order_safety_448";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const NOW = new Date("2026-11-26T12:00:00.000Z");
const OLD = new Date("2026-11-26T10:00:00.000Z");

function seedOfframp(over: Row = {}): Row {
  const row: Row = {
    id: tables.offrampOrder.length + 1,
    network: "mainnet",
    orderId: `offramp-ord-${tables.offrampOrder.length + 1}`,
    publicId: `pub-offramp-${tables.offrampOrder.length + 1}`,
    idempotencyKey: `idem-offramp-${tables.offrampOrder.length + 1}`,
    walletAddress: WALLET,
    chain: "stellar",
    coin: "usdc",
    depositAddress: WALLET,
    amountStableCoin: "50",
    amountNGN: "75000",
    rate: "1500",
    status: "initiated",
    settledStableCoin: null,
    settledNGN: null,
    depositTxHash: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    needsHuman: false,
    createdAt: OLD,
    updatedAt: OLD,
    ...over,
  };
  tables.offrampOrder.push(row);
  return row;
}

function seedNgn(over: Row = {}): Row {
  const row: Row = {
    id: tables.ngnOrder.length + 1,
    network: "mainnet",
    kind: "bill",
    orderId: `ngn-ord-${tables.ngnOrder.length + 1}`,
    customerRef: "ref_test_448",
    walletAddress: WALLET,
    coin: "usdc",
    amountStableCoin: "10",
    amountNGN: "15000",
    rate: "1500",
    billCategory: "airtime",
    provider: "TestTelco",
    status: "initiated",
    settledStableCoin: null,
    settledNGN: null,
    txHash: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    needsHuman: false,
    createdAt: OLD,
    updatedAt: OLD,
    ...over,
  };
  tables.ngnOrder.push(row);
  return row;
}

async function terminalCount(rail: "offramp" | "onramp" | "bills", status?: string): Promise<number> {
  const text = await registry.metrics();
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("orders_terminal_total{")) continue;
    if (!line.includes(`rail="${rail}"`)) continue;
    if (status && !line.includes(`status="${status}"`)) continue;
    const val = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(val)) total += val;
  }
  return total;
}

function makeApp(): express.Express {
  const app = express();
  app.use("/webhooks/linq", createLinqWebhookRouter());
  app.use(express.json());
  return app;
}

function deliver(app: express.Express, event: Record<string, unknown>) {
  const raw = JSON.stringify(event);
  return request(app)
    .post("/webhooks/linq")
    .set("Content-Type", "application/json")
    .set(SIGNATURE_HEADER, computeSignature(raw, SECRET))
    .send(raw);
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  tables.offrampOrder.length = 0;
  tables.ngnOrder.length = 0;
  _resetMetrics();
  process.env.LINQ_WEBHOOK_SECRET = SECRET;
  process.env.STELLAR_NETWORK = "mainnet";
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reconcileOfframpOrder — terminal order safety", () => {
  it("ignores late processing after completed without changing row or settled amounts, logs once, returns true", async () => {
    const row = seedOfframp({ orderId: "offramp-comp-then-proc" });

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 50,
        amountNGN: 75000,
        txHash: "a".repeat(64),
      }),
    ).toBe(true);

    expect(prisma.offrampOrder.update).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();

    // Late redelivery of order.processing carrying stale amounts must be ignored.
    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
        amountStableCoin: 0,
        amountNGN: 0,
        txHash: "b".repeat(64),
      }),
    ).toBe(true);

    expect(prisma.offrampOrder.update).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      status: "completed",
      settledStableCoin: "50",
      settledNGN: "75000",
      depositTxHash: "a".repeat(64),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(row.orderId);
    expect(warnSpy.mock.calls[0][0]).toContain("processing");
    expect(warnSpy.mock.calls[0][0]).toContain("completed");

    // Re-sighting completed afterwards must NOT double-count orders_terminal_total.
    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 50,
        amountNGN: 75000,
      }),
    ).toBe(true);

    expect(await terminalCount("offramp", "completed")).toBe(1);
    expect(await terminalCount("offramp")).toBe(1);
  });

  it("ignores late processing after failed and keeps terminal counter at 1", async () => {
    const row = seedOfframp({ orderId: "offramp-fail-then-proc" });

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.failed",
      status: "failed",
      amountStableCoin: 50,
      amountNGN: 75000,
    });
    expect(prisma.offrampOrder.update).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
        amountStableCoin: 1,
        amountNGN: 1500,
      }),
    ).toBe(true);

    expect(prisma.offrampOrder.update).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("failed");
    expect(row.settledStableCoin).toBe("50");
    expect(row.settledNGN).toBe("75000");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(row.orderId);
    expect(warnSpy.mock.calls[0][0]).toContain("processing");
    expect(warnSpy.mock.calls[0][0]).toContain("failed");

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.failed",
      status: "failed",
    });

    expect(await terminalCount("offramp", "failed")).toBe(1);
    expect(await terminalCount("offramp")).toBe(1);
  });

  it("counts the same ending delivered three times exactly once", async () => {
    const row = seedOfframp({ orderId: "offramp-triple" });

    for (let i = 0; i < 3; i++) {
      expect(
        await reconcileOfframpOrder({
          orderId: row.orderId,
          network: "mainnet",
          event: "order.completed",
          status: "completed",
          amountStableCoin: 50,
          amountNGN: 75000,
        }),
      ).toBe(true);
    }

    expect(row.status).toBe("completed");
    expect(await terminalCount("offramp", "completed")).toBe(1);
    expect(await terminalCount("offramp")).toBe(1);
  });

  it("still advances normally from processing to completed and counts once", async () => {
    const row = seedOfframp({ orderId: "offramp-normal" });

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
      }),
    ).toBe(true);
    expect(row.status).toBe("processing");
    expect(await terminalCount("offramp")).toBe(0);

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 50,
        amountNGN: 75000,
      }),
    ).toBe(true);
    expect(row).toMatchObject({
      status: "completed",
      settledStableCoin: "50",
      settledNGN: "75000",
    });
    expect(await terminalCount("offramp", "completed")).toBe(1);
    expect(await terminalCount("offramp")).toBe(1);
  });

  it("allows a distinct terminal status (completed -> refunded) while counting terminal transition once", async () => {
    const row = seedOfframp({ orderId: "offramp-refunded" });

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 50,
      amountNGN: 75000,
    });
    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.refunded",
      status: "refunded",
    });

    expect(row.status).toBe("refunded");
    expect(await terminalCount("offramp")).toBe(1);
    expect(await terminalCount("offramp", "completed")).toBe(1);
  });

  it("lets completed -> refund_pending through the guard, records a money failure, and keeps the row visible to the sweep", async () => {
    const row = seedOfframp({ orderId: "offramp-comp-then-refund-pending" });

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 50,
      amountNGN: 75000,
      txHash: "e".repeat(64),
    });
    warnSpy.mockClear();
    (prisma.moneyFailure.upsert as jest.Mock).mockClear();

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.refund_pending",
        status: "refund_pending",
      }),
    ).toBe(true);

    expect(row).toMatchObject({
      status: "refund_pending",
      settledStableCoin: "50",
      settledNGN: "75000",
      depositTxHash: "e".repeat(64),
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          network_kind_orderId: {
            network: "mainnet",
            kind: "payout_rejected",
            orderId: row.orderId,
          },
        },
        create: expect.objectContaining({
          rail: "offramp",
          kind: "payout_rejected",
          providerCode: "refund_pending",
        }),
      }),
    );
    expect(await terminalCount("offramp", "completed")).toBe(1);
    expect(await terminalCount("offramp")).toBe(1);

    // Because status moved to refund_pending, the periodic sweep now picks it up
    // and can drive it to the final refunded status even if the webhook is lost.
    mockOfframp.mockResolvedValueOnce({
      status: "refunded",
      amountStableCoin: 50,
      amountNGN: 75000,
    });
    const sweep = await runOrderReconciliationJob({ now: NOW, ageMs: 1000 });
    expect(sweep.checked).toBe(1);
    expect(sweep.resolved).toBe(1);
    expect(row.status).toBe("refunded");
  });

  it("lets completed -> rejected through the guard and records a money failure", async () => {
    const row = seedOfframp({ orderId: "offramp-comp-then-rejected" });

    await reconcileOfframpOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 50,
      amountNGN: 75000,
    });
    warnSpy.mockClear();
    (prisma.moneyFailure.upsert as jest.Mock).mockClear();

    expect(
      await reconcileOfframpOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.rejected",
        status: "rejected",
      }),
    ).toBe(true);

    expect(row.status).toBe("rejected");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          rail: "offramp",
          kind: "payout_rejected",
          providerCode: "rejected",
        }),
      }),
    );
  });
});

describe("reconcileNgnOrder — terminal order safety", () => {
  it("ignores late processing after completed without changing row or settled amounts, logs once, returns true", async () => {
    const row = seedNgn({ kind: "bill", orderId: "bill-comp-then-proc" });

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 10,
        amountNGN: 15000,
        txHash: "c".repeat(64),
      }),
    ).toBe(true);

    expect(prisma.ngnOrder.update).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
        amountStableCoin: 1,
        amountNGN: 1500,
        txHash: "d".repeat(64),
      }),
    ).toBe(true);

    expect(prisma.ngnOrder.update).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      status: "completed",
      settledStableCoin: "10",
      settledNGN: "15000",
      txHash: "c".repeat(64),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(row.orderId);
    expect(warnSpy.mock.calls[0][0]).toContain("processing");
    expect(warnSpy.mock.calls[0][0]).toContain("completed");

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
    });
    expect(await terminalCount("bills", "completed")).toBe(1);
    expect(await terminalCount("bills")).toBe(1);
  });

  it("ignores late processing after failed for an onramp order and counts once", async () => {
    const row = seedNgn({ kind: "onramp", orderId: "onramp-fail-then-proc" });

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.failed",
      status: "failed",
      amountStableCoin: 10,
      amountNGN: 15000,
    });
    expect(prisma.ngnOrder.update).toHaveBeenCalledTimes(1);
    warnSpy.mockClear();

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
        amountStableCoin: 0,
        amountNGN: 0,
      }),
    ).toBe(true);

    expect(prisma.ngnOrder.update).toHaveBeenCalledTimes(1);
    expect(row.status).toBe("failed");
    expect(row.settledStableCoin).toBe("10");
    expect(row.settledNGN).toBe("15000");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(row.orderId);
    expect(warnSpy.mock.calls[0][0]).toContain("processing");
    expect(warnSpy.mock.calls[0][0]).toContain("failed");

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.failed",
      status: "failed",
    });
    expect(await terminalCount("onramp", "failed")).toBe(1);
    expect(await terminalCount("onramp")).toBe(1);
  });

  it("counts the same ending delivered three times exactly once", async () => {
    const row = seedNgn({ kind: "onramp", orderId: "onramp-triple" });

    for (let i = 0; i < 3; i++) {
      expect(
        await reconcileNgnOrder({
          orderId: row.orderId,
          network: "mainnet",
          event: "order.completed",
          status: "completed",
          amountStableCoin: 10,
          amountNGN: 15000,
        }),
      ).toBe(true);
    }

    expect(row.status).toBe("completed");
    expect(await terminalCount("onramp", "completed")).toBe(1);
    expect(await terminalCount("onramp")).toBe(1);
  });

  it("still advances normally from processing to completed and counts once", async () => {
    const row = seedNgn({ kind: "bill", orderId: "bill-normal" });

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.processing",
        status: "processing",
      }),
    ).toBe(true);
    expect(row.status).toBe("processing");
    expect(await terminalCount("bills")).toBe(0);

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 10,
        amountNGN: 15000,
      }),
    ).toBe(true);
    expect(row).toMatchObject({
      status: "completed",
      settledStableCoin: "10",
      settledNGN: "15000",
    });
    expect(await terminalCount("bills", "completed")).toBe(1);
    expect(await terminalCount("bills")).toBe(1);
  });

  it("allows completed -> refunded while counting terminal transition once", async () => {
    const row = seedNgn({ kind: "bill", orderId: "bill-refunded" });

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 10,
      amountNGN: 15000,
    });
    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.refunded",
      status: "refunded",
    });

    expect(row.status).toBe("refunded");
    expect(await terminalCount("bills")).toBe(1);
    expect(await terminalCount("bills", "completed")).toBe(1);
  });

  it("lets completed -> refund_pending through the guard, records a money failure, and keeps the row visible to the sweep", async () => {
    const row = seedNgn({ kind: "bill", orderId: "bill-comp-then-refund-pending" });

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 10,
      amountNGN: 15000,
      txHash: "f".repeat(64),
    });
    warnSpy.mockClear();
    (prisma.moneyFailure.upsert as jest.Mock).mockClear();

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.refund_pending",
        status: "refund_pending",
      }),
    ).toBe(true);

    expect(row).toMatchObject({
      status: "refund_pending",
      settledStableCoin: "10",
      settledNGN: "15000",
      txHash: "f".repeat(64),
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          network_kind_orderId: {
            network: "mainnet",
            kind: "order_failed",
            orderId: row.orderId,
          },
        },
        create: expect.objectContaining({
          rail: "bill",
          kind: "order_failed",
          providerCode: "refund_pending",
        }),
      }),
    );
    expect(await terminalCount("bills", "completed")).toBe(1);
    expect(await terminalCount("bills")).toBe(1);

    mockBill.mockResolvedValueOnce({
      status: "refunded",
      amountStableCoin: 10,
      amountNgn: 15000,
    });
    const sweep = await runOrderReconciliationJob({ now: NOW, ageMs: 1000 });
    expect(sweep.checked).toBe(1);
    expect(sweep.resolved).toBe(1);
    expect(row.status).toBe("refunded");
  });

  it("lets completed -> rejected through the guard and records a money failure", async () => {
    const row = seedNgn({ kind: "onramp", orderId: "onramp-comp-then-rejected" });

    await reconcileNgnOrder({
      orderId: row.orderId,
      network: "mainnet",
      event: "order.completed",
      status: "completed",
      amountStableCoin: 10,
      amountNGN: 15000,
    });
    warnSpy.mockClear();
    (prisma.moneyFailure.upsert as jest.Mock).mockClear();

    expect(
      await reconcileNgnOrder({
        orderId: row.orderId,
        network: "mainnet",
        event: "order.rejected",
        status: "rejected",
      }),
    ).toBe(true);

    expect(row.status).toBe("rejected");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.moneyFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          rail: "onramp",
          kind: "order_failed",
          providerCode: "rejected",
        }),
      }),
    );
  });
});

describe("webhook route and periodic sweep enforce the same rule", () => {
  it("webhook route ignores late processing on both rails without falling through to unknown order", async () => {
    const offramp = seedOfframp({ orderId: "wh-offramp-1" });
    const bill = seedNgn({ kind: "bill", orderId: "wh-bill-1" });
    const app = makeApp();

    for (const orderId of [offramp.orderId, bill.orderId]) {
      expect(
        (
          await deliver(app, {
            event: "order.completed",
            orderId,
            network: "mainnet",
            status: "completed",
            amountStableCoin: 10,
            amountNGN: 15000,
          })
        ).status,
      ).toBe(200);
      await flushAsync();

      expect(
        (
          await deliver(app, {
            event: "order.processing",
            orderId,
            network: "mainnet",
            status: "processing",
            amountStableCoin: 1,
            amountNGN: 1500,
          })
        ).status,
      ).toBe(200);
      await flushAsync();

      expect(
        (
          await deliver(app, {
            event: "order.completed",
            orderId,
            network: "mainnet",
            status: "completed",
            amountStableCoin: 10,
            amountNGN: 15000,
          })
        ).status,
      ).toBe(200);
      await flushAsync();
    }

    expect(offramp).toMatchObject({
      status: "completed",
      settledStableCoin: "10",
      settledNGN: "15000",
    });
    expect(bill).toMatchObject({
      status: "completed",
      settledStableCoin: "10",
      settledNGN: "15000",
    });
    expect(await terminalCount("offramp")).toBe(1);
    expect(await terminalCount("bills")).toBe(1);
    // Returning true on ignored offramp events prevented fallthrough to unknown-order warning.
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain("unknown order");
    }
  });

  it("periodic sweep cannot regress a finished offramp or NGN row when a webhook finishes it mid-poll", async () => {
    const offramp = seedOfframp({ orderId: "sweep-race-offramp", status: "processing" });
    const bill = seedNgn({ kind: "bill", orderId: "sweep-race-bill", status: "processing" });

    // Simulate a webhook completing each order while the sweep's provider poll
    // is in flight and returns a stale "processing" status.
    mockOfframp.mockImplementationOnce(async () => {
      await reconcileOfframpOrder({
        orderId: offramp.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 50,
        amountNGN: 75000,
      });
      return { status: "processing", amountStableCoin: 0, amountNGN: 0 };
    });

    mockBill.mockImplementationOnce(async () => {
      await reconcileNgnOrder({
        orderId: bill.orderId,
        network: "mainnet",
        event: "order.completed",
        status: "completed",
        amountStableCoin: 10,
        amountNGN: 15000,
      });
      return { status: "processing", amountStableCoin: 0, amountNgn: 0 };
    });

    await runOrderReconciliationJob({ now: NOW, ageMs: 1000 });

    expect(offramp).toMatchObject({
      status: "completed",
      settledStableCoin: "50",
      settledNGN: "75000",
    });
    expect(bill).toMatchObject({
      status: "completed",
      settledStableCoin: "10",
      settledNGN: "15000",
    });
    expect(await terminalCount("offramp")).toBe(1);
    expect(await terminalCount("bills")).toBe(1);
    expect(mockOnramp).not.toHaveBeenCalled();
  });
});
