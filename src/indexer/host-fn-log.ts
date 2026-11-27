/**
 * InvokeHostFn decoder and log store (#84).
 *
 * Every contract event flowing through the indexer is also recorded as a
 * raw host-function invocation so downstream consumers can interpret events
 * from arbitrary contracts — not just SAC token transfers.
 *
 * Storage layout:
 *   functionName  — topics[0] decoded as a symbol string
 *   args          — topics[1..n] serialised to JSON via scValToNative
 *   result        — value field serialised to JSON via scValToNative
 *   gasUsed       — nullable; populated externally if transaction metadata
 *                   is available (requires a separate getTransaction call)
 *
 * Bytes representation (#442):
 *   Binary values (`Buffer` or any `Uint8Array`, at any nesting depth) are
 *   stored as plain lowercase hex strings (e.g. a 32-byte hash becomes one
 *   64-character hex string), matching `decodeTokenId` in `src/ingester/nft.ts`.
 *   Plain hex keeps `HostFnLog` compact and directly searchable without
 *   wrapper-object overhead; downstream readers interpret fields according to
 *   the emitting contract's ABI (so a schema-less reader cannot distinguish a
 *   hex-encoded byte array from an ordinary hex string). Rows written prior to
 *   this change retain their old shape until pruned after `RETENTION_DAYS`.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { resolveNetwork, type Network } from "../network";
import { prisma } from "../db";
import type { RawEvent } from "../rpc";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HostFnRecord {
  contractId: string;
  functionName: string;
  args: unknown;
  result: unknown;
  gasUsed: bigint | null;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert any value returned by scValToNative to something JSON.stringify can
 * handle:
 * - BigInt values (i64/u64/i128/u128/i256/u256/timepoint/duration) → decimal string
 * - Buffer / Uint8Array (scvBytes, or non-UTF-8 scvString fallback) → lowercase hex string
 * - Unhandled XDR structs/unions returned by scValToNative's default branch → `{ xdr: base64 }`
 * - Date → ISO-8601 string
 * - Arrays and plain objects (scvVec, scvMap, scvError) → recursively converted
 */
export function toJsonSafe(val: unknown): unknown {
  if (typeof val === "bigint") return val.toString();
  if (val instanceof Uint8Array) {
    return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString("hex");
  }
  if (Array.isArray(val)) return val.map(toJsonSafe);
  if (val !== null && typeof val === "object") {
    if (typeof (val as { toXDR?: unknown }).toXDR === "function") {
      return { xdr: (val as { toXDR(format: "base64"): string }).toXDR("base64") };
    }
    if (val instanceof Date) return val.toISOString();
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return val;
}

function scValToSafeJson(scVal: StellarSdk.xdr.ScVal): unknown {
  try {
    return toJsonSafe(StellarSdk.scValToNative(scVal));
  } catch {
    // Fall back to base64 XDR so no data is lost on unknown future ScVal types
    return { xdr: scVal.toXDR("base64") };
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Convert any raw contract event into a HostFnRecord.
 * Returns null if the event cannot be decoded (e.g. empty topic list or a
 * non-symbol first topic).
 */
export function parseHostFnEvent(raw: RawEvent): HostFnRecord | null {
  const { topic, value, contractId, ledger, ledgerClosedAt, txHash, id: eventId } = raw;

  if (!topic || topic.length === 0) return null;

  let functionName: string;
  try {
    if (topic[0].switch() !== StellarSdk.xdr.ScValType.scvSymbol()) return null;
    const native = StellarSdk.scValToNative(topic[0]);
    if (typeof native !== "string") return null;
    functionName = native;
  } catch {
    return null;
  }

  const args   = topic.slice(1).map(scValToSafeJson);
  const result = scValToSafeJson(value);

  return {
    contractId,
    functionName,
    args,
    result,
    gasUsed: null,
    ledger,
    ledgerClosedAt: new Date(ledgerClosedAt),
    txHash,
    eventId,
  };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Idempotently persist a batch of host-fn log records.
 * Conflicts on `eventId` are silently ignored — safe to replay ledger ranges.
 */
export async function upsertHostFnLogs(
  records: HostFnRecord[],
  network?: Network,
): Promise<number> {
  if (records.length === 0) return 0;

  // Stamped explicitly: the column defaults to 'testnet', so omitting it
  // compiles and files mainnet events under testnet.
  const net = resolveNetwork(network);

  const result = await prisma.hostFnLog.createMany({
    data: records.map(r => ({
      network:       net,
      contractId:    r.contractId,
      functionName:  r.functionName,
      args:          r.args as Prisma.InputJsonValue,
      result:        r.result != null ? (r.result as Prisma.InputJsonValue) : Prisma.JsonNull,
      gasUsed:       r.gasUsed,
      ledger:        r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash:        r.txHash,
      eventId:       r.eventId,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

export type HostFnQueryParams = {
  network?: Network;
  contractId: string;
  functionName?: string;
  limit?: number;
  offset?: number;
};

/**
 * Query host-function invocations for a given contract.
 * Results are ordered newest-ledger-first.
 */
export async function queryHostFnLogs(
  params: HostFnQueryParams,
): Promise<{ total: number; logs: HostFnRecord[] }> {
  const { network, contractId, functionName, limit = 50, offset = 0 } = params;
  const cap = Math.min(limit, 200);

  const where = {
    network: resolveNetwork(network),
    contractId,
    ...(functionName ? { functionName } : {}),
  };

  const [total, rows] = await prisma.$transaction([
    prisma.hostFnLog.count({ where }),
    prisma.hostFnLog.findMany({
      where,
      orderBy: [{ ledger: "desc" }, { id: "desc" }],
      take: cap,
      skip: offset,
    }),
  ]);

  return {
    total,
    logs: rows.map(r => ({
      contractId:    r.contractId,
      functionName:  r.functionName,
      args:          r.args,
      result:        r.result,
      gasUsed:       r.gasUsed,
      ledger:        r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash:        r.txHash,
      eventId:       r.eventId,
    })),
  };
}
