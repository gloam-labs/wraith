import { Router, Request, Response, NextFunction } from "express";
import { format as csvFormat } from "@fast-csv/format";
import { prisma, toDisplayAmount } from "../db";
import os from "os";
import path from "path";
import fs from "fs";
import { once } from "events";
import { finished } from "stream/promises";
import { z } from "zod";
import { requestNetwork } from "../middleware/network";
import { parseOr400 } from "../openapi/validation";
import type { Network } from "../network";
import { getCachedTokenDecimals } from "../tokenCache";

// How many rows we fetch per DB round-trip. Keeps memory flat.
const BATCH_SIZE = 500;

// Hard cap on rows returned per export request. Callers that need more should
// paginate with fromLedger/toLedger or apply a tighter date/address filter.
// The value is deliberately large enough to be useful but small enough to keep
// memory and response time predictable under load.
const ABSOLUTE_MAX_ROWS = 500_000;

/**
 * Default row cap, overridable per deployment with EXPORT_MAX_ROWS.
 *
 * Clamped to ABSOLUTE_MAX_ROWS rather than trusted: an env var is how an
 * operator lowers this without a release, and a mistyped one must not be able
 * to raise it past what the process can hold. A non-numeric value falls back
 * rather than becoming NaN, which would make every comparison below false.
 */
const DEFAULT_MAX_ROWS = Math.min(
  Number(process.env.EXPORT_MAX_ROWS) || 50_000,
  ABSOLUTE_MAX_ROWS,
);

// ── Query-param schema ────────────────────────────────────────────────────────
// Exported so the OpenAPI build can reference it.
export const exportQuerySchema = z.object({
  address:    z.string().trim().optional(),
  contractId: z.string().trim().optional(),
  fromLedger: z.coerce.number().int().min(0).optional(),
  toLedger:   z.coerce.number().int().min(0).optional(),
  fromDate:   z.string().datetime({ offset: true, message: "Invalid date — expected ISO 8601 (e.g. 2025-01-01T00:00:00Z)" })
                .transform((v) => new Date(v)).optional(),
  toDate:     z.string().datetime({ offset: true, message: "Invalid date — expected ISO 8601 (e.g. 2025-01-01T00:00:00Z)" })
                .transform((v) => new Date(v)).optional(),
  eventType:  z.string().trim().optional(),
  maxRows:    z.coerce.number().int()
                .min(1, "maxRows must be >= 1")
                .max(ABSOLUTE_MAX_ROWS, `maxRows must be <= ${ABSOLUTE_MAX_ROWS}`)
                .optional(),
});

type ExportQuery = z.infer<typeof exportQuerySchema>;

// ── Shared: build a Prisma where clause from validated params ─────────────────
function buildWhere(params: ExportQuery, network: Network) {
  const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType } = params;

  // Network first: an export must not leak rows from a chain the caller did
  // not ask for, and every filter below narrows within it.
  const where: Record<string, unknown> = { network };

  if (address) {
    where.OR = [{ fromAddress: address }, { toAddress: address }];
  }
  if (contractId) where.contractId = contractId;
  if (eventType) {
    const types = eventType.split(",").map((s) => s.trim()).filter(Boolean);
    if (types.length) where.eventType = { in: types };
  }

  const ledgerRange: Record<string, number> = {};
  if (fromLedger !== undefined) ledgerRange.gte = fromLedger;
  if (toLedger !== undefined)   ledgerRange.lte = toLedger;
  if (Object.keys(ledgerRange).length) where.ledger = ledgerRange;

  const dateRange: Record<string, Date> = {};
  if (fromDate) dateRange.gte = fromDate;
  if (toDate)   dateRange.lte = toDate;
  if (Object.keys(dateRange).length) where.ledgerClosedAt = dateRange;

  return where;
}

/**
 * Is there a row beyond the cap?
 *
 * Asked before any bytes are written, because that is the only time the answer
 * can still be put in a header. Detecting truncation mid-stream — by fetching
 * one extra row and then calling res.setHeader — throws ERR_HTTP_HEADERS_SENT:
 * the first csvStream.write has already flushed the response head. That throw
 * skips csvStream.end(), so the client is left holding a CSV body that never
 * terminates, and it happens only on the truncation path, which is the one case
 * the signalling exists for.
 *
 * One indexed query against the same filter, and cheaper than a COUNT because
 * it stops at the first row past the cap.
 */
async function hasRowsBeyond(where: Record<string, unknown>, max: number): Promise<boolean> {
  const beyond = await prisma.tokenTransfer.findMany({
    where,
    orderBy: { id: "asc" },
    skip: max,
    take: 1,
    select: { id: true },
  });
  return beyond.length > 0;
}

// ── Shared: client disconnect & backpressure helpers (#399) ───────────────────

/**
 * Track premature client disconnection on a streaming HTTP response.
 *
 * We listen to `res`'s `"close"` (guarded by `!res.writableEnded`) rather than
 * `req`'s `"close"` alone because Node 16+ fires `req`'s `"close"` as soon as
 * the request body finishes — immediately on GET requests, even while the
 * client is still reading the response.
 */
