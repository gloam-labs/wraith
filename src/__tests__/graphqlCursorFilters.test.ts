import request from "supertest";
import { createApp } from "../api";
import { encodeCursor } from "../lib/odata";

jest.mock("../db", () => ({
  getAccountSummary: jest.fn().mockResolvedValue([]),
  getLastIndexedLedger: jest.fn().mockResolvedValue(1),
  getNftMetadata: jest.fn(),
  getNftOwner: jest.fn(),
  prisma: { $queryRaw: jest.fn() },
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  queryNftTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  toDisplayAmount: jest.requireActual("../db").toDisplayAmount,
}));

jest.mock("../rpc", () => ({ getLatestLedger: jest.fn().mockResolvedValue(1) }));

jest.mock("../indexer", () => ({
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
}));

import { queryAllTransfers, querySummary, queryTransfers } from "../db";

const mockQueryAllTransfers = queryAllTransfers as jest.MockedFunction<typeof queryAllTransfers>;
const mockQueryTransfers = queryTransfers as jest.MockedFunction<typeof queryTransfers>;
const mockQuerySummary = querySummary as jest.MockedFunction<typeof querySummary>;

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const row = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  contractId: "CTOKEN",
  eventType: "transfer",
  fromAddress: null,
  toAddress: ALICE,
  amount: "10000000",
  displayAmount: "1.0000000",
  ledger: 100 + id,
  ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
  txHash: `txhash-${id}`,
  eventId: `ev-${id}`,
  ...overrides,
});

const gql = (query: string, variables?: Record<string, unknown>) =>
  request(createApp())
    .post("/graphql")
    .set("Content-Type", "application/json")
    .send({ query, variables });

describe("GraphQL transfers cursor & filters (#405)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
    mockQueryAllTransfers.mockResolvedValue({
      total: 0,
      transfers: [],
      nextCursor: null,
      hasMore: false,
    } as never);
    mockQueryTransfers.mockResolvedValue({
      total: 0,
      transfers: [],
      nextCursor: null,
      hasMore: false,
    } as never);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("pages by cursor across two pages without repeating rows", async () => {
    mockQueryAllTransfers.mockImplementation(async (params) => {
      if (!params.cursor) {
        return { transfers: [row(3), row(2)], nextCursor: encodeCursor(2), hasMore: true } as never;
      }
      expect(params.cursor).toBe(encodeCursor(2));
      return { transfers: [row(1)], nextCursor: null, hasMore: false } as never;
    });

    const page1 = await gql(
      `{ transfers(address: "${ALICE}", limit: 2) { transfers { id eventId } nextCursor hasMore } }`,
    );
    expect(page1.body.errors).toBeUndefined();
    expect(page1.body.data.transfers.transfers.map((t: { id: number }) => t.id)).toEqual([3, 2]);
    expect(page1.body.data.transfers.hasMore).toBe(true);
    const cursor = page1.body.data.transfers.nextCursor as string;
    expect(cursor).toBe(encodeCursor(2));

    const page2 = await gql(
      `{ transfers(address: "${ALICE}", limit: 2, cursor: "${cursor}") { transfers { id eventId } nextCursor hasMore } }`,
    );
    expect(page2.body.errors).toBeUndefined();
    expect(page2.body.data.transfers.transfers.map((t: { id: number }) => t.id)).toEqual([1]);
    expect(page2.body.data.transfers.hasMore).toBe(false);
    expect(page2.body.data.transfers.nextCursor).toBeNull();
  });

  it.each([
    ["fromLedger", `fromLedger: 100`, { fromLedger: 100 }],
    ["toLedger", `toLedger: 200`, { toLedger: 200 }],
    ["fromDate", `fromDate: "2025-01-01T00:00:00Z"`, { fromDate: new Date("2025-01-01T00:00:00Z") }],
    ["toDate", `toDate: "2025-01-31T23:59:59Z"`, { toDate: new Date("2025-01-31T23:59:59Z") }],
    ["eventTypes", `eventTypes: ["mint", "burn"]`, { eventTypes: ["mint", "burn"] }],
    ["token", `token: "CTOKEN"`, { token: "CTOKEN" }],
    ["cursor", `cursor: "${encodeCursor(5)}"`, { cursor: encodeCursor(5) }],
  ])("passes %s through to the data layer", async (_name, arg, expected) => {
    await gql(`{ transfers(address: "${ALICE}", ${arg}) { hasMore } }`);

    expect(mockQueryAllTransfers).toHaveBeenCalledWith(expect.objectContaining(expected));
  });

  it("passes the filters to queryTransfers for a directional query too", async () => {
    await gql(
      `{ transfers(address: "${ALICE}", direction: INCOMING, fromLedger: 100, eventTypes: ["transfer"]) { hasMore } }`,
    );

    expect(mockQueryTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ fromLedger: 100, eventTypes: ["transfer"] }),
    );
    expect(mockQueryAllTransfers).not.toHaveBeenCalled();
  });

  it("accepts enum-style eventTypes and normalises them to REST's lowercase vocabulary", async () => {
    await gql(`{ transfers(address: "${ALICE}", eventTypes: ["TRANSFER"]) { hasMore } }`);

    expect(mockQueryAllTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ eventTypes: ["transfer"] }),
    );
  });

  it("errors on a malformed cursor instead of silently returning the first page", async () => {
    const res = await gql(
      `{ transfers(address: "${ALICE}", cursor: "not-a-cursor") { hasMore } }`,
    );

    expect(res.body.errors?.[0]?.message).toContain("Invalid cursor");
    expect(mockQueryAllTransfers).not.toHaveBeenCalled();
  });

  it.each([
    ["limit below 1", `limit: 0`, "Must be >= 1"],
    ["limit above 200", `limit: 201`, "Must be <= 200"],
    ["negative fromLedger", `fromLedger: -1`, "Must be >= 0"],
    ["unknown event type", `eventTypes: ["bogus"]`, "Invalid eventType"],
    ["malformed fromDate", `fromDate: "not-a-date"`, "Invalid date"],
  ])("rejects %s", async (_name, arg, message) => {
    const res = await gql(`{ transfers(address: "${ALICE}", ${arg}) { hasMore } }`);

    expect(res.body.errors?.[0]?.message).toContain(message);
    expect(mockQueryAllTransfers).not.toHaveBeenCalled();
  });

  it("returns the transfer id REST already returns", async () => {
    mockQueryAllTransfers.mockResolvedValue({
      transfers: [row(7)],
      nextCursor: null,
      hasMore: false,
    } as never);

    const res = await gql(
      `{ transfers(address: "${ALICE}") { transfers { id eventId } } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.transfers.transfers).toEqual([{ id: 7, eventId: "ev-7" }]);
  });

  it("returns display totals on TokenSummary, computed like the REST summary", async () => {
    mockQuerySummary.mockResolvedValue([
      {
        contractId: "CTOKEN",
        totalReceived: "50000000000",
        totalSent: "10000000000",
        txCount: 42n,
      },
    ] as never);

    const res = await gql(
      `{ summary(address: "${ALICE}") { contractId totalReceived totalSent netFlow displayTotalReceived displayTotalSent displayNetFlow txCount } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.summary).toEqual([
      {
        contractId: "CTOKEN",
        totalReceived: "50000000000",
        totalSent: "10000000000",
        netFlow: "40000000000",
        displayTotalReceived: "5000.0000000",
        displayTotalSent: "1000.0000000",
        displayNetFlow: "4000.0000000",
        txCount: 42,
      },
    ]);
  });
});
