/**
 * Client-abort handling, CSV backpressure, and Parquet temp-file cleanup (#399).
 *
 * Verifies that:
 *  1. Disconnecting after the first batch of a multi-batch CSV export stops
 *     further database queries (at most 1 additional in-flight batch query).
 *  2. Slow CSV consumers exert real backpressure: the export loop pauses on
 *     `csvStream.write() === false` until `drain` rather than pulling the rest
 *     of the database into memory, and completes byte-for-byte intact once the
 *     consumer resumes.
 *  3. Disconnecting while paused waiting for `drain` unblocks immediately
 *     instead of hanging forever.
 *  4. Disconnecting mid-Parquet export — either during DB batch ingestion or
 *     while streaming the generated file — halts further DB queries and closes
 *     + unlinks the temporary `.parquet` file with zero leftovers.
 *  5. Full multi-batch CSV and Parquet exports remain byte-for-byte consistent.
 */

import express, { NextFunction, Request, Response } from "express";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { Writable } from "stream";
import { finished } from "stream/promises";
import { StrKey } from "@stellar/stellar-sdk";

jest.mock("../../db", () => ({
  prisma: { tokenTransfer: { findMany: jest.fn() } },
  toDisplayAmount: (amount: string) => amount,
}));
jest.mock("../../tokenCache", () => ({ getCachedTokenDecimals: () => 7 }));

import { createExportsRouter } from "../../routes/exports";
import { prisma } from "../../db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parquet = require("parquetjs-lite");
const mockFindMany = prisma.tokenTransfer.findMany as jest.Mock;
const realCreateWriteStream = fs.createWriteStream.bind(fs);

const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 71));
const ALICE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 71));
const BOB = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 72));

function makeRow(id: number) {
  return {
    id,
    contractId: CONTRACT,
    eventType: "transfer",
    fromAddress: ALICE,
    toAddress: BOB,
    amount: String(1000 + id),
    ledger: 5000 + id,
    ledgerClosedAt: new Date("2026-02-01T00:00:00.000Z"),
    txHash: `txhash-${id}`,
    eventId: `evt-${String(id).padStart(6, "0")}`,
    isSac: id % 2 === 0,
    createdAt: new Date("2026-02-01T00:00:01.000Z"),
  };
}

type FindManyArgs = {
  skip?: number;
  take?: number;
  cursor?: { id: number };
  select?: { id?: boolean };
};

function createDataset(total: number) {
  return Array.from({ length: total }, (_, idx) => makeRow(idx + 1));
}

function sliceDataset(all: ReturnType<typeof createDataset>, args: FindManyArgs) {
  // Prisma positions `cursor` AT the matching row, then applies `skip` (e.g. skip: 1 moves past it).
  const cursorIdx = args.cursor ? all.findIndex((r) => r.id === args.cursor!.id) : 0;
  const from = cursorIdx + (args.skip ?? 0);
  return all.slice(from, from + (args.take ?? all.length));
}

function isProbeQuery(args: FindManyArgs): boolean {
  return args.select?.id === true && args.take === 1;
}