function trackClientDisconnect(
  req: Request,
  res: Response,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();

  const onDisconnect = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort();
    }
  };

  if (res.destroyed && !res.writableEnded) {
    controller.abort();
  }

  req.on("aborted", onDisconnect);
  res.on("close", onDisconnect);
  res.on("error", onDisconnect);

  const cleanup = () => {
    req.off("aborted", onDisconnect);
    res.off("close", onDisconnect);
    res.off("error", onDisconnect);
  };

  return { signal: controller.signal, cleanup };
}

/**
 * Wait for `stream` to drain when `.write()` returns `false`, waking up
 * immediately if the client disconnects (`signal` aborts) or `stream` closes
 * so a slow or vanished client can neither buffer unboundedly nor hang the loop.
 */
function waitForDrainOrAbort(
  stream: NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || stream.destroyed || stream.writableEnded) {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("close", onStop);
      stream.off("error", onStop);
      signal.removeEventListener("abort", onStop);
    };
    const onDrain = () => {
      cleanup();
      resolve(!signal.aborted);
    };
    const onStop = () => {
      cleanup();
      resolve(false);
    };

    stream.once("drain", onDrain);
    stream.once("close", onStop);
    stream.once("error", onStop);
    signal.addEventListener("abort", onStop, { once: true });
  });
}

// ── Shared: async generator that yields rows in batches via cursor ────────────
// Stops once `limit` rows have been yielded or `signal` aborts so callers never
// pull more than they asked for or keep querying after a client disconnects.
async function* streamTransfers(
  where: Record<string, unknown>,
  limit: number,
  signal?: AbortSignal,
) {
  let lastId: number | undefined = undefined;
  let yielded = 0;

  while (yielded < limit && !signal?.aborted) {
    const take = Math.min(BATCH_SIZE, limit - yielded);

    const rows: Awaited<ReturnType<typeof prisma.tokenTransfer.findMany>> =
      await prisma.tokenTransfer.findMany({
        where,
        orderBy: { id: "asc" },
        take,
        ...(lastId !== undefined ? { cursor: { id: lastId }, skip: 1 } : {}),
      });

    if (signal?.aborted || rows.length === 0) break;

    for (const row of rows) {
      if (signal?.aborted) return;
      yield row;
      yielded++;
    }

    if (rows.length < take) break;
    lastId = rows[rows.length - 1].id;
  }
}

// ── CSV endpoint ──────────────────────────────────────────────────────────────
async function handleCsvExport(req: Request, res: Response, next: NextFunction) {
  const parsed = parseOr400(exportQuerySchema, req.query, res);
  if (!parsed) return;

  const { signal, cleanup: cleanupAbort } = trackClientDisconnect(req, res);
  let csvStream: ReturnType<typeof csvFormat> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    const effectiveMax = parsed.maxRows ?? DEFAULT_MAX_ROWS;
    const network = requestNetwork(req);
    const where = buildWhere(parsed, network);

    // Before a single byte: once the body starts, headers can no longer be set.
    if (signal.aborted) return;
    const truncated = await hasRowsBeyond(where, effectiveMax);
    if (signal.aborted) return;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"transfers.csv\"");
    res.setHeader("Transfer-Encoding", "chunked");
    if (truncated) {
      res.setHeader("X-Truncated", "true");
      res.setHeader("X-Row-Limit", String(effectiveMax));
    }

    csvStream = csvFormat({ headers: true });
    const activeCsv = csvStream;
    const csvFinished = finished(activeCsv);
    // Abort or premature close can reject csvFinished before we await it.
    void csvFinished.catch(() => {});

    onAbort = () => {
      activeCsv.unpipe(res);
      if (!activeCsv.destroyed) {
        activeCsv.destroy();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    activeCsv.pipe(res);

    for await (const row of streamTransfers(where, effectiveMax, signal)) {
      if (signal.aborted) break;

      const canContinue = activeCsv.write({
        id:             row.id,
        contractId:     row.contractId,
        eventType:      row.eventType,
        fromAddress:    row.fromAddress ?? "",
        toAddress:      row.toAddress ?? "",
        amount:         row.amount,
        displayAmount:  toDisplayAmount(row.amount, getCachedTokenDecimals(row.contractId, network)),
        ledger:         row.ledger,
        ledgerClosedAt: row.ledgerClosedAt.toISOString(),
        txHash:         row.txHash,
        eventId:        row.eventId,
        isSac:          row.isSac ?? false,
        createdAt:      row.createdAt.toISOString(),
      });

      if (!canContinue) {
        const drained = await waitForDrainOrAbort(activeCsv, signal);
        if (!drained) break;
      }
    }

    if (signal.aborted) {
      onAbort();
      return;
    }

    activeCsv.end();
    await csvFinished.catch(() => {});
  } catch (err) {
    if (csvStream && !csvStream.destroyed) {
      csvStream.unpipe(res);
      csvStream.destroy();
    }
    if (!signal.aborted) {
      next(err);
    }
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    cleanupAbort();
  }
}

