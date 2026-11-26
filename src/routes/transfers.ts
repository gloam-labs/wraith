import { Router, Request, Response, NextFunction } from "express";
import { queryTransfers, queryAllTransfers, queryByTxHash, querySummary } from "../db";
import { parseOr400 } from "../openapi/validation";
import { transferQuerySchema, txHashParamsSchema, summaryQuerySchema } from "../openapi/schemas";
import { requestNetwork } from "../middleware/network";
import { getCachedTokenDecimals } from "../tokenCache";
import { toDisplayAmount } from "../amount";
import { type Network } from "../network";

const withDisplay = <T extends { amount: string; contractId?: string; displayAmount?: string }>(
  transfer: T,
  network: Network,
) => ({
  ...transfer,
  displayAmount:
    transfer.displayAmount ??
    toDisplayAmount(
      transfer.amount,
      transfer.contractId ? getCachedTokenDecimals(transfer.contractId, network) : undefined,
    ),
});

/**
 * Escape a value for CSV output.
 * If the value contains comma, quote, or newline, wrap in quotes and escape inner quotes.
 */
function escapeCSVValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Format a row of values as a CSV line.
 */
function formatCSVRow(values: unknown[]): string {
  return values.map(escapeCSVValue).join(",");
}

/**
 * Transfers and summary router.
 *
 * Endpoints:
 *   GET /transfers/incoming/:address
 *   GET /transfers/outgoing/:address
 *   GET /transfers/address/:address
 *   GET /transfers/address/:address/export.csv
 *   GET /transfers/tx/:txHash
 *   GET /summary/:address
 *   GET /accounts/:address/summary
 */
export function createTransfersRouter(): Router {
  const router = Router();

  // ─── GET /transfers/incoming/:address ────────────────────────────────────
  router.get(
    "/transfers/incoming/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, cursor, $filter, $select, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
          token?: string;
        };

        const network = requestNetwork(req);
        const result = await queryTransfers({
          network,
          tokenDecimals: getCachedTokenDecimals,
          address,
          direction: "incoming",
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
          includeTotal: (parsed as { includeTotal?: boolean }).includeTotal,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string; contractId?: string; displayAmount?: string }, network);
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/outgoing/:address ────────────────────────────────────
  router.get(
    "/transfers/outgoing/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, cursor, $filter, $select, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
          token?: string;
        };

        const network = requestNetwork(req);
        const result = await queryTransfers({
          network,
          tokenDecimals: getCachedTokenDecimals,
          address,
          direction: "outgoing",
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
          includeTotal: (parsed as { includeTotal?: boolean }).includeTotal,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string; contractId?: string; displayAmount?: string }, network);
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/address/:address ─────────────────────────────────────
  router.get(
    "/transfers/address/:address",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, token, cursor, $filter, $select } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          token?: string;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const network = requestNetwork(req);
        const result = await queryAllTransfers({
          network,
          tokenDecimals: getCachedTokenDecimals,
          address,
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
          includeTotal: (parsed as { includeTotal?: boolean }).includeTotal,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string; contractId?: string; displayAmount?: string }, network);
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/address/:address/export.csv ───────────────────────────
  router.get(
    "/transfers/address/:address/export.csv",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(
          transferQuerySchema.omit({ limit: true, offset: true, cursor: true, $filter: true, $select: true }),
          { ...req.params, ...req.query },
          res,
        );
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, token } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          token?: string;
        };

        const network = requestNetwork(req);
        const result = await queryAllTransfers({
          network,
          tokenDecimals: getCachedTokenDecimals,
          address,
          contractId,
          token,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit: 10000,
          offset: 0,
        });

        const csvLines: string[] = [];
        csvLines.push(formatCSVRow(["date", "type", "from", "to", "amount", "token", "ledger"]));

        for (const transfer of result.transfers) {
          const t = transfer as Record<string, unknown>;
          const displayAmount = toDisplayAmount(
            String(t.amount ?? "0"),
            typeof t.contractId === "string"
              ? getCachedTokenDecimals(t.contractId, network)
              : undefined,
          );
          const closedAt = t.ledgerClosedAt instanceof Date
            ? t.ledgerClosedAt
            : new Date(String(t.ledgerClosedAt ?? 0));
          csvLines.push(
            formatCSVRow([
              closedAt.toISOString(),
              t.eventType,
              t.fromAddress || "",
              t.toAddress || "",
              displayAmount,
              t.contractId,
              t.ledger,
            ])
          );
        }

        const csvContent = csvLines.join("\n");

        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="transfers-${address}.csv"`);
        res.send(csvContent);
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /transfers/tx/:txHash ───────────────────────────────────────────
  router.get(
    "/transfers/tx/:txHash",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(txHashParamsSchema, req.params, res);
        if (!parsed) return;
        const network = requestNetwork(req);
        const transfers = await queryByTxHash(parsed.txHash, network);
        res.json({
          transfers: transfers.map((transfer) => ({
            ...transfer,
            displayAmount: toDisplayAmount(
              transfer.amount,
              getCachedTokenDecimals(transfer.contractId, network),
            ),
          })),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /summary/:address & /accounts/:address/summary ───────────────────
  const summaryHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseOr400(summaryQuerySchema, { ...req.params, ...req.query }, res);
      if (!parsed) return;
      const { address, contractId, fromDate, toDate } = parsed;

      const network = requestNetwork(req);
      const rows = await querySummary({
        network,
        address,
        contractId,
        fromDate,
        toDate,
      });

      const tokens = rows.map((row) => {
        const received = BigInt(row.totalReceived);
        const sent = BigInt(row.totalSent);
        const net = received - sent;
        return {
          contractId: row.contractId,
          totalReceived: row.totalReceived,
          totalSent: row.totalSent,
          netFlow: net.toString(),
          displayTotalReceived: toDisplayAmount(row.totalReceived, getCachedTokenDecimals(row.contractId, network)),
          displayTotalSent: toDisplayAmount(row.totalSent, getCachedTokenDecimals(row.contractId, network)),
          displayNetFlow: toDisplayAmount(net.toString(), getCachedTokenDecimals(row.contractId, network)),
          txCount: Number(row.txCount),
        };
      });

      res.json({
        address,
        window: {
          fromDate: fromDate?.toISOString() ?? null,
          toDate: toDate?.toISOString() ?? null,
        },
        tokens,
      });
    } catch (err) {
      next(err);
    }
  };

  router.get("/summary/:address", summaryHandler);
  router.get("/accounts/:address/summary", summaryHandler);

  return router;
}
