/**
 * Account-summary totals against a real Postgres (#450).
 *
 * The unit tests pin the shape of the SQL; only a database can prove that the
 * multi-row UPSERT adds to an existing row instead of replacing it, that a
 * total past the 64-bit range survives the ::NUMERIC arithmetic, and that a
 * statement which names the same pair once is accepted by Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma, upsertAccountSummaries } from "../../src/db";
import type { TransferRecord } from "../../src/db";

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 21));

/** A valid ed25519 public key that belongs to nobody, unique per `n`. */
function address(n: number): string {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(n, 0);
  return StrKey.encodeEd25519PublicKey(seed);
}

const ALICE = address(45001);
const BOB = address(45002);
const HUGE = address(45003);
const REPEAT = address(45004);
const BULK = Array.from({ length: 1000 }, (_, i) => address(46000 + i));
const ALL = [ALICE, BOB, HUGE, REPEAT, ...BULK];

function transfer(
  from: string | null,
  to: string | null,
  amount: string,
  at: Date,
  seq: number
): TransferRecord {
  return {
    contractId: CONTRACT,
    eventType: "transfer",
    fromAddress: from,
    toAddress: to,
    amount,
    ledger: 9000 + seq,
    ledgerClosedAt: at,
    txHash: `summary-tx-${seq}`,
    eventId: `summary-evt-${seq}`,
  };
}

async function summaryOf(addr: string) {
  const row = await prisma.accountSummary.findUnique({
    where: { network_address_contractId: { network: "testnet", address: addr, contractId: CONTRACT } },
  });
  expect(row).not.toBeNull();
  return row!;
}

beforeAll(async () => {
  await prisma.accountSummary.deleteMany({ where: { address: { in: ALL } } });
});

afterAll(async () => {
  await prisma.accountSummary.deleteMany({ where: { address: { in: ALL } } });
  await prisma.$disconnect();
});

describe("upsertAccountSummaries against Postgres (#450)", () => {
  it("inserts a new address, then adds to it instead of replacing the totals", async () => {
    await upsertAccountSummaries(
      [transfer(ALICE, null, "500", new Date("2026-02-01T00:00:00Z"), 1)],
      "testnet"
    );
    let row = await summaryOf(ALICE);
    expect(row.totalSent).toBe("500");
    expect(row.totalReceived).toBe("0");
    expect(row.net).toBe("-500");
    expect(row.txCount).toBe(1);
    expect(row.lastActivityAt.toISOString()).toBe("2026-02-01T00:00:00.000Z");

    // A second batch: ALICE sends again and receives, BOB is new in this batch.
    await upsertAccountSummaries(
      [
        transfer(ALICE, null, "250", new Date("2026-02-02T00:00:00Z"), 2),
        transfer(BOB, ALICE, "100", new Date("2026-02-03T00:00:00Z"), 3),
      ],
      "testnet"
    );

    row = await summaryOf(ALICE);
    expect(row.totalSent).toBe("750");
    expect(row.totalReceived).toBe("100");
    expect(row.net).toBe("-650");
    expect(row.txCount).toBe(3);
    expect(row.lastActivityAt.toISOString()).toBe("2026-02-03T00:00:00.000Z");

    const bob = await summaryOf(BOB);
    expect(bob.totalSent).toBe("100");
    expect(bob.totalReceived).toBe("0");
    expect(bob.net).toBe("-100");
    expect(bob.txCount).toBe(1);
  });

  it("keeps a total larger than a 64-bit integer exact", async () => {
    // 1.2345…e29 — far outside the range a bigint column could hold.
    const huge = "123456789012345678901234567890";

    await upsertAccountSummaries(
      [
        transfer(HUGE, null, huge, new Date("2026-02-04T00:00:00Z"), 4),
        transfer(HUGE, null, huge, new Date("2026-02-05T00:00:00Z"), 5),
      ],
      "testnet"
    );
    await upsertAccountSummaries(
      [transfer(HUGE, null, huge, new Date("2026-02-06T00:00:00Z"), 6)],
      "testnet"
    );

    const row = await summaryOf(HUGE);
    expect(row.totalSent).toBe("370370367037037036703703703670");
    expect(row.totalReceived).toBe("0");
    expect(row.net).toBe("-370370367037037036703703703670");
    expect(row.txCount).toBe(3);
  });

  it("writes 1,000 distinct addresses, one row each", async () => {
    const records = BULK.map((addr, i) =>
      transfer(addr, null, String(i + 1), new Date("2026-02-07T00:00:00Z"), 100 + i)
    );

    await upsertAccountSummaries(records, "testnet");

    const rows = await prisma.accountSummary.findMany({
      where: { network: "testnet", contractId: CONTRACT, address: { in: BULK } },
    });
    expect(rows).toHaveLength(1000);
    const first = rows.find((r) => r.address === BULK[0])!;
    expect(first.totalSent).toBe("1");
    const last = rows.find((r) => r.address === BULK[999])!;
    expect(last.totalSent).toBe("1000");
  });

  it("accepts a batch that touches one address many times", async () => {
    // Postgres rejects this statement outright — "ON CONFLICT DO UPDATE command
    // cannot affect row a second time" — unless the in-memory grouping folded
    // the repeats into one row first.
    const at = new Date("2026-02-08T00:00:00Z");
    const records = Array.from({ length: 50 }, (_, i) =>
      transfer(REPEAT, null, "2", at, 200 + i)
    );

    await upsertAccountSummaries(records, "testnet");

    const row = await summaryOf(REPEAT);
    expect(row.totalSent).toBe("100");
    expect(row.txCount).toBe(50);
  });
});
