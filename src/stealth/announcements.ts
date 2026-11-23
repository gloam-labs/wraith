/**
 * Stealth announcement decoder, store, and query engine (#1320).
 *
 * Emitted by stealth-announcer contracts using:
 *   topics = [Symbol("announce"), BytesN<1>(view_tag)]
 *   data   = (ANNOUNCEMENT_VERSION, BytesN<32>(ephemeral_public_key), Bytes(sealed_note))
 *
 * Receivers can filter announcements by a 1-byte view tag without revealing
 * their public keys, meta-addresses, or candidate payment addresses to the indexer.
 */

import * as StellarSdk from "@stellar/stellar-sdk";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { resolveNetwork, type Network } from "../network";
import type { RawEvent } from "../rpc";
import { decodeCursor, encodeCursor } from "../lib/odata";

export const STEALTH_ANNOUNCEMENT_VERSION = 1;
export const ANNOUNCEMENT_TOPIC_SYMBOL = "announce";

export interface StealthAnnouncementRecord {
  id?: number;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
  version: number;
  viewTag: number;
  ephemeralPublicKey: string; // 64 hex characters (32 bytes)
  sealedNote: string;         // hex string
}

export interface AnnouncementQueryParams {
  network?: Network;
  fromLedger: number;
  toLedger?: number;
  viewTag?: number;
  limit?: number;
  cursor?: string;
}

export interface AnnouncementPage {
  announcements: StealthAnnouncementRecord[];
  fromLedger: number;
  toLedger?: number;
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Check if a raw contract event is a stealth payment announcement.
 */
export function isAnnouncementEvent(raw: RawEvent): boolean {
  if (!raw.topic || raw.topic.length !== 2) return false;
  try {
    const sym = StellarSdk.scValToNative(raw.topic[0]);
    if (typeof sym !== "string" || sym.toLowerCase() !== ANNOUNCEMENT_TOPIC_SYMBOL) {
      return false;
    }
    const tag = StellarSdk.scValToNative(raw.topic[1]);
    if (tag instanceof Uint8Array && tag.length === 1) return true;
    if (typeof tag === "number" && Number.isInteger(tag) && tag >= 0 && tag <= 255) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse a raw RPC event into a typed StealthAnnouncementRecord.
 * Returns null if the event is not an announcement or is malformed.
 */
export function parseAnnouncementEvent(raw: RawEvent): StealthAnnouncementRecord | null {
  if (!isAnnouncementEvent(raw)) return null;

  try {
    const rawTag = StellarSdk.scValToNative(raw.topic[1]);
    const viewTag = rawTag instanceof Uint8Array ? rawTag[0] : Number(rawTag);
    if (!Number.isInteger(viewTag) || viewTag < 0 || viewTag > 255) return null;

    const nativeValue = StellarSdk.scValToNative(raw.value);
    if (!Array.isArray(nativeValue) || nativeValue.length < 3) return null;

    const [versionRaw, ephemRaw, noteRaw] = nativeValue;
    const version = Number(versionRaw);
    if (!Number.isInteger(version) || version < 1) return null;

    let ephemeralPublicKey: string | null = null;
    if (ephemRaw instanceof Uint8Array) {
      ephemeralPublicKey = Buffer.from(ephemRaw).toString("hex").toLowerCase();
    } else if (typeof ephemRaw === "string" && /^[0-9a-fA-F]{64}$/.test(ephemRaw)) {
      ephemeralPublicKey = ephemRaw.toLowerCase();
    }
    if (!ephemeralPublicKey || ephemeralPublicKey.length !== 64) return null;

    let sealedNote = "";
    if (noteRaw instanceof Uint8Array) {
      sealedNote = Buffer.from(noteRaw).toString("hex").toLowerCase();
    } else if (typeof noteRaw === "string") {
      sealedNote = noteRaw.toLowerCase();
    }

    return {
      contractId: raw.contractId,
      ledger: raw.ledger,
      ledgerClosedAt: new Date(raw.ledgerClosedAt),
      txHash: raw.txHash,
      eventId: raw.id,
      version,
      viewTag,
      ephemeralPublicKey,
      sealedNote,
    };
  } catch {
    return null;
  }
}

/**
 * Filter and parse a list of raw events into announcement records.
 */
export function parseAnnouncementEvents(events: RawEvent[]): StealthAnnouncementRecord[] {
  const records: StealthAnnouncementRecord[] = [];
  for (const event of events) {
    const parsed = parseAnnouncementEvent(event);
    if (parsed) records.push(parsed);
  }
  return records;
}

/**
 * Idempotently persist a batch of stealth announcement records.
 * Conflicts on (network, eventId) are silently ignored so retries/replays are safe.
 */
export async function upsertAnnouncements(
  records: StealthAnnouncementRecord[],
  network?: Network,
): Promise<number> {
  if (records.length === 0) return 0;
  const net = resolveNetwork(network);

  const result = await prisma.stealthAnnouncement.createMany({
    data: records.map((r) => ({
      network: net,
      contractId: r.contractId,
      ledger: r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash: r.txHash,
      eventId: r.eventId,
      version: r.version,
      viewTag: r.viewTag,
      ephemeralPublicKey: r.ephemeralPublicKey,
      sealedNote: r.sealedNote,
    })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Query announcements by ledger range and optional view tag.
 * Results are sorted strictly by ascending ledger and id for scanning progress.
 */
export async function queryAnnouncements(
  params: AnnouncementQueryParams,
): Promise<AnnouncementPage> {
  const net = resolveNetwork(params.network);
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  const where: Prisma.StealthAnnouncementWhereInput = {
    network: net,
    ledger: {
      gte: params.fromLedger,
      ...(params.toLedger !== undefined ? { lte: params.toLedger } : {}),
    },
  };

  if (params.viewTag !== undefined) {
    where.viewTag = params.viewTag;
  }

  if (params.cursor) {
    const cursorId = decodeCursor(params.cursor);
    where.id = { gt: cursorId };
  }

  const rows = await prisma.stealthAnnouncement.findMany({
    where,
    orderBy: [{ ledger: "asc" }, { id: "asc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeCursor(pageRows[pageRows.length - 1].id)
      : null;

  return {
    announcements: pageRows.map((r) => ({
      id: r.id,
      contractId: r.contractId,
      ledger: r.ledger,
      ledgerClosedAt: r.ledgerClosedAt,
      txHash: r.txHash,
      eventId: r.eventId,
      version: r.version,
      viewTag: r.viewTag,
      ephemeralPublicKey: r.ephemeralPublicKey,
      sealedNote: r.sealedNote,
    })),
    fromLedger: params.fromLedger,
    ...(params.toLedger !== undefined ? { toLedger: params.toLedger } : {}),
    limit,
    nextCursor,
    hasMore,
  };
}
