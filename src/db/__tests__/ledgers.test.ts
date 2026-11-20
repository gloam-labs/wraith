import {
  getLastIndexedLedger,
  getLastIndexedState,
  setLastIndexedLedger,
  getBackfillCursor,
  setBackfillCursor,
  clearBackfillCursor,
  rollbackToLedger,
} from "../ledgers";
import { prisma } from "../client";

jest.mock("../client", () => {
  const mockClient = {
    $transaction: jest.fn((ops) => Promise.all(ops)),
    indexerState: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    backfillCursor: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    tokenTransfer: {
      deleteMany: jest.fn(),
    },
    nftTransfer: {
      deleteMany: jest.fn(),
    },
    hostFnLog: {
      deleteMany: jest.fn(),
    },
    lpShareTransfer: {
      deleteMany: jest.fn(),
    },
  };

  return {
    prisma: mockClient,
  };
});

describe("ledgers db module", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getLastIndexedLedger", () => {
    it("returns null if no state exists", async () => {
      (prisma.indexerState.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const result = await getLastIndexedLedger("testnet");
      expect(result).toBeNull();
      expect(prisma.indexerState.findUnique).toHaveBeenCalledWith({
        where: { network: "testnet" },
      });
    });

    it("returns the stored ledger sequence", async () => {
      (prisma.indexerState.findUnique as jest.Mock).mockResolvedValueOnce({
        network: "testnet",
        lastIndexedLedger: 500123,
      });

      const result = await getLastIndexedLedger("testnet");
      expect(result).toBe(500123);
    });
  });

  describe("getLastIndexedState", () => {
    it("returns the last indexed ledger state", async () => {
      (prisma.indexerState.findUnique as jest.Mock).mockResolvedValueOnce({
        network: "testnet",
        lastIndexedLedger: 500123,
      });

      const result = await getLastIndexedState("testnet");
      expect(result).toEqual({ lastIndexedLedger: 500123 });
    });
  });

  describe("setLastIndexedLedger", () => {
    it("upserts indexer state with sequence and network", async () => {
      (prisma.indexerState.upsert as jest.Mock).mockResolvedValueOnce({});

      await setLastIndexedLedger(1000, "mainnet");

      expect(prisma.indexerState.upsert).toHaveBeenCalledWith({
        where: { network: "mainnet" },
        update: { lastIndexedLedger: 1000 },
        create: { network: "mainnet", lastIndexedLedger: 1000 },
      });
    });
  });

  describe("backfill cursor helpers", () => {
    it("gets, sets, and clears the backfill cursor", async () => {
      (prisma.backfillCursor.findUnique as jest.Mock).mockResolvedValueOnce({
        network: "testnet",
        nextLedger: 400,
        targetLedger: 500,
      });

      const cursor = await getBackfillCursor("testnet");
      expect(cursor?.nextLedger).toBe(400);

      (prisma.backfillCursor.upsert as jest.Mock).mockResolvedValueOnce({});
      await setBackfillCursor(450, 500, "testnet");
      expect(prisma.backfillCursor.upsert).toHaveBeenCalledTimes(1);

      (prisma.backfillCursor.deleteMany as jest.Mock).mockResolvedValueOnce({ count: 1 });
      await clearBackfillCursor("testnet");
      expect(prisma.backfillCursor.deleteMany).toHaveBeenCalledWith({
        where: { network: "testnet" },
      });
    });
  });

  describe("rollbackToLedger", () => {
    it("deletes event rows above target ledger and updates indexer state", async () => {
      (prisma.tokenTransfer.deleteMany as jest.Mock).mockReturnValue({ count: 10 });
      (prisma.nftTransfer.deleteMany as jest.Mock).mockReturnValue({ count: 5 });
      (prisma.hostFnLog.deleteMany as jest.Mock).mockReturnValue({ count: 3 });
      (prisma.lpShareTransfer.deleteMany as jest.Mock).mockReturnValue({ count: 2 });
      (prisma.indexerState.upsert as jest.Mock).mockReturnValue({});

      const totalDeleted = await rollbackToLedger(900, "testnet");
      expect(totalDeleted).toBe(20);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });
});
