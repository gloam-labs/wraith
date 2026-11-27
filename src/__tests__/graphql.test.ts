import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import request from "supertest";
import { createApp } from "../api";
import { querySummary } from "../db";
import { resetPersistedQueryCache } from "../graphql/persisted";
import { persistQueryFiles } from "../graphql/persist-queries";

jest.mock("../db", () => ({
  getAccountSummary: jest.fn().mockResolvedValue([]),
  getLastIndexedLedger: jest.fn().mockResolvedValue(1),
  getNftMetadata: jest.fn(),
  getNftOwner: jest.fn(),
  prisma: {
    $queryRaw: jest.fn(),
    webhookSubscription: {
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    webhookDelivery: {
      findMany: jest.fn(),
    },
  },
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  queryNftTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
}));

jest.mock("../rpc", () => ({
  getLatestLedger: jest.fn().mockResolvedValue(1),
}));

jest.mock("../indexer", () => ({
  // #161: /status also reads per-network loop state. Listed explicitly
  // because a partial mock silently 500s the route rather than failing loudly.
  getAllIndexerStats: jest.fn().mockReturnValue({}),
  runningNetworks: jest.fn().mockReturnValue([]),
  getIndexerStats: jest.fn().mockReturnValue({ uptimeSeconds: 0, totalIndexed: 0 }),
}));

jest.mock("../indexer/host-fn-log", () => ({
  queryHostFnLogs: jest.fn().mockResolvedValue({ total: 0, logs: [] }),
}));

describe("GraphQL server plugins", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPersistedQueryCache();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #404: a plugin refusal is a client error, not a server fault. These two
  // tests used to pin the opposite — HTTP 500 with the real message masked
  // as "Internal server error" — which described the wrong behaviour: the
  // caller was told the server had failed when the query was simply refused,
  // and was given nothing it could act on.
  it("rejects an over-cost query at /graphql", async () => {
    process.env.GRAPHQL_MAX_COST = "1";

    const res = await request(createApp())
      .post("/graphql")
      .send({ query: "{ health { ok version } }" });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toBe(
      "Query cost 3 exceeds the maximum allowed cost of 1",
    );
    expect(res.body.errors?.[0]?.extensions?.code).toBe("QUERY_TOO_COSTLY");
  });

  it("blocks non-allowlisted production queries at /graphql", async () => {
    process.env.NODE_ENV = "production";
    const res = await request(createApp())
      .post("/graphql")
      .send({ query: "{ health { ok } }" });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toBe(
      "Persisted query hash is required in production",
    );
    expect(res.body.errors?.[0]?.extensions?.code).toBe("PERSISTED_QUERY_REQUIRED");
  });

  it("answers an unknown persisted hash in production with a client error", async () => {
    process.env.NODE_ENV = "production";
    const hash = createHash("sha256").update("{ health { ok } }").digest("hex");

    const res = await request(createApp())
      .post("/graphql")
      .send({ extensions: { persistedQuery: { sha256Hash: hash } } });

    expect(res.status).toBe(400);
    expect(res.body.data).toBeUndefined();
    expect(res.body.errors?.[0]?.message).toBe(`Persisted query not found for hash ${hash}`);
    expect(res.body.errors?.[0]?.extensions?.code).toBe("PERSISTED_QUERY_NOT_FOUND");
  });

  // #404 changed only the plugins' refusals. A failure nobody planned for —
  // here a resolver whose database call blows up — must still be masked:
  // the client learns that the server failed, never why.
  it("still masks a genuinely unexpected failure at /graphql", async () => {
    (querySummary as jest.Mock).mockRejectedValueOnce(
      new Error("postgres://user:secret@db.internal:5432/wraith"),
    );

    const res = await request(createApp())
      .post("/graphql")
      .send({ query: '{ summary(address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") { contractId } }' });

    expect(res.body.data).toBeNull();
    expect(res.body.errors?.[0]?.message).toBe("Internal server error");
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("runs an allowlisted persisted query in production", async () => {
    process.env.NODE_ENV = "production";

    const query = "{ health { ok } }";
    const hash = createHash("sha256").update(query).digest("hex");
    const tempDir = mkdtempSync(path.join(tmpdir(), "wraith-persisted-"));
    tempDirs.push(tempDir);

    process.env.PERSISTED_QUERIES_PATH = path.join(tempDir, "persisted-queries.json");
    writeFileSync(process.env.PERSISTED_QUERIES_PATH, JSON.stringify({ [hash]: query }));
    resetPersistedQueryCache();

    const res = await request(createApp())
      .post("/graphql")
      .send({ extensions: { persistedQuery: { sha256Hash: hash } } });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.health.ok).toBe(true);
  });

  it("runs a query persisted by graphql:persist in production", async () => {
    process.env.NODE_ENV = "production";

    const query = "{ health { ok } }";
    const tempDir = mkdtempSync(path.join(tmpdir(), "wraith-persisted-"));
    tempDirs.push(tempDir);

    const queryFile = path.join(tempDir, "health.graphql");
    writeFileSync(queryFile, `${query}\n`);
    const outPath = path.join(tempDir, "persisted-queries.json");
    persistQueryFiles([queryFile], outPath);

    process.env.PERSISTED_QUERIES_PATH = outPath;
    resetPersistedQueryCache();

    const hash = createHash("sha256").update(query).digest("hex");
    const res = await request(createApp())
      .post("/graphql")
      .send({ extensions: { persistedQuery: { sha256Hash: hash } } });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.health.ok).toBe(true);
  });
});

