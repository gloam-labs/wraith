/**
 * Tests for `parseHostFnEvent`, `toJsonSafe`, and `upsertHostFnLogs` in
 * `src/indexer/host-fn-log.ts` (#442).
 *
 * Every contract ID, hash, and byte payload below is synthetically generated
 * inside the test — no real addresses or hashes.
 */
jest.mock("../db", () => ({
  prisma: {
    hostFnLog: {
      createMany: jest.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
    },
  },
}));

import * as StellarSdk from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { parseHostFnEvent, toJsonSafe, upsertHostFnLogs } from "../indexer/host-fn-log";
import type { RawEvent } from "../rpc";

const { xdr, nativeToScVal, StrKey } = StellarSdk;

const TEST_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));
const TEST_TX_HASH = Buffer.alloc(32, 0x11).toString("hex");

function makeEvent(topic: StellarSdk.xdr.ScVal[], value: StellarSdk.xdr.ScVal, id = "0000000100-0000000001"): RawEvent {
  return {
    id,
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2026-11-26T00:00:00.000Z",
    contractId: TEST_CONTRACT,
    txHash: TEST_TX_HASH,
    topic,
    value,
  };
}

const mockCreateMany = prisma.hostFnLog.createMany as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STELLAR_NETWORK = "testnet";
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("parseHostFnEvent (#442)", () => {
  it("decodes a symbol topic and a bare i128 value", () => {
    const amount = 123_456_789_012_345_678_901n;
    const raw = makeEvent(
      [nativeToScVal("mint", { type: "symbol" })],
      nativeToScVal(amount, { type: "i128" }),
    );

    const record = parseHostFnEvent(raw);

    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      contractId: TEST_CONTRACT,
      functionName: "mint",
      args: [],
      result: amount.toString(),
      gasUsed: null,
      ledger: 100,
      txHash: TEST_TX_HASH,
      eventId: raw.id,
    });
    expect(record!.ledgerClosedAt).toEqual(new Date("2026-11-26T00:00:00.000Z"));
  });

  // Fails on main: Buffer fell into Object.entries and became { "0": ..., "31": ... }.
  it("stores a 32-byte topic and 32-byte value as single 64-character lowercase hex strings", () => {
    const topicBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (0xa0 + i) & 0xff));
    const valueBytes = Buffer.alloc(32, 0xde);
    const raw = makeEvent(
      [nativeToScVal("commit", { type: "symbol" }), xdr.ScVal.scvBytes(topicBytes)],
      xdr.ScVal.scvBytes(valueBytes),
    );

    const record = parseHostFnEvent(raw);

    expect(record).not.toBeNull();
    expect(record!.functionName).toBe("commit");
    expect(record!.args).toEqual([topicBytes.toString("hex")]);
    expect(typeof (record!.args as string[])[0]).toBe("string");
    expect((record!.args as string[])[0]).toHaveLength(64);

    expect(record!.result).toBe(valueBytes.toString("hex"));
    expect(typeof record!.result).toBe("string");
    expect(record!.result as string).toHaveLength(64);
  });

  it("converts Uint8Array slices (including non-zero byteOffset) and bytes nested in lists and maps", () => {
    const parent = new Uint8Array([0x00, 0x01, 0xde, 0xad, 0xbe, 0xef, 0xff]);
    const slice = parent.subarray(2, 6);
    expect(toJsonSafe(slice)).toBe("deadbeef");

    const salt = Buffer.alloc(32, 0x42);
    const itemBytes = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
    const mapScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: nativeToScVal("items", { type: "symbol" }),
        val: xdr.ScVal.scvVec([
          nativeToScVal(9_007_199_254_740_993n, { type: "u64" }),
          xdr.ScVal.scvBytes(itemBytes),
        ]),
      }),
      new xdr.ScMapEntry({
        key: nativeToScVal("salt", { type: "symbol" }),
        val: xdr.ScVal.scvBytes(salt),
      }),
    ]);

    const raw = makeEvent([nativeToScVal("register", { type: "symbol" })], mapScVal);
    const record = parseHostFnEvent(raw);

    expect(record).not.toBeNull();
    expect(record!.result).toEqual({
      items: ["9007199254740993", "cafebabe"],
      salt: salt.toString("hex"),
    });
    expect(() => JSON.stringify(record!.result)).not.toThrow();
  });

  it("decodes a void value as null (which upsertHostFnLogs writes as Prisma.JsonNull)", async () => {
    const raw = makeEvent([nativeToScVal("ping", { type: "symbol" })], xdr.ScVal.scvVoid());

    const record = parseHostFnEvent(raw);
    expect(record).not.toBeNull();
    expect(record!.result).toBeNull();

    await upsertHostFnLogs([record!], "mainnet");
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateMany.mock.calls[0][0].data[0].result).toBe(Prisma.JsonNull);
  });

  it("returns null for an event with no topics or a non-symbol first topic", () => {
    const emptyTopics = makeEvent([], xdr.ScVal.scvVoid());
    expect(parseHostFnEvent(emptyTopics)).toBeNull();

    const u32FirstTopic = makeEvent([nativeToScVal(42, { type: "u32" })], xdr.ScVal.scvVoid());
    expect(parseHostFnEvent(u32FirstTopic)).toBeNull();

    const bytesFirstTopic = makeEvent(
      [xdr.ScVal.scvBytes(Buffer.from([1, 2, 3, 4]))],
      xdr.ScVal.scvVoid(),
    );
    expect(parseHostFnEvent(bytesFirstTopic)).toBeNull();

    const stringFirstTopic = makeEvent(
      [xdr.ScVal.scvString("not_a_symbol")],
      xdr.ScVal.scvVoid(),
    );
    expect(parseHostFnEvent(stringFirstTopic)).toBeNull();
  });

  it("falls back to { xdr: base64 } when scValToNative throws or returns an unhandled XDR struct", () => {
    const rawXdrBase64 = nativeToScVal(7, { type: "u32" }).toXDR("base64");
    const unreadable = {
      switch: () => {
        throw new Error("unknown ScValType member for value 99");
      },
      toXDR: () => rawXdrBase64,
    } as unknown as StellarSdk.xdr.ScVal;
    const raw = makeEvent([nativeToScVal("custom", { type: "symbol" })], unreadable);

    const record = parseHostFnEvent(raw);
    expect(record).not.toBeNull();
    expect(record!.result).toEqual({ xdr: rawXdrBase64 });

    // scvLedgerKeyNonce falls through scValToNative's default branch returning an XDR ScNonceKey object;
    // toJsonSafe must encode it via toXDR("base64") rather than leaking internal _attributes keys.
    const nonceScVal = xdr.ScVal.scvLedgerKeyNonce(
      new xdr.ScNonceKey({ nonce: xdr.Int64.fromString("42") }),
    );
    const nonceRecord = parseHostFnEvent(
      makeEvent([nativeToScVal("nonce", { type: "symbol" })], nonceScVal),
    );
    expect(nonceRecord).not.toBeNull();
    expect(nonceRecord!.result).toEqual({
      xdr: nonceScVal.nonceKey().toXDR("base64"),
    });
  });
});

describe("upsertHostFnLogs (#442)", () => {
  it("makes no database query when given an empty record list", async () => {
    const inserted = await upsertHostFnLogs([], "mainnet");
    expect(inserted).toBe(0);
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("stamps the resolved network on every persisted row", async () => {
    const recA = parseHostFnEvent(
      makeEvent([nativeToScVal("swap", { type: "symbol" })], nativeToScVal(10n, { type: "u64" }), "e-1"),
    )!;
    const recB = parseHostFnEvent(
      makeEvent([nativeToScVal("ping", { type: "symbol" })], xdr.ScVal.scvVoid(), "e-2"),
    )!;

    const inserted = await upsertHostFnLogs([recA, recB], "mainnet");

    expect(inserted).toBe(2);
    expect(mockCreateMany).toHaveBeenCalledTimes(1);
    const arg = mockCreateMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data).toHaveLength(2);
    expect(arg.data.map((r: any) => r.network)).toEqual(["mainnet", "mainnet"]);
    expect(arg.data[0].result).toBe("10");
    expect(arg.data[1].result).toBe(Prisma.JsonNull);
  });
});
