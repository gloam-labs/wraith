/**
 * The operator surface: what broke, without database access.
 *
 * A failed payout used to be discoverable only by the user it happened to —
 * they saw an error, and nothing else learned about it. This router is the
 * answer to "what broke today": a token-gated list of the rows in the
 * `MoneyFailure` table, which is written by
 * {@link recordMoneyFailure} and by nothing else.
 *
 * What it deliberately is NOT:
 *
 *   - Not a log search. Ordinary request errors are not here; a 400 for a
 *     malformed bank code is not an incident and never becomes a row.
 *   - Not public. Every failure names an order, and a list of failed payouts
 *     is exactly the shape an attacker wants. `OPS_TOKEN` gates every route,
 *     and without it configured the router answers 503 — the same
 *     "this deployment has no such surface" shape the offramp router uses.
 *   - Not personal data. Rows carry the rail, the order id and what failed.
 *     Never a NIN, never bank details, never an amount: NDPA, and this
 *     surface does not need them to answer its question.
 */
import { timingSafeEqual } from "crypto";
import { Router, Request, Response, NextFunction } from "express";

import { prisma } from "../db";
import { isMoneyFailureKind, isMoneyFailureRail } from "../linq/moneyFailures";
import { hasNetworkSelector, requestNetwork } from "../middleware/network";

function isConfigured(): boolean {
  return Boolean(process.env.OPS_TOKEN?.trim());
}

/**
 * Constant-time comparison of the presented token against the configured one.
 *
 * Length is compared first because `timingSafeEqual` requires equal lengths —
 * and a mismatched length is not a secret worth protecting, only the content
 * is.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/** Default and cap for `GET /failures`. A page, not an export. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Parse a positive integer (1..MAX_SAFE_INTEGER).
 * Returns null if the value is not a valid positive integer string or number.
 */
function parsePositiveInteger(value: unknown): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!/^[1-9]\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function createOpsRouter(): Router {
  const router = Router();

  // Every route needs the token. The failures list names orders; without the
  // gate it would be a public index of every payout that did not complete.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!isConfigured()) {
      res.status(503).json({ error: "Ops endpoints are not configured on this deployment" });
      return;
    }
    const token = bearerToken(req);
    if (!token || !tokenMatches(token, process.env.OPS_TOKEN!.trim())) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "An operator token is required" });
      return;
    }
    next();
  });

  /**
   * Recent money-affecting failures, newest first.
   *
   * Query params, all optional:
   *   rail    — one of the bounded rails (offramp, onramp, bill, unknown)
   *   kind    — one of the bounded kinds (payout_rejected, order_failed,
   *             reconcile_failed)
   *   limit   — page size, positive integer, capped at 200, default 50
   *   before  — positive integer id, returning rows older than it
   *   since   — ISO 8601 date, returning rows recorded at or after it
   *   network — filter to a specific network (resolved by networkMiddleware)
   */
  router.get("/failures", async (req: Request, res: Response) => {
    const rail = req.query["rail"];
    if (rail !== undefined && !isMoneyFailureRail(rail)) {
      res.status(400).json({ error: "rail must be one of: offramp, onramp, bill, unknown" });
      return;
    }
    const kind = req.query["kind"];
    if (kind !== undefined && !isMoneyFailureKind(kind)) {
      res
        .status(400)
        .json({ error: "kind must be one of: payout_rejected, order_failed, reconcile_failed" });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (req.query["limit"] !== undefined) {
      const parsedLimit = parsePositiveInteger(req.query["limit"]);
      if (parsedLimit === null) {
        res.status(400).json({ error: "limit must be a positive integer" });
        return;
      }
      limit = Math.min(parsedLimit, MAX_LIMIT);
    }

    let before: number | undefined;
    if (req.query["before"] !== undefined) {
      const parsedBefore = parsePositiveInteger(req.query["before"]);
      if (parsedBefore === null) {
        res.status(400).json({ error: "before must be a positive integer" });
        return;
      }
      before = parsedBefore;
    }

    let since: Date | undefined;
    if (req.query["since"] !== undefined) {
      const rawSince = Array.isArray(req.query["since"]) ? req.query["since"][0] : req.query["since"];
      if (typeof rawSince !== "string" || !rawSince.trim()) {
        res.status(400).json({ error: "since must be a valid ISO date" });
        return;
      }
      const parsedDate = new Date(rawSince.trim());
      if (isNaN(parsedDate.getTime())) {
        res.status(400).json({ error: "since must be a valid ISO date" });
        return;
      }
      since = parsedDate;
    }

    // Only filter by network when the caller sent a selector; otherwise return all networks.
    const network = hasNetworkSelector(req) ? requestNetwork(req) : undefined;

    // no-store: an operator refreshing during an incident must see the row
    // the failure just wrote, not a cached page from before it.
    res.setHeader("Cache-Control", "no-store");

    try {
      // Newest first by primary key: every insert is an autoincrement, so this
      // orders by time of recording without a clock-skew footnote, and the
      // (network, createdAt) index serves the filter.
      // take: limit + 1 so we can tell if there is a next page without a separate count.
      const rows = await prisma.moneyFailure.findMany({
        where: {
          ...(network ? { network } : {}),
          ...(rail ? { rail } : {}),
          ...(kind ? { kind } : {}),
          ...(before !== undefined ? { id: { lt: before } } : {}),
          ...(since !== undefined ? { createdAt: { gte: since } } : {}),
        },
        orderBy: { id: "desc" },
        take: limit + 1,
      });

      const hasMore = rows.length > limit;
      const returnRows = hasMore ? rows.slice(0, limit) : rows;
      const nextBefore =
        hasMore && returnRows.length > 0
          ? returnRows[returnRows.length - 1].id
          : null;

      res.json({
        failures: returnRows.map((row) => ({
          id: row.id,
          network: row.network,
          rail: row.rail,
          kind: row.kind,
          orderId: row.orderId,
          publicId: row.publicId,
          providerCode: row.providerCode,
          message: row.message,
          occurrences: row.occurrences,
          firstSeenAt: row.createdAt.toISOString(),
          lastSeenAt: row.updatedAt.toISOString(),
        })),
        limit,
        nextBefore,
      });
    } catch (err) {
      console.error(
        "[ops] could not list money failures:",
        (err as Error)?.name ?? "unknown error",
      );
      res.status(500).json({ error: "Could not list failures" });
    }
  });

  return router;
}
