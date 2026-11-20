import { queryPopularAssets } from "../assets";
import { prisma } from "../client";

jest.mock("../client", () => {
  return {
    prisma: {
      $queryRaw: jest.fn(),
    },
  };
});

describe("assets db module", () => {
  const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDY";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("queryPopularAssets", () => {
    it("queries popular assets ordered by count", async () => {
      const mockCountResult = [{ total: 1n }];
      const mockAssets = [
        {
          contractId: CONTRACT_A,
          transferCount: 50n,
          volume: "1000000",
        },
      ];

      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockAssets);

      const result = await queryPopularAssets({
        network: "testnet",
        fromDate: new Date("2026-01-01T00:00:00Z"),
        by: "count",
        limit: 10,
        offset: 0,
      });

      expect(result.total).toBe(1);
      expect(result.assets).toEqual(mockAssets);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it("queries popular assets ordered by volume and caps limit to 100", async () => {
      const mockCountResult = [{ total: 2n }];
      const mockAssets = [
        {
          contractId: CONTRACT_A,
          transferCount: 10n,
          volume: "50000000",
        },
      ];

      (prisma.$queryRaw as jest.Mock)
        .mockResolvedValueOnce(mockCountResult)
        .mockResolvedValueOnce(mockAssets);

      const result = await queryPopularAssets({
        network: "mainnet",
        fromDate: new Date("2026-01-01T00:00:00Z"),
        by: "volume",
        limit: 500, // exceeds cap
        offset: 0,
      });

      expect(result.total).toBe(2);
      expect(result.assets).toEqual(mockAssets);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });
});
