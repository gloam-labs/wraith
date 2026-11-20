import { PrismaClient } from "@prisma/client";
import { encodeCursor, projectRecord } from "../lib/odata";
import { withReadReplicas } from "./router";
import type { ListPage } from "./types";

// ─── Singleton Prisma client ───────────────────────────────────────────────
// Re-use one connection pool across the process.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const replicaUrls = process.env.DATABASE_REPLICAS
  ? process.env.DATABASE_REPLICAS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

export const prisma =
  globalForPrisma.prisma ??
  withReadReplicas(
    new PrismaClient({
      // `query` only in development: it prints every statement, which is
      // noise in production and can carry parameter values into the log.
      // `error` stays in both. Prisma's error log goes to stdout, never to a
      // caller - the response-side leak was closed separately - and this is
      // the only place a failed write on a money-moving route becomes visible
      // at all, since the route handlers answer 500 without logging.
      log:
        process.env.NODE_ENV === "development"
          ? ["query", "warn", "error"]
          : ["warn", "error"],
    }),
    { replicaUrls }
  );

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * A `COUNT(*)` over the same filter costs as much as walking every matching
 * row, and on the tables this service exists to grow it dominates the request.
 * Lists therefore skip it unless the caller asks with `includeTotal` (#206);
 * `hasMore` from the n+1 fetch already answers what pagination needs.
 */
export function totalField(total: number | undefined): { total?: number } {
  return total === undefined ? {} : { total };
}

export function buildListPage<T extends { id: number }>(rows: T[], limit: number): ListPage<T> {
  if (rows.length <= limit) {
    return { rows, nextCursor: null, hasMore: false };
  }

  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    nextCursor: encodeCursor(pageRows[pageRows.length - 1].id),
    hasMore: true,
  };
}

export function selectRows<T extends Record<string, unknown>>(
  rows: T[],
  select: string[] | undefined,
  derived: Record<string, (row: T) => unknown> = {}
): Array<Record<string, unknown>> {
  return rows.map((row) => projectRecord(row, select, derived));
}
