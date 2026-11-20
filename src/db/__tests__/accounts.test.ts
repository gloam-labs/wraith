import {
  upsertAccountSummaries,
  getAccountSummary,
  queryAccountSummaries,
} from "../accounts";
import { prisma } from "../client";
import type { TransferRecord } from "../types";

jest.mock("../client", () => {
  const actual = jest.requireActual("../client");
  const mockClient = {
    $executeRaw: jest.fn(),
    $transaction: jest.fn((ops) => Promise.all(ops)),
    accountSummary: {
      findMany: jest.fn(),
      count: jest.fn(),
    },
  };

  return {
    ...actual,
    prisma: mockClient,
  };
});

describe("accounts db module", () => {
  const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
  const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDY";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("upsertAccountSummaries", () => {
    it("does nothing when records list is empty", async () => {
      await upsertAccountSummaries([]);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it("aggregates transfer deltas and executes raw upsert query", async () => {
      (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

      const records: TransferRecord[] = [
        {
          contractId: CONTRACT_A,
          fromAddress: ALICE,
          toAddress: BOB,
          amount: "1000",
          ledgerClosedAt: new Date("2026-01-01T10:00:00Z"),
          ledgerSequence: 100,
        },
        {
          contractId: CONTRACT_A,
          fromAddress: BOB,
          toAddress: ALICE,
          amount: "400",
          ledgerClosedAt: new Date("2026-01-01T10:05:00Z"),
          ledgerSequence: 101,
        },
      ];

      await upsertAccountSummaries(records, "testnet");

      // ALICE has sent 1000, received 400 (net -600). BOB has sent 400, received 1000 (net +600).
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe("getAccountSummary", () => {
    it("fetches materialized summaries for an address", async () => {
      const mockRows = [
        {
          contractId: CONTRACT_A,
          totalSent: "1000",
          totalReceived: "400",
          net: "-600",
          txCount: 2,
          lastActivityAt: new Date(),
        },
      ];
      (prisma.accountSummary.findMany as jest.Mock).mockResolvedValueOnce(mockRows);

      const result = await getAccountSummary(ALICE, CONTRACT_A, "testnet");
      expect(result).toEqual(mockRows);
      expect(prisma.accountSummary.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("queryAccountSummaries", () => {
    it("returns paginated account summaries with total count", async () => {
      const mockItems = [
        {
          id: 1,
          address: ALICE,
          contractId: CONTRACT_A,
          totalSent: "1000",
          totalReceived: "400",
          net: "-600",
          txCount: 2,
          lastActivityAt: new Date(),
        },
      ];
      (prisma.$transaction as jest.Mock).mockResolvedValueOnce([1, mockItems]);

      const result = await queryAccountSummaries({
        address: ALICE,
        network: "testnet",
        limit: 10,
        offset: 0,
        includeTotal: true,
      });

      expect(result.transfers).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
