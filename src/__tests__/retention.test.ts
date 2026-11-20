import {
  planPartitionRetention,
  inferPartitionRangeEnd,
  formatQualifiedIdentifier,
  runPartitionRetentionJob,
  startPartitionRetentionJob,
  type PartitionMetadata,
} from "../jobs/retention";
import { prisma } from "../db";

jest.mock("../db", () => ({
  prisma: {
    $queryRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  },
}));

describe("Partition retention unit tests (#294)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("formatQualifiedIdentifier", () => {
    it("wraps single identifier in double quotes", () => {
      expect(formatQualifiedIdentifier("token_transfers")).toBe('"token_transfers"');
    });

    it("formats schema-qualified identifier", () => {
      expect(formatQualifiedIdentifier("wraith.token_transfers")).toBe('"wraith"."token_transfers"');
    });

    it("doubles embedded double quotes to safely quote identifiers", () => {
      expect(formatQualifiedIdentifier('table"with"quotes')).toBe('"table""with""quotes"');
      expect(formatQualifiedIdentifier('wraith."weird".table')).toBe('"wraith"."""weird"""."table"');
    });

    it("filters empty segments", () => {
      expect(formatQualifiedIdentifier(".wraith..table.")).toBe('"wraith"."table"');
    });
  });

  describe("inferPartitionRangeEnd", () => {
    it("parses year and month from _YYYYMM suffix", () => {
      const date = inferPartitionRangeEnd("token_transfers_202406");
      expect(date).toEqual(new Date(Date.UTC(2024, 5, 1)));
    });

    it("parses year, month, and day from _YYYYMMDD suffix", () => {
      const date = inferPartitionRangeEnd("token_transfers_20240615");
      expect(date).toEqual(new Date(Date.UTC(2024, 5, 15)));
    });

    it("returns null when no valid date suffix is present", () => {
      expect(inferPartitionRangeEnd("token_transfers")).toBeNull();
      expect(inferPartitionRangeEnd("token_transfers_latest")).toBeNull();
      expect(inferPartitionRangeEnd("token_transfers_123")).toBeNull();
    });
  });

  describe("planPartitionRetention", () => {
    it("compresses older partitions and archives partitions beyond the retention window", () => {
      const now = new Date("2024-12-15T00:00:00.000Z");
      const partitions: PartitionMetadata[] = [
        {
          name: "token_transfers_202406",
          schema: "wraith",
          parentTable: "token_transfers",
          rangeEnd: new Date("2024-06-01T00:00:00.000Z"),
          sizeBytes: 1_024,
        },
        {
          name: "token_transfers_202409",
          schema: "wraith",
          parentTable: "token_transfers",
          rangeEnd: new Date("2024-09-01T00:00:00.000Z"),
          sizeBytes: 2_048,
        },
        {
          name: "token_transfers_202411",
          schema: "wraith",
          parentTable: "token_transfers",
          rangeEnd: new Date("2024-11-01T00:00:00.000Z"),
          sizeBytes: 4_096,
        },
      ];

      const plan = planPartitionRetention(partitions, now, 3, 6);

      expect(plan.compress.map((partition) => partition.name)).toEqual(["token_transfers_202409"]);
      expect(plan.archive.map((partition) => partition.name)).toEqual(["token_transfers_202406"]);
      expect(plan.skipped.map((partition) => partition.name)).toEqual(["token_transfers_202411"]);
    });
  });

  describe("runPartitionRetentionJob unit flow", () => {
    it("executes compression, archive DDL and logs run to database", async () => {
      const mockPartitions = [
        { name: "token_transfers_202401", schema: "wraith", parentTable: "token_transfers", sizeBytes: 5000 },
        { name: "token_transfers_202407", schema: "wraith", parentTable: "token_transfers", sizeBytes: 3000 },
        { name: "token_transfers_202411", schema: "wraith", parentTable: "token_transfers", sizeBytes: 1000 },
      ];

      (prisma.$queryRaw as jest.Mock).mockResolvedValue(mockPartitions);
      (prisma.$executeRawUnsafe as jest.Mock).mockResolvedValue(1);

      const result = await runPartitionRetentionJob({
        compressionWindowMonths: 3,
        retentionWindowMonths: 6,
        now: new Date("2024-12-01T00:00:00.000Z"),
      });

      expect(result).toEqual({
        compressed: 1,
        archived: 1,
        reclaimedBytes: 8000,
        skipped: 1,
      });

      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith('CREATE SCHEMA IF NOT EXISTS "wraith_archive"');
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE IF EXISTS "token_transfers_202407" SET (toast.compress = \'pglz\')')
      );
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE IF EXISTS "token_transfers_202401" SET SCHEMA "wraith_archive"')
      );
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "wraith"."RetentionJobRun"')
      );
    });

    it("continues and logs warning if an individual partition DDL throws", async () => {
      const mockPartitions = [
        { name: "token_transfers_202401", schema: "wraith", parentTable: "token_transfers", sizeBytes: 5000 },
        { name: "token_transfers_202402", schema: "wraith", parentTable: "token_transfers", sizeBytes: 4000 },
      ];

      (prisma.$queryRaw as jest.Mock).mockResolvedValue(mockPartitions);
      (prisma.$executeRawUnsafe as jest.Mock)
        .mockResolvedValueOnce(1) // CREATE SCHEMA
        .mockRejectedValueOnce(new Error("relation does not exist")) // first archive fails
        .mockResolvedValueOnce(1) // second archive succeeds
        .mockResolvedValueOnce(1); // INSERT log

      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

      const result = await runPartitionRetentionJob({
        compressionWindowMonths: 3,
        retentionWindowMonths: 6,
        now: new Date("2024-12-01T00:00:00.000Z"),
      });

      expect(result.archived).toBe(1);
      expect(result.reclaimedBytes).toBe(4000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to archive partition token_transfers_202401:"),
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });
  });

  describe("startPartitionRetentionJob", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("returns null if interval is disabled or invalid", () => {
      process.env.PARTITION_RETENTION_INTERVAL_MS = "0";
      expect(startPartitionRetentionJob()).toBeNull();

      process.env.PARTITION_RETENTION_INTERVAL_MS = "-100";
      expect(startPartitionRetentionJob()).toBeNull();

      process.env.PARTITION_RETENTION_INTERVAL_MS = "invalid";
      expect(startPartitionRetentionJob()).toBeNull();
    });

    it("schedules recurring retention job when interval is positive", () => {
      (prisma.$queryRaw as jest.Mock).mockResolvedValue([]);
      (prisma.$executeRawUnsafe as jest.Mock).mockResolvedValue(1);

      process.env.PARTITION_RETENTION_INTERVAL_MS = "3600000";
      const timer = startPartitionRetentionJob();

      expect(timer).not.toBeNull();
      if (timer) clearInterval(timer);
    });

    it("handles and logs unhandled errors from runPartitionRetentionJob", async () => {
      (prisma.$queryRaw as jest.Mock).mockRejectedValue(new Error("DB Connection Error"));
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      process.env.PARTITION_RETENTION_INTERVAL_MS = "5000";
      const timer = startPartitionRetentionJob();

      // Flush microtasks and interval tick
      await jest.advanceTimersByTimeAsync(5000);

      expect(errSpy).toHaveBeenCalledWith("[retention] Job failed:", expect.any(Error));

      if (timer) clearInterval(timer);
      errSpy.mockRestore();
    });
  });
});
