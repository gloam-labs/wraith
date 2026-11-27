/**
 * The persisted-query allow-list (#406).
 *
 * In production the GraphQL endpoint runs only allow-listed queries, and
 * the allow-list comes from a file an operator supplies. Two failures used
 * to look exactly the same as an empty list — a missing file and a broken
 * one — and neither said anything, so a default deployment refused every
 * query in silence. These pin the split:
 *
 *  - a missing file in production warns once, when the list is first
 *    loaded, and stays silent outside production, where the file is
 *    optional;
 *  - a file that exists but does not parse, or is not an object of hash to
 *    query string, logs an error naming the path — never the contents —
 *    and is treated as an empty list rather than crashing the process;
 *  - a query written by `npm run graphql:persist` is found by the hash its
 *    clients compute, the same SHA-256 the HTTP tests use.
 *
 * Nothing here reaches a database or a provider; the loader only reads a
 * file and the plugin only rewrites the request.
 */
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  getPersistedQuery,
  hashPersistedQuery,
  persistedQueryPlugin,
  resetPersistedQueryCache,
} from "../persisted";
import { persistQueryFiles } from "../persist-queries";

type RequestContext = Parameters<
  NonNullable<typeof persistedQueryPlugin.requestDidStart>
>[0];

interface FakeRequest {
  query?: string;
  extensions?: { persistedQuery?: { sha256Hash: string } };
}

/** Run the plugin's request hook on `request`, the way Apollo Server does. */
async function requestDidStart(request: FakeRequest): Promise<void> {
  await persistedQueryPlugin.requestDidStart?.({
    request,
  } as unknown as RequestContext);
}

describe("persisted query allow-list", () => {
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPersistedQueryCache();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "wraith-persisted-"));
    tempDirs.push(dir);
    return dir;
  }

  it("warns once, clearly, when the allow-list file is missing in production", () => {
    process.env.NODE_ENV = "production";
    const missing = path.join(tempDir(), "persisted-queries.json");
    process.env.PERSISTED_QUERIES_PATH = missing;
    resetPersistedQueryCache();

    expect(getPersistedQuery("firsthash")).toBeUndefined();
    expect(getPersistedQuery("secondhash")).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain("graphql.persisted_queries.missing");
    expect(line).toContain(missing);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("stays silent about a missing allow-list outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.PERSISTED_QUERIES_PATH = path.join(tempDir(), "persisted-queries.json");
    resetPersistedQueryCache();

    expect(getPersistedQuery("firsthash")).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs an error naming the path, never the contents, for an unparseable allow-list", () => {
    const file = path.join(tempDir(), "persisted-queries.json");
    writeFileSync(file, "{ this is not json: SECRET-CONTENTS-MARKER ");
    process.env.PERSISTED_QUERIES_PATH = file;
    resetPersistedQueryCache();

    expect(getPersistedQuery("firsthash")).toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("graphql.persisted_queries.invalid");
    expect(line).toContain(file);
    expect(line).not.toContain("SECRET-CONTENTS-MARKER");
  });

  it.each([
    ["an array", JSON.stringify(["{ health { ok } }"])],
    ["an object with non-string values", JSON.stringify({ abcdef: 42 })],
    ["a bare string", JSON.stringify("{ health { ok } }")],
  ])("logs an error for an allow-list that is %s", (_label, contents) => {
    const file = path.join(tempDir(), "persisted-queries.json");
    writeFileSync(file, contents);
    process.env.PERSISTED_QUERIES_PATH = file;
    resetPersistedQueryCache();

    expect(getPersistedQuery("firsthash")).toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0][0]);
    expect(line).toContain("graphql.persisted_queries.invalid");
    expect(line).toContain(file);
  });

  it("round-trips a .graphql file through graphql:persist into the plugin", async () => {
    process.env.NODE_ENV = "production";
    const dir = tempDir();

    const query = "{ health { ok } }";
    const queryFile = path.join(dir, "health.graphql");
    writeFileSync(queryFile, `${query}\n`);
    const outPath = path.join(dir, "persisted-queries.json");

    const allowList = persistQueryFiles([queryFile], outPath);
    const hash = createHash("sha256").update(query).digest("hex");
    expect(allowList).toEqual({ [hash]: query });
    expect(JSON.parse(readFileSync(outPath, "utf8"))).toEqual({ [hash]: query });

    process.env.PERSISTED_QUERIES_PATH = outPath;
    resetPersistedQueryCache();

    const request: FakeRequest = {
      extensions: { persistedQuery: { sha256Hash: hash } },
    };
    await requestDidStart(request);

    expect(request.query).toBe(query);
    expect(request.extensions?.persistedQuery).toBeUndefined();
  });

  it("keeps existing entries when graphql:persist adds another query", () => {
    const dir = tempDir();
    const outPath = path.join(dir, "persisted-queries.json");

    const first = path.join(dir, "health.graphql");
    writeFileSync(first, "{ health { ok } }\n");
    persistQueryFiles([first], outPath);

    const second = path.join(dir, "health-version.graphql");
    writeFileSync(second, "{ health { ok version } }\n");
    const allowList = persistQueryFiles([second], outPath);

    expect(allowList).toEqual({
      [hashPersistedQuery("{ health { ok } }")]: "{ health { ok } }",
      [hashPersistedQuery("{ health { ok version } }")]: "{ health { ok version } }",
    });
  });

  it("ships a starter allow-list whose health query hashes check out", () => {
    const starter = JSON.parse(
      readFileSync(path.join(process.cwd(), "persisted-queries.json"), "utf8")
    ) as Record<string, string>;

    const queries = Object.values(starter);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((query) => query.includes("health"))).toBe(true);
    for (const [hash, query] of Object.entries(starter)) {
      expect(hashPersistedQuery(query)).toBe(hash);
    }
  });
});
