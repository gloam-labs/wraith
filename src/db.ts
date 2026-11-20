/**
 * Database access facade.
 *
 * This file re-exports all db operations, types, and the singleton Prisma client
 * across extracted domain modules to preserve backward compatibility with all
 * existing route handlers and jobs.
 *
 * Extracted modules:
 * - db/client.ts: Prisma client singleton and pagination/selection helpers
 * - db/types.ts: Shared DB query params, result shapes, and row types
 * - db/ledgers.ts: Ingestion checkpoints and backfill cursor management
 * - db/transfers.ts: Token transfers, balance aggregation, and summary queries
 * - db/nfts.ts: NFT transfer tracking and metadata management
 * - db/accounts.ts: Account transfer rollups and aggregation
 * - db/assets.ts: Popular asset volume and count queries
 */

export * from "./db/types";
export * from "./db/client";
export * from "./db/ledgers";
export * from "./db/transfers";
export * from "./db/nfts";
export * from "./db/accounts";
export * from "./db/assets";
export { toDisplayAmount } from "./amount";
