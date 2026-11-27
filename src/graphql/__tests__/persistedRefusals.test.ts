/**
 * Persisted-query refusals (#404).
 *
 * In production the persisted-query plugin refuses two requests: one with
 * no hash at all, and one whose hash is not on the allow-list. Those
 * refusals used to be thrown from requestDidStart, which Apollo Server
 * answers as a server fault — HTTP 500, message masked as "Internal server
 * error" — so a client that simply had not registered its query was told
 * the server had failed and given nothing it could act on.
 *
 * These pin the refusal as a client error instead: HTTP 400, the real
 * message, and a stable extensions.code, still with no resolver work done.
 * The HTTP-level pins live in src/__tests__/graphql.test.ts; this file
 * drives the plugin directly and through a real ApolloServer, neither of
 * which needs a database.
 */
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ApolloServer } from "@apollo/server";
import { GraphQLError } from "graphql";
import { persistedQueryPlugin, resetPersistedQueryCache } from "../persisted";

type PluginListener = {
  didResolveOperation?: () => Promise<void>;
};

type PluginRequest = {
  query?: string;
  extensions?: { persistedQuery?: { sha256Hash: string } };
};

/** Run the plugin's requestDidStart the way Apollo Server does. */
async function requestDidStart(request: PluginRequest): Promise<PluginListener | void> {
  const plugin = persistedQueryPlugin as {
    requestDidStart?: (context: { request: PluginRequest }) => Promise<PluginListener | void>;
  };
  return plugin.requestDidStart?.({ request });
}

describe("persistedQueryPlugin refusals", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPersistedQueryCache();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function allowListFile(entries: Record<string, string>): void {
    const tempDir = mkdtempSync(path.join(tmpdir(), "wraith-persisted-"));
    tempDirs.push(tempDir);
    process.env.PERSISTED_QUERIES_PATH = path.join(tempDir, "persisted-queries.json");
    writeFileSync(process.env.PERSISTED_QUERIES_PATH, JSON.stringify(entries));
    resetPersistedQueryCache();
  }

  it("refuses a production request with no hash as a client error", async () => {
    process.env.NODE_ENV = "production";

    const listener = await requestDidStart({ query: "{ health { ok } }" });
    const refusal = await listener?.didResolveOperation?.().catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(GraphQLError);
    expect((refusal as GraphQLError).message).toBe(
      "Persisted query hash is required in production",
    );
    expect((refusal as GraphQLError).extensions.code).toBe("PERSISTED_QUERY_REQUIRED");
    expect((refusal as GraphQLError).extensions.http).toEqual({ status: 400 });
  });

  it("refuses a production request whose hash is not allow-listed as a client error", async () => {
    process.env.NODE_ENV = "production";
    allowListFile({});
    const hash = createHash("sha256").update("{ health { ok } }").digest("hex");
    const request: PluginRequest = { extensions: { persistedQuery: { sha256Hash: hash } } };

    const listener = await requestDidStart(request);
    const refusal = await listener?.didResolveOperation?.().catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(GraphQLError);
    expect((refusal as GraphQLError).message).toBe(`Persisted query not found for hash ${hash}`);
    expect((refusal as GraphQLError).extensions.code).toBe("PERSISTED_QUERY_NOT_FOUND");
    expect((refusal as GraphQLError).extensions.http).toEqual({ status: 400 });
    // The extension is dropped so Apollo's built-in persisted-query
    // handling cannot answer first with its own 200 "not supported" error.
    expect(request.extensions?.persistedQuery).toBeUndefined();
  });

  it("still substitutes an allow-listed query and refuses nothing", async () => {
    process.env.NODE_ENV = "production";
    const query = "{ health { ok } }";
    const hash = createHash("sha256").update(query).digest("hex");
    allowListFile({ [hash]: query });
    const request: PluginRequest = { extensions: { persistedQuery: { sha256Hash: hash } } };

    const listener = await requestDidStart(request);

    expect(listener?.didResolveOperation).toBeUndefined();
    expect(request.query).toBe(query);
    expect(request.extensions?.persistedQuery).toBeUndefined();
  });

  it("refuses nothing outside production", async () => {
    process.env.NODE_ENV = "test";

    await expect(requestDidStart({ query: "{ health { ok } }" })).resolves.toBeUndefined();
    await expect(
      requestDidStart({ extensions: { persistedQuery: { sha256Hash: "0".repeat(64) } } }),
    ).resolves.toBeUndefined();
  });

  describe("through a real ApolloServer", () => {
    const typeDefs = /* GraphQL */ `
      type Health {
        ok: Boolean!
        version: String!
      }

      type Query {
        health: Health
      }
    `;

    const health = jest.fn(() => ({ ok: true, version: "1.0.0" }));
    const server = new ApolloServer({
      typeDefs,
      resolvers: { Query: { health } },
      persistedQueries: false,
      plugins: [persistedQueryPlugin],
    });

    beforeAll(async () => {
      await server.start();
    });

    afterAll(async () => {
      await server.stop();
    });

    it("answers a no-hash production request 400 before any resolver runs", async () => {
      process.env.NODE_ENV = "production";

      const res = await server.executeOperation({ query: "{ health { ok } }" });

      if (res.body?.kind !== "single") throw new Error("expected a single result");
      expect(res.http.status).toBe(400);
      expect(res.body.singleResult.data).toBeUndefined();
      expect(res.body.singleResult.errors?.[0]?.message).toBe(
        "Persisted query hash is required in production",
      );
      expect(res.body.singleResult.errors?.[0]?.extensions?.code).toBe(
        "PERSISTED_QUERY_REQUIRED",
      );
      expect(health).not.toHaveBeenCalled();
    });

    it("answers an unknown-hash production request 400 before any resolver runs", async () => {
      process.env.NODE_ENV = "production";
      allowListFile({});
      const hash = createHash("sha256").update("{ health { ok } }").digest("hex");

      const res = await server.executeOperation({
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
      } as never);

      if (res.body?.kind !== "single") throw new Error("expected a single result");
      expect(res.http.status).toBe(400);
      expect(res.body.singleResult.data).toBeUndefined();
      expect(res.body.singleResult.errors?.[0]?.message).toBe(
        `Persisted query not found for hash ${hash}`,
      );
      expect(res.body.singleResult.errors?.[0]?.extensions?.code).toBe(
        "PERSISTED_QUERY_NOT_FOUND",
      );
      expect(health).not.toHaveBeenCalled();
    });
  });
});
