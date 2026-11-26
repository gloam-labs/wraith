import { vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runPartitionRetentionJob, formatQualifiedIdentifier } from "../../src/jobs/retention";

const HAS_DB = !!process.env.DATABASE_URL;
const describeWithDb = HAS_DB ? describe : describe.skip;

function assertSafeTestDatabase(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set to run retention integration tests");
  }
  const parsed = new URL(databaseUrl);
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
  const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "postgres" || host === "db";
  const isTestDb = dbName.includes("test") || isLocalHost;
  if (!isTestDb) {
    throw new Error(
      `Refusing to run retention integration tests against non-test database: host=${host}, db=${dbName}`
    );
  }
}

const TEST_PARTITIONS = [
  "retention_test_transfers_202001",
  "retention_test_transfers_202310",
  "retention_test_transfers_209901",
  "retention_test_transfers_201912",
  "retention_test_transfers_201911",
  "retention_test_transfers_201801",
  "retention_test_transfers_201802",
];

async function cleanupTestTables(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith"."retention_test_transfers" CASCADE');
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith"."retention_test_standalone" CASCADE');
  for (const name of TEST_PARTITIONS) {
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "wraith_archive"."${name}" CASCADE`);
  }
}

describeWithDb("Partition retention execution on real PostgreSQL (#294)", () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    assertSafeTestDatabase(process.env.DATABASE_URL);
    await prisma.$queryRaw`SELECT 1`;

    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith"');
    await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith_archive"');
    await cleanupTestTables(prisma);

    // Create a partitioned table in wraith schema
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers" (
        id text NOT NULL,
        timestamp timestamptz NOT NULL,
        amount text NOT NULL
      ) PARTITION BY RANGE (timestamp)
    `);

    // Create partitions: old (to be archived), medium (to be compressed), future (to be untouched)
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_202001"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_202310"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2023-10-01') TO ('2023-11-01')
    `);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_209901"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2099-01-01') TO ('2099-02-01')
    `);

    // Standalone unpartitioned table in wraith schema
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_standalone" (
        id serial PRIMARY KEY,
        name text NOT NULL
      )
    `);

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
    try {
      await cleanupTestTables(prisma);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("exercises execution path on real PostgreSQL: moves old partition to wraith_archive and compresses medium", async () => {
    // Run job targeting reference date 2024-01-01:
    // - 202001 is 48 months old -> archived
    // - 202310 is 3 months old -> compressed
    // - 209901 is future -> skipped
    const result = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    expect(result.archived).toBe(1);
    expect(result.compressed).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Assert schema placement and data preservation in PostgreSQL
    const archivedCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_202001'
    `;
    expect(archivedCheck[0]?.nspname).toBe("wraith_archive");

    const archivedRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "wraith_archive"."retention_test_transfers_202001"
    `;
    expect(archivedRows.map((r) => r.id)).toEqual(["tx1"]);

    // Assert compressed partition remains in wraith schema with toast_tuple_target applied
    const compressedCheck = await prisma.$queryRaw<Array<{ nspname: string; reloptions: string[] | null }>>`
      SELECT n.nspname, c.reloptions
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_202310'
    `;
    expect(compressedCheck[0]?.nspname).toBe("wraith");
    expect(compressedCheck[0]?.reloptions).toContain("toast_tuple_target=128");
  });

  it("proves partitions and tables outside the plan are completely untouched", async () => {
    const futureCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_transfers_209901'
    `;
    expect(futureCheck[0]?.nspname).toBe("wraith");

    const standaloneCheck = await prisma.$queryRaw<Array<{ nspname: string }>>`
      SELECT n.nspname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = 'retention_test_standalone'
    `;
    expect(standaloneCheck[0]?.nspname).toBe("wraith");
  });

  it("handles already-applied runs idempotently when archive schema already exists", async () => {
    const secondResult = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    expect(secondResult.archived).toBe(0);
    expect(secondResult.compressed).toBe(1);
  });

  it("recovers cleanly from interrupted runs where partial partitions were already archived", async () => {
    // Simulate an interrupted prior run: 201912 was already moved to wraith_archive,
    // while 201911 is still in wraith with live data.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_201912"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2019-12-01') TO ('2020-01-01')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_201912" (id, timestamp, amount)
      VALUES ('tx_1912', '2019-12-15T00:00:00Z', '1200')
    `);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "wraith"."retention_test_transfers_201912" SET SCHEMA "wraith_archive"`
    );

    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_201911"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2019-11-01') TO ('2019-12-01')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_201911" (id, timestamp, amount)
      VALUES ('tx_1911', '2019-11-15T00:00:00Z', '1100')
    `);

    const recoveryResult = await runPartitionRetentionJob({
      compressionWindowMonths: 3,
      retentionWindowMonths: 6,
      now: new Date("2024-01-01T00:00:00Z"),
    });

    // Only 201911 was archived in this run (201912 was already in wraith_archive)
    expect(recoveryResult.archived).toBe(1);

    const rows1911 = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "wraith_archive"."retention_test_transfers_201911"
    `;
    expect(rows1911.map((r) => r.id)).toEqual(["tx_1911"]);

    const rows1912 = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "wraith_archive"."retention_test_transfers_201912"
    `;
    expect(rows1912.map((r) => r.id)).toEqual(["tx_1912"]);

    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith_archive"."retention_test_transfers_201911"');
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "wraith_archive"."retention_test_transfers_201912"');
  });

  it("does not count a vanished partition as archived and records partial_failure status", async () => {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_201801"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2018-01-01') TO ('2018-02-01')
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "wraith"."retention_test_transfers_201802"
      PARTITION OF "wraith"."retention_test_transfers"
      FOR VALUES FROM ('2018-02-01') TO ('2018-03-01')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "wraith"."retention_test_transfers_201802" (id, timestamp, amount)
      VALUES ('tx_1802', '2018-02-15T00:00:00Z', '1802')
    `);

    expect(formatQualifiedIdentifier("wraith.retention_test_transfers_201801")).toBe(
      '"wraith"."retention_test_transfers_201801"'
    );

    // Drop 201801 right after planning queries the partition list so execution hits a vanished partition
    const { prisma: jobPrisma } = await import("../../src/db");
    const origQueryRaw = jobPrisma.$queryRaw.bind(jobPrisma);
    let droppedAfterPlan = false;
    const spy = vi.spyOn(jobPrisma, "$queryRaw").mockImplementation(((...args: unknown[]) => {
      const p = (origQueryRaw as (...a: unknown[]) => Promise<unknown>)(...args).then(async (res) => {
        if (!droppedAfterPlan) {
          droppedAfterPlan = true;
          await prisma.$executeRawUnsafe('DROP TABLE "wraith"."retention_test_transfers_201801"');
        }
        return res;
      });
      return p;
    }) as unknown as typeof jobPrisma.$queryRaw);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof runPartitionRetentionJob>>;
    try {
      result = await runPartitionRetentionJob({
        compressionWindowMonths: 3,
        retentionWindowMonths: 6,
        now: new Date("2024-01-01T00:00:00Z"),
      });
    } finally {
      spy.mockRestore();
      warnSpy.mockRestore();
    }

    // 201801 vanished so it must NOT be counted; only 201802 was archived
    expect(result.archived).toBe(1);

    const rows1802 = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "wraith_archive"."retention_test_transfers_201802"
    `;
    expect(rows1802.map((r) => r.id)).toEqual(["tx_1802"]);

    const latestRun = await prisma.$queryRaw<Array<{ status: string; archived: number }>>`
      SELECT "status", "archived"
      FROM "wraith"."RetentionJobRun"
      ORDER BY "id" DESC
      LIMIT 1
    `;
    expect(latestRun[0]?.status).toBe("partial_failure");
    expect(latestRun[0]?.archived).toBe(1);
  });
});
