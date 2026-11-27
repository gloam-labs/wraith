/**
 * Persist GraphQL queries into the persisted-query allow-list.
 *
 * In production the GraphQL endpoint only runs queries whose SHA-256 hash
 * is in the allow-list (see ./persisted.ts). This module is how a query
 * gets in: it reads one or more `.graphql` files, hashes each query
 * exactly the way clients do, and merges the entries into the allow-list.
 *
 * This lives under `src/` (not `scripts/`) so the tests that use it can
 * import it without breaking `tsc`, which has `rootDir: ./src`.
 * The CLI entry point stays at `scripts/persist-graphql-queries.ts` —
 * a thin wrapper that re-exports this module.
 *
 * Usage:
 *   npm run graphql:persist -- queries/health.graphql [more.graphql ...]
 *   npm run graphql:persist -- --out path/to/persisted-queries.json queries/health.graphql
 *
 * The allow-list defaults to $PERSISTED_QUERIES_PATH, or
 * ./persisted-queries.json in the working directory — the same resolution
 * the server uses. Existing entries are kept; re-running with a changed
 * query adds its new hash alongside the old one.
 *
 * A query file's surrounding whitespace is trimmed before hashing, so the
 * hash is of the query itself, not of the file's trailing newline.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  hashPersistedQuery,
  isPersistedQueryAllowList,
  type PersistedQueryAllowList,
} from "./persisted";

export function defaultAllowListPath(): string {
  return path.resolve(
    process.env.PERSISTED_QUERIES_PATH ?? path.join(process.cwd(), "persisted-queries.json")
  );
}

function readExistingAllowList(outPath: string): PersistedQueryAllowList {
  if (!existsSync(outPath)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    throw new Error(
      `Existing allow-list at ${outPath} is not valid JSON. Fix or remove it, then run again — refusing to overwrite it.`
    );
  }

  if (!isPersistedQueryAllowList(parsed)) {
    throw new Error(
      `Existing allow-list at ${outPath} is not an object of hash to query string. Fix or remove it, then run again — refusing to overwrite it.`
    );
  }

  return parsed;
}

/**
 * Add every query in `queryFiles` to the allow-list at `outPath` and write
 * it back. Returns the full allow-list that was written.
 */
export function persistQueryFiles(
  queryFiles: string[],
  outPath: string
): PersistedQueryAllowList {
  const allowList: PersistedQueryAllowList = { ...readExistingAllowList(outPath) };

  for (const queryFile of queryFiles) {
    const query = readFileSync(queryFile, "utf8").trim();
    if (!query) {
      throw new Error(`${queryFile} is empty; there is no query to persist.`);
    }
    allowList[hashPersistedQuery(query)] = query;
  }

  writeFileSync(outPath, `${JSON.stringify(allowList, null, 2)}\n`);
  return allowList;
}

const USAGE =
  "Usage: npm run graphql:persist -- [--out <allow-list path>] <query.graphql> [more.graphql ...]";

export function main(argv: string[]): number {
  let outPath = defaultAllowListPath();
  const queryFiles: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[++i];
      if (!value) {
        console.error("[graphql:persist] --out needs a path.\n" + USAGE);
        return 1;
      }
      outPath = path.resolve(value);
    } else if (arg.startsWith("-")) {
      console.error(`[graphql:persist] Unknown option: ${arg}\n` + USAGE);
      return 1;
    } else {
      queryFiles.push(arg);
    }
  }

  if (queryFiles.length === 0) {
    console.error("[graphql:persist] No .graphql files given.\n" + USAGE);
    return 1;
  }

  let allowList: PersistedQueryAllowList;
  try {
    allowList = persistQueryFiles(queryFiles, outPath);
  } catch (err) {
    console.error(`[graphql:persist] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  for (const queryFile of queryFiles) {
    const query = readFileSync(queryFile, "utf8").trim();
    console.log(`[graphql:persist] ${hashPersistedQuery(query)}  ${queryFile}`);
  }
  console.log(
    `[graphql:persist] Wrote ${Object.keys(allowList).length} persisted quer${Object.keys(allowList).length === 1 ? "y" : "ies"} to ${outPath}`
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
