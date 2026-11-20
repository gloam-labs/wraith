import {
  queryBalances,
  querySummary,
  queryTransfers,
  queryByTxHash,
  pruneOldTransfers,
} from "../transfers";
import { prisma } from "../client";

jest.mock("../client", () => {
  const actual = jest.requireActual("../client");
  const mockClient = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $transaction: jest.fn((ops) => (Array.isArray(ops) ? Promise.all(ops) : ops(mockClient))),
    tokenTransfer: {
      findMany: jest.fn(),
      count: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    hostFnLog: {
      deleteMany: jest.fn(),
    },
    nftTransfer: {
      deleteMany: jest.fn(),
    },
    contractTombstone: {
      deleteMany: jest.fn(),
    },
    lpShareTransfer: {
      deleteMany: jest.fn(),
    },
  };

  return {
    ...actual,
    prisma: mockClient,
  };
});

describe("transfers db module", () => {
  const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDY";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("queryBalances", () => {
    it("returns aggregated non-zero token balances for an address", async () => {
      const mockRows = [
        { contractId: CONTRACT_A, balance: "10000000" },
      ];
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce(mockRows);

      const result = await queryBalances(ALICE, "testnet");
      expect(result).toEqual(mockRows);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("scopes to the default network when omitted", async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

      const result = await queryBalances(ALICE);
      expect(result).toEqual([]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe("querySummary", () => {
    it("returns totals and transaction count grouped by contract", async () => {
      const mockSummary = [
        {
          contractId: CONTRACT_A,
          totalReceived: "5000",
          totalSent: "2000",
          txCount: 3n,
        },
      ];
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce(mockSummary);

      const result = await querySummary({
        address: ALICE,
        network: "testnet",
        contractId: CONTRACT_A,
      });

      expect(result).toEqual(mockSummary);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("applies date filters when provided", async () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);
      const fromDate = new Date("2026-01-01T00:00:00Z");
      const toDate = new Date("2026-01-02T00:00:00Z");

      await querySummary({
        address: ALICE,
        network: "mainnet",
        fromDate,
        toDate,
      });

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe("queryTransfers", () => {
    it("queries transfer records with pagination and total count", async () => {
      const mockTransfers = [
        {
          id: 1,
          contractId: CONTRACT_A,
          fromAddress: ALICE,
          toAddress: null,
          amount: "100",
          ledgerClosedAt: new Date(),
        },
      ];
      (prisma.$transaction as jest.Mock).mockResolvedValueOnce([1, mockTransfers]);

      const result = await queryTransfers({
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

  describe("queryByTxHash", () => {
    it("fetches transfers for a specific transaction hash", async () => {
      const mockTxTransfers = [
        {
          id: 42,
          txHash: "tx-abc-123",
          contractId: CONTRACT_A,
        },
      ];
      (prisma.tokenTransfer.findMany as jest.Mock).mockResolvedValueOnce(mockTxTransfers);

      const result = await queryByTxHash("tx-abc-123", "testnet");
      expect(result).toEqual(mockTxTransfers);
      expect(prisma.tokenTransfer.findMany).toHaveBeenCalledWith({
        where: {
          network: "testnet",
          txHash: "tx-abc-123",
        },
        orderBy: { id: "asc" },
      });
    });
  });

  describe("pruneOldTransfers", () => {
    it("deletes records older than retention period across all indexed tables", async () => {
      (prisma.tokenTransfer.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 10 });
      (prisma.nftTransfer.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 5 });
      (prisma.hostFnLog.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 20 });
      (prisma.lpShareTransfer.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 1 });

      const totalDeleted = await pruneOldTransfers("testnet");
      expect(totalDeleted).toBe(36);
    });
  });
});