/** Minimal controllable Writable response for deterministic backpressure tests. */
class SlowMockResponse extends Writable {
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];
  private blocked = false;
  private pendingCallbacks: Array<() => void> = [];

  constructor(highWaterMark = 128) {
    super({ highWaterMark });
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  block(): void {
    this.blocked = true;
  }

  release(): void {
    this.blocked = false;
    const queued = this.pendingCallbacks.splice(0);
    for (const cb of queued) cb();
  }

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (this.blocked) {
      this.pendingCallbacks.push(() => callback());
    } else {
      callback();
    }
  }

  bodyText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function extractRouteHandler(router: ReturnType<typeof createExportsRouter>, routePath: string) {
  const stack = (router as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ handle: (req: Request, res: Response, next: NextFunction) => Promise<void> | void }> };
    }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === routePath);
  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Could not find route handler for ${routePath}`);
  }
  return layer.route.stack[0].handle;
}

function waitTicks(count = 5): Promise<void> {
  return new Promise((resolve) => {
    let remaining = count;
    const step = () => {
      remaining--;
      if (remaining <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

async function startServer(onError: (err: unknown) => void): Promise<{
  server: http.Server;
  port: number;
  handlerDone: Promise<void>;
  resetHandlerDone: () => void;
}> {
  let resolveDone!: () => void;
  let handlerDone = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const app = express();
  app.use((_req, res, next) => {
    res.once("close", () => setImmediate(resolveDone));
    next();
  });
  app.use(createExportsRouter());
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    onError(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "export failed" });
    }
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }

  return {
    server,
    port: address.port,
    get handlerDone() {
      return handlerDone;
    },
    resetHandlerDone() {
      handlerDone = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
    },
  };
}

describe("Export client-abort, backpressure, and temp cleanup (#399)", () => {
  let trackedOutputs: fs.WriteStream[];

  beforeEach(() => {
    mockFindMany.mockReset();
    trackedOutputs = [];
    jest.spyOn(fs, "createWriteStream").mockImplementation((file, options) => {
      const stream = realCreateWriteStream(file, options);
      if (String(file).startsWith(path.join(os.tmpdir(), "transfers-"))) {
        trackedOutputs.push(stream);
      }
      return stream;
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const out of trackedOutputs) {
      out.destroy();
      await finished(out).catch(() => {});
      await fs.promises.unlink(out.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
  });

  it("CSV: stops querying the DB after client disconnects following the first batch", async () => {
    const dataset = createDataset(3000); // 6 batches of 500
    let batchQueries = 0;
    let releaseSecondBatch!: () => void;
    const secondBatchGate = new Promise<void>((resolve) => {
      releaseSecondBatch = resolve;
    });

    mockFindMany.mockImplementation(async (args: FindManyArgs) => {
      if (isProbeQuery(args)) return sliceDataset(dataset, args);
      batchQueries++;
      if (batchQueries === 2) {
        // Hold the 2nd batch briefly until the client receives chunk 1 and disconnects.
        await secondBatchGate;
      }
      return sliceDataset(dataset, args);
    });

    const errors: unknown[] = [];
    const { server, port } = await startServer((err) => errors.push(err));

    try {
      let batchQueriesAtAbort = 0;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/transfers.csv?maxRows=3000`, (res) => {
          res.once("data", () => {
            batchQueriesAtAbort = batchQueries;
            req.destroy();
            // Let any in-flight 2nd batch finish after the socket is torn down.
            setTimeout(() => {
              releaseSecondBatch();
              resolve();
            }, 30);
          });
        });
        req.on("error", () => {
          // Expected ECONNRESET on client-initiated destroy()
        });
        setTimeout(() => reject(new Error("Timed out waiting for first CSV chunk")), 5000).unref();
      });

      await new Promise((r) => setTimeout(r, 80));

      // Must stop after at most 1 additional in-flight batch query — never all 6 batches.
      expect(batchQueriesAtAbort).toBeGreaterThanOrEqual(1);
      expect(batchQueries).toBeLessThanOrEqual(batchQueriesAtAbort + 1);
      expect(batchQueries).toBeLessThan(6);
      expect(errors).toHaveLength(0);
    } finally {
      releaseSecondBatch();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("CSV: pauses DB batching on slow consumer backpressure and completes byte-for-byte after drain", async () => {
    const dataset = createDataset(2000); // 4 batches of 500
    let batchQueries = 0;

    mockFindMany.mockImplementation(async (args: FindManyArgs) => {
      if (isProbeQuery(args)) return sliceDataset(dataset, args);
      batchQueries++;
      return sliceDataset(dataset, args);
    });

    const router = createExportsRouter();
    const csvHandler = extractRouteHandler(router, "/transfers.csv");

    const req = Object.assign(new EventEmitter(), {
      query: { maxRows: "2000" },
    }) as unknown as Request;
    const slowRes = new SlowMockResponse(128);
    slowRes.block();

    const errors: unknown[] = [];
    const handlerPromise = Promise.resolve(
      csvHandler(req, slowRes as unknown as Response, (err?: unknown) => {
        if (err) errors.push(err);
      }),
    );

    // Wait long enough that an unthrottled loop would have drained all 4 DB batches.
    await waitTicks(20);
    await new Promise((r) => setTimeout(r, 40));

    // Backpressure must have halted the loop inside batch 1 before requesting batch 2.
    expect(batchQueries).toBe(1);

    // Release consumer: loop resumes on drain and streams every remaining row cleanly.
    slowRes.release();
    await handlerPromise;
    await finished(slowRes).catch(() => {});

    expect(errors).toHaveLength(0);
    expect(batchQueries).toBe(4);
    expect(slowRes.headers.get("content-type")).toBe("text/csv");

    const lines = slowRes.bodyText().trim().split(/\r?\n/);
    expect(lines[0]).toBe(
      "id,contractId,eventType,fromAddress,toAddress,amount,displayAmount,ledger,ledgerClosedAt,txHash,eventId,isSac,createdAt",
    );
    expect(lines).toHaveLength(2001); // header + 2000 rows
    expect(lines[1]).toContain(`1,${CONTRACT},transfer,${ALICE},${BOB},1001,1001,5001,`);
    expect(lines[2000]).toContain(`2000,${CONTRACT},transfer,${ALICE},${BOB},3000,3000,7000,`);
  });

  it("CSV: unblocks promptly without leaking or querying more rows if client aborts while waiting for drain", async () => {
    const dataset = createDataset(2000);
    let batchQueries = 0;

    mockFindMany.mockImplementation(async (args: FindManyArgs) => {
      if (isProbeQuery(args)) return sliceDataset(dataset, args);
      batchQueries++;
      return sliceDataset(dataset, args);
    });

    const router = createExportsRouter();
    const csvHandler = extractRouteHandler(router, "/transfers.csv");

    const req = Object.assign(new EventEmitter(), {
      query: { maxRows: "2000" },
    }) as unknown as Request;
    const slowRes = new SlowMockResponse(128);
    slowRes.block();

    const errors: unknown[] = [];
    const handlerPromise = Promise.resolve(
      csvHandler(req, slowRes as unknown as Response, (err?: unknown) => {
        if (err) errors.push(err);
      }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(batchQueries).toBe(1);

    // Client disconnects while the server is blocked awaiting `drain`.
    slowRes.destroy();

    await handlerPromise;
    expect(batchQueries).toBe(1);
    expect(errors).toHaveLength(0);
  });

  it("Parquet: stops DB queries and deletes the temp file when client disconnects mid-export", async () => {
    const dataset = createDataset(3000); // 6 batches of 500
    let batchQueries = 0;
    let firstBatchEntered!: () => void;
    const firstBatchPromise = new Promise<void>((resolve) => {
      firstBatchEntered = resolve;
    });
    let releaseFirstBatch!: () => void;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });

    mockFindMany.mockImplementation(async (args: FindManyArgs) => {
      if (isProbeQuery(args)) return sliceDataset(dataset, args);
      batchQueries++;
      if (batchQueries === 1) {
        firstBatchEntered();
        await firstBatchGate;
      }
      return sliceDataset(dataset, args);
    });

    const errors: unknown[] = [];
    const { server, port } = await startServer((err) => errors.push(err));

    try {
      const req = http.get(`http://127.0.0.1:${port}/transfers.parquet?maxRows=3000`);
      req.on("error", () => {
        // Expected on client-initiated destroy()
      });

      await firstBatchPromise;
      // Disconnect while batch 1 is in flight and temp file is already open.
      req.destroy();
      await new Promise((r) => setTimeout(r, 30));
      releaseFirstBatch();

      // Allow handler cleanup and unlink to settle.
      await new Promise((r) => setTimeout(r, 120));

      expect(batchQueries).toBe(1);
      expect(trackedOutputs).toHaveLength(1);
      expect(trackedOutputs[0].closed).toBe(true);
      expect(fs.existsSync(trackedOutputs[0].path)).toBe(false);
      expect(errors).toHaveLength(0);
    } finally {
      releaseFirstBatch();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("Parquet: closes and removes the temp file if client disconnects while streaming the finished file", async () => {
    const dataset = createDataset(600); // 2 batches so output file is non-trivial
    mockFindMany.mockImplementation(async (args: FindManyArgs) => sliceDataset(dataset, args));

    const errors: unknown[] = [];
    const { server, port } = await startServer((err) => errors.push(err));

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/transfers.parquet?maxRows=600`, (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => {});
        setTimeout(() => reject(new Error("Timed out waiting for Parquet response chunk")), 5000).unref();
      });

      await new Promise((r) => setTimeout(r, 120));

      expect(trackedOutputs).toHaveLength(1);
      expect(trackedOutputs[0].closed).toBe(true);
      expect(fs.existsSync(trackedOutputs[0].path)).toBe(false);
      expect(errors).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("full multi-batch CSV and Parquet exports complete intact with zero temp files left behind", async () => {
    const dataset = createDataset(600); // spans 2 DB batches (500 + 100)
    mockFindMany.mockImplementation(async (args: FindManyArgs) => sliceDataset(dataset, args));

    const errors: unknown[] = [];
    const { server, port } = await startServer((err) => errors.push(err));

    try {
      // 1. Complete CSV export across 2 batches
      const csvBody = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/transfers.csv?maxRows=600`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["x-truncated"]).toBeUndefined();
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        }).on("error", reject);
      });

      const csvLines = csvBody.trim().split(/\r?\n/);
      expect(csvLines).toHaveLength(601);
      expect(csvLines[1]).toContain(`evt-000001`);
      expect(csvLines[600]).toContain(`evt-000600`);

      // 2. Complete Parquet export across 2 batches
      const parquetBuf = await new Promise<Buffer>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/transfers.parquet?maxRows=600`, (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["x-truncated"]).toBeUndefined();
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }).on("error", reject);
      });

      const reader = await parquet.ParquetReader.openBuffer(parquetBuf);
      try {
        const cursor = reader.getCursor();
        let count = 0;
        let first: Record<string, unknown> | null = null;
        let last: Record<string, unknown> | null = null;
        for (let rec = await cursor.next(); rec !== null; rec = await cursor.next()) {
          if (!first) first = rec;
          last = rec;
          count++;
        }
        expect(count).toBe(600);
        expect(first).toMatchObject({ eventId: "evt-000001", amount: "1001" });
        expect(last).toMatchObject({ eventId: "evt-000600", amount: "1600" });
      } finally {
        await reader.close();
      }

      await new Promise((r) => setTimeout(r, 80));
      expect(trackedOutputs).toHaveLength(1);
      expect(trackedOutputs[0].closed).toBe(true);
      expect(fs.existsSync(trackedOutputs[0].path)).toBe(false);
      expect(errors).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
