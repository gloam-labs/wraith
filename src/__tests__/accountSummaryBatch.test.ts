/**
 * Batch-write behaviour of upsertAccountSummaries (#450).
 *
 * The totals used to be written with one awaited UPSERT per address, so a busy
 * batch made thousands of sequential round trips and a crash halfway left some
 * addresses with the batch added and others without. These tests pin the shape
 * of the replacement: a fixed number of multi-row statements, each pair present
 * once, and every chunk inside one transaction.
 *
 * db.ts resolves its client from `globalThis.prisma` before constructing one,
 * so recording the calls keeps this a unit test with no database — the same
 * technique network.test.ts uses for the network predicates.
 */

type AnyRecord = Record<string, any>;

type RecordedStatement = { strings: string[]; values: unknown[] };

function recorder() {
  const statements: RecordedStatement[] = [];
  const transactions: unknown[][] = [];

  const normalize = (query: unknown): RecordedStatement => {
    const sql = query as AnyRecord;
    return { strings: Array.from(sql.strings as string[]), values: sql.values as unknown[] };
  };

  const executeRaw = (query: unknown) => {
    statements.push(normalize(query));
    return Promise.resolve(1);
  };

  const stub: AnyRecord = {
    $executeRaw: executeRaw,
    $transaction: (opsOrFn: unknown) => {
      if (Array.isArray(opsOrFn)) {
        transactions.push(opsOrFn);
        return Promise.all(opsOrFn);
      }
      return (opsOrFn as (tx: AnyRecord) => unknown)(stub);
    },
  };

  return { stub, statements, transactions, executeRaw, normalize };
}

const { stub, statements, transactions, executeRaw, normalize } = recorder();
(globalThis as AnyRecord).prisma = stub;

// Imported after the stub is installed — db.ts binds its client at module load.
import { ACCOUNT_SUMMARY_CHUNK_SIZE, upsertAccountSummaries } from "../db";
import type { TransferRecord } from "../db";
import { StrKey } from "@stellar/stellar-sdk";

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

/** A valid ed25519 public key that belongs to nobody, unique per `n`. */
function address(n: number): string {
  const seed = Buffer.alloc(32);
  seed.writeUInt32BE(n, 0);
  return StrKey.encodeEd25519PublicKey(seed);
}

function transfer(from: string, amount: string, at = new Date("2026-01-01T00:00:00Z")): TransferRecord {
  const id = from.slice(-8);
  return {
    contractId: CONTRACT,
    eventType: "transfer",
    fromAddress: from,
    toAddress: null,
    amount,
    ledger: 1,
    ledgerClosedAt: at,
    txHash: `tx-${id}`,
    eventId: `evt-${id}`,
  };
}

/** Bound values of one statement, flattened in order through nested Prisma.Sql joins. */
function valuesOf(statement: RecordedStatement): unknown[] {
  const out: unknown[] = [];
  const walk = (value: unknown) => {
    if (value && typeof value === "object" && Array.isArray((value as AnyRecord).values)) {
      ((value as AnyRecord).values as unknown[]).forEach(walk);
    } else {
      out.push(value);
    }
  };
  statement.values.forEach(walk);
  return out;
}

/**
 * One `VALUES` tuple binds eight parameters:
 * network, address, contractId, totalSent, totalReceived, net, txCount, lastActivityAt.
 */
const PARAMS_PER_ROW = 8;

function rowsOf(statement: RecordedStatement): Array<{ address: string; contractId: string }> {
  const values = valuesOf(statement);
  const rows: Array<{ address: string; contractId: string }> = [];
  for (let i = 0; i + PARAMS_PER_ROW <= values.length; i += PARAMS_PER_ROW) {
    rows.push({ address: String(values[i + 1]), contractId: String(values[i + 2]) });
  }
  return rows;
}

beforeEach(() => {
  statements.length = 0;
  transactions.length = 0;
  stub.$executeRaw = executeRaw;
});

describe("upsertAccountSummaries writes a batch without one statement per address (#450)", () => {
  it("writes 1,000 addresses in a single statement", async () => {
    const records = Array.from({ length: 1000 }, (_, i) => transfer(address(i), "1"));

    await upsertAccountSummaries(records, "testnet");

    expect(statements).toHaveLength(1);
    expect(rowsOf(statements[0])).toHaveLength(1000);
  });

  it("splits a very large batch into a small fixed number of chunks", async () => {
    const records = Array.from({ length: 5000 }, (_, i) => transfer(address(i), "1"));

    await upsertAccountSummaries(records, "testnet");

    expect(statements).toHaveLength(Math.ceil(5000 / ACCOUNT_SUMMARY_CHUNK_SIZE));
    expect(statements.length).toBeLessThan(10);
    for (const statement of statements) {
      expect(rowsOf(statement).length).toBeLessThanOrEqual(ACCOUNT_SUMMARY_CHUNK_SIZE);
    }
  });

  it("lists each (network, address, contractId) once per statement", async () => {
    // Every record touches the same address, so the in-memory grouping — not
    // the record count — decides how many rows the statement may contain:
    // Postgres rejects an ON CONFLICT DO UPDATE that touches a row twice.
    const records = Array.from({ length: 25 }, () => transfer(address(1), "1"));

    await upsertAccountSummaries(records, "testnet");

    expect(rowsOf(statements[0])).toEqual([{ address: address(1), contractId: CONTRACT }]);
  });

  it("passes a total larger than a 64-bit integer through unchanged", async () => {
    // ~1e30, eleven orders of magnitude past 2^63-1. It travels as a bound
    // string and the SQL adds it with ::NUMERIC, never as a JS number.
    const huge = "1000000000000000000000000000000";

    await upsertAccountSummaries([transfer(address(1), huge)], "testnet");

    expect(valuesOf(statements[0])).toContain(huge);
    const sql = statements[0].strings.join("?");
    expect(sql).toContain('EXCLUDED."totalSent"::NUMERIC');
    expect(sql).toContain('EXCLUDED."totalReceived"::NUMERIC');
    expect(sql).toContain("::TEXT");
  });

  it("runs every chunk in one transaction", async () => {
    const records = Array.from({ length: 2500 }, (_, i) => transfer(address(i), "1"));

    await upsertAccountSummaries(records, "testnet");

    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toHaveLength(statements.length);
  });

  it("propagates a failing chunk instead of applying the rest of the batch", async () => {
    stub.$executeRaw = (query: unknown) => {
      statements.push(normalize(query));
      return statements.length === 2
        ? Promise.reject(new Error("chunk failed"))
        : Promise.resolve(1);
    };
    const records = Array.from({ length: 2500 }, (_, i) => transfer(address(i), "1"));

    await expect(upsertAccountSummaries(records, "testnet")).rejects.toThrow("chunk failed");
    expect(transactions).toHaveLength(1);
  });
});