// ── Parquet endpoint ──────────────────────────────────────────────────────────
async function handleParquetExport(req: Request, res: Response, next: NextFunction) {
  const parsed = parseOr400(exportQuerySchema, req.query, res);
  if (!parsed) return;

  // parquetjs-lite is a CommonJS module — require() avoids ESM interop issues
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const parquet = require("parquetjs-lite");

  const tmpFile = path.join(
    os.tmpdir(),
    `transfers-${Date.now()}-${Math.random().toString(36).slice(2)}.parquet`,
  );
  const { signal, cleanup: cleanupAbort } = trackClientDisconnect(req, res);
  let outputStream: fs.WriteStream | undefined;
  let outputClosed: Promise<void> | undefined;
  let fileStream: fs.ReadStream | undefined;
  let fileClosed: Promise<void> | undefined;

  const cleanupTempResources = async () => {
    if (fileStream && !fileStream.destroyed) {
      fileStream.unpipe(res);
      fileStream.destroy();
    }
    if (fileClosed) {
      await fileClosed;
    }
    // Let the writer's initial header write finish before releasing the file.
    if (outputStream && !outputStream.destroyed && !outputStream.writableEnded) {
      outputStream.end();
    }
    if (outputClosed) {
      await outputClosed;
    }
    await fs.promises.unlink(tmpFile).catch(() => {});
  };

  try {
    const effectiveMax = parsed.maxRows ?? DEFAULT_MAX_ROWS;
    const network = requestNetwork(req);
    const where = buildWhere(parsed, network);

    const schema = new parquet.ParquetSchema({
      id:             { type: "INT64" },
      contractId:     { type: "UTF8" },
      eventType:      { type: "UTF8" },
      fromAddress:    { type: "UTF8", optional: true },
      toAddress:      { type: "UTF8", optional: true },
      amount:         { type: "UTF8" },
      displayAmount:  { type: "UTF8" },
      ledger:         { type: "INT32" },
      ledgerClosedAt: { type: "UTF8" },
      txHash:         { type: "UTF8" },
      eventId:        { type: "UTF8" },
      isSac:          { type: "BOOLEAN", optional: true },
      createdAt:      { type: "UTF8" },
    });

    // Headers are set after the file is written here, so this could have been
    // detected mid-stream — but it goes through the same helper as CSV so the
    // two endpoints cannot answer differently about the same query.
    if (signal.aborted) return;
    const truncated = await hasRowsBeyond(where, effectiveMax);
    if (signal.aborted) return;

    // Own the stream so a query, row, footer failure, or client disconnect can
    // close it without calling close() a second time on a partially closed writer.
    outputStream = fs.createWriteStream(tmpFile);
    outputClosed = new Promise<void>((resolve) => outputStream!.once("close", resolve));
    const outputFinished = finished(outputStream);
    // Writer operations can fail before we reach the completion await below.
    void outputFinished.catch(() => {});
    await once(outputStream, "open");

    if (signal.aborted) {
      await cleanupTempResources();
      return;
    }

    const writer = await parquet.ParquetWriter.openStream(schema, outputStream);

    for await (const row of streamTransfers(where, effectiveMax, signal)) {
      if (signal.aborted) break;

      await writer.appendRow({
        id:             row.id,
        contractId:     row.contractId,
        eventType:      row.eventType,
        fromAddress:    row.fromAddress ?? null,
        toAddress:      row.toAddress ?? null,
        amount:         row.amount,
        displayAmount:  toDisplayAmount(row.amount, getCachedTokenDecimals(row.contractId, network)),
        ledger:         row.ledger,
        ledgerClosedAt: row.ledgerClosedAt.toISOString(),
        txHash:         row.txHash,
        eventId:        row.eventId,
        isSac:          row.isSac ?? null,
        createdAt:      row.createdAt.toISOString(),
      });

      if (signal.aborted) break;
    }

    if (signal.aborted) {
      await cleanupTempResources();
      return;
    }

    await writer.close();
    await outputFinished;

    if (signal.aborted) {
      await cleanupTempResources();
      return;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename=\"transfers.parquet\"");
    if (truncated) {
      res.setHeader("X-Truncated", "true");
      res.setHeader("X-Row-Limit", String(effectiveMax));
    }

    fileStream = fs.createReadStream(tmpFile);
    const activeReadStream = fileStream;
    fileClosed = new Promise<void>((resolve) => activeReadStream.once("close", resolve));
    const onAbortDuringPipe = () => {
      activeReadStream.unpipe(res);
      if (!activeReadStream.destroyed) {
        activeReadStream.destroy();
      }
    };
    signal.addEventListener("abort", onAbortDuringPipe, { once: true });

    activeReadStream.pipe(res);
    try {
      await finished(activeReadStream);
    } finally {
      signal.removeEventListener("abort", onAbortDuringPipe);
    }

    await fileClosed;
    await fs.promises.unlink(tmpFile).catch(() => {});
  } catch (err) {
    await cleanupTempResources();
    if (!signal.aborted) {
      next(err);
    }
  } finally {
    cleanupAbort();
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createExportsRouter(): Router {
  const router = Router();
  router.get("/transfers.csv",     handleCsvExport);
  router.get("/transfers.parquet", handleParquetExport);
  return router;
}
