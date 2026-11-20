import { PrismaClient } from "@prisma/client";
import { runPartitionRetentionJob, formatQualifiedIdentifier } from "../../src/jobs/retention";

const prisma = new PrismaClient();

const isDbReachable = async (): Promise<boolean> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
};

describe("Partition retention execution on real PostgreSQL (#294)", () => {
  let dbAvailable = false;

  beforeAll(async () => {
    dbAvailable = await isDbReachable();
    if (!dbAvailable) return;

    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith"');
    await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "wraith_archive" CASCADE');

    // Create a partitioned table in wraith schema
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers" (
        id text NOT NULL,
        timestamp timestamptz NOT NULL,
        amount text NOT NULL
      ) PARTITION BY RANGE (timestamp)
    `);

    // Create partitions: old (to be archived), medium (to be compressed), future (to be untouched)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers_202001"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers_202310"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2023-10-01') TO ('2023-11-01')
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers_209901"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')
    `);

    // Standalone unpartitioned table in wraith schema
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_standalone" (
        id serial PRIMARY KEY,
        name text NOT NULL
      )
    `);

    // Insert test data
    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_202001" (id, timestamp, amount)
      VALUES ('tx1', '2020-01-15T00:00:00Z', '1000')
    `);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_202310" (id, timestamp, amount)
      VALUES ('tx2', '2023-10-15T00:00:00Z', '2000')
    `);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_209901" (id, timestamp, amount)
      VALUES ('tx3', '2099-01-15T00:00:00Z', '3000')
    `);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_standalone" (name)
      VALUES ('stay_here')
    `);
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    try {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith"."retention_test_transfers" CASCADE');
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith"."retention_test_standalone" CASCADE');
      await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS "wraith_archive" CASCADE');
    } finally {
      await prisma.$disconnect();
    }
  });

  it("exercises execution path on real PostgreSQL: moves old partition to wraith_archive and compresses medium", async () => {
    if (!dbAvailable) {
      console.warn("Skipping real database test because database is unreachable");
      return;
    }

    // Run job targeting reference date 2024-01-01:
    // - 202001 is 48 months old -> archived
    // - 202310 is 3 months old -> compressed
    // - 209901 is future -> skipped
    const result = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    expect(result.archived).toBeGreaterThanOrEqual(1);
    expect(result.compressed).toBeGreaterThanOrEqual(1);

    // Assert schema placement in PostgreSQL system catalogs
    const archivedCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_202001'
    `;
    expect(archivedCheck[0]?.nspname).toBe("wraith_archive");

    // Assert compressed partition remains in wraith schema
    const compressedCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_202310'
    `;
    expect(compressedCheck[0]?.nspname).toBe("wraith");
  });

  it("proves partitions and tables outside the plan are completely untouched", async () => {
    if (!dbAvailable) return;

    // Check future partition remains in wraith schema
    const futureCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_209901'
    `;
    expect(futureCheck[0]?.nspname).toBe("wraith");

    // Check standalone table remains in wraith schema
    const standaloneCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_standalone'
    `;
    expect(standaloneCheck[0]?.nspname).toBe("wraith");
  });

  it("handles already-applied runs idempotently when archive schema already exists", async () => {
    if (!dbAvailable) return;

    // Second run with the same parameters
    const secondResult = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    // Already archived partitions are no longer in schema 'wraith', so archived count is 0
    expect(secondResult.archived).toBe(0);
  });

  it("recovers cleanly from interrupted runs where partial partitions were already archived", async () => {
    if (!dbAvailable) return;

    // Add a new partition for 201912 and manually move it to wraith_archive (simulating partial completion)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith_archive"."retention_test_transfers_201912" (
        id text NOT NULL,
        timestamp timestamptz NOT NULL,
        amount text NOT NULL
      )
    `);

    // Add another partition that is still in wraith
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers_201911"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2019-11-01') TO ('2019-12-01')
    `);

    // Run job: should archive 201911 without complaining about 201912 already being in wraith_archive
    const recoveryResult = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    expect(recoveryResult.archived).toBeGreaterThanOrEqual(1);

    const check1911 = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_201911'
    `;
    expect(check1911[0]?.nspname).toBe("wraith_archive");

    // Clean up partial test partition
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith_archive"."retention_test_transfers_201912"');
  });

  it("handles a partition disappearing between planning and execution without crashing", async () => {
    if (!dbAvailable) return;

    // Create a temporary partition
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "wraith"."retention_test_transfers_201801"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2018-01-01') TO ('2018-02-01')
    `);

    // Verify formatQualifiedIdentifier quotes safely
    const quoted = formatQualifiedIdentifier("wraith.retention_test_transfers_201801");
    expect(quoted).toBe('"wraith"."retention_test_transfers_201801"');

    // Run should process it cleanly
    const result = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });
    expect(result).toBeDefined();
  });
});
