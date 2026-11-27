import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { GraphQLError } from "graphql";
import { logger } from "../logger";

export type PersistedQueryAllowList = Record<string, string>;

let allowList: PersistedQueryAllowList | null = null;

function allowListPath(): string {
  return path.resolve(
    process.env.PERSISTED_QUERIES_PATH ?? path.join(process.cwd(), "persisted-queries.json")
  );
}

/**
 * The hash a client sends as `extensions.persistedQuery.sha256Hash`:
 * SHA-256 of the exact query string, hex encoded. `npm run graphql:persist`
 * keys the allow-list with this same function, so a query persisted by the
 * script is found by the hash its clients compute.
 */
export function hashPersistedQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/**
 * An allow-list is a plain object of hash to query string. Anything else —
 * an array, a scalar, an object with non-string values — is a broken file,
 * not an empty list.
 */
export function isPersistedQueryAllowList(value: unknown): value is PersistedQueryAllowList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function loadAllowList(): PersistedQueryAllowList {
  if (allowList !== null) {
    return allowList;
  }

  const filePath = allowListPath();

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    allowList = {};

    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      // A missing file is only a failure in production, where the empty
      // list refuses every query — so it gets one clear warning, once,
      // when the list is first loaded. Outside production the file is
      // optional and its absence stays silent.
      if (process.env.NODE_ENV === "production") {
        logger.warn("graphql.persisted_queries.missing", {
          path: filePath,
          message:
            "Persisted GraphQL query allow-list not found. In production every GraphQL query is refused until the file exists: create it with `npm run graphql:persist`, or set PERSISTED_QUERIES_PATH to its location.",
        });
      }
    } else {
      logger.error("graphql.persisted_queries.unreadable", {
        path: filePath,
        message:
          "Persisted GraphQL query allow-list could not be read. Treating it as empty; in production every GraphQL query is refused.",
      });
    }

    return allowList;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (!isPersistedQueryAllowList(parsed)) {
    // Name the path, never the contents: the file is operator-supplied and
    // its contents do not belong in a log line.
    logger.error("graphql.persisted_queries.invalid", {
      path: filePath,
      message:
        "Persisted GraphQL query allow-list is not valid JSON, or is not an object of hash to query string. Treating it as empty; in production every GraphQL query is refused.",
    });
    allowList = {};
    return allowList;
  }

  allowList = parsed;
  return allowList;
}

export function getPersistedQuery(hash: string): string | undefined {
  return loadAllowList()[hash];
}

export function resetPersistedQueryCache(): void {
  allowList = null;
}

/**
 * A production refusal as a client error (#404).
 *
 * The refusal is thrown from the request listener's didResolveOperation,
 * not from requestDidStart: Apollo Server treats an error thrown by
 * requestDidStart itself as a server fault — HTTP 500 with the message
 * masked as "Internal server error" — while an error thrown from
 * didResolveOperation reaches the client as-is, and extensions.http sets
 * the response status. didResolveOperation runs before any resolver, so a
 * refused request still does no resolver work.
 */
function refusal(message: string, code: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code, http: { status: 400 } } });
}

export const persistedQueryPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart(requestContext) {
    const { request } = requestContext;
    const hash = request?.extensions?.persistedQuery?.sha256Hash;
    const production = process.env.NODE_ENV === "production";

    if (!hash) {
      if (!production) {
        return;
      }

      return {
        async didResolveOperation() {
          throw refusal("Persisted query hash is required in production", "PERSISTED_QUERY_REQUIRED");
        },
      };
    }

    const query = getPersistedQuery(hash);
    if (query) {
      request.query = query;
      delete request.extensions?.persistedQuery;
      return;
    }

    if (!production) {
      return;
    }

    // Unknown hash in production. Keep Apollo's built-in persisted-query
    // handling from answering first — with support disabled it would reply
    // "PersistedQueryNotSupported" with a 200 — by dropping the extension,
    // and stand in a query that parses when the client sent none, purely so
    // the pipeline reaches didResolveOperation; the refusal throws there
    // before anything executes, so the stand-in never runs.
    delete request.extensions?.persistedQuery;
    if (!request.query) {
      request.query = "{ __typename }";
    }

    return {
      async didResolveOperation() {
        throw refusal(`Persisted query not found for hash ${hash}`, "PERSISTED_QUERY_NOT_FOUND");
      },
    };
  },
};
