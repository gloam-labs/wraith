import { prisma } from "./db";
import { fetchTokenMetadata } from "./rpc";
import { resolveNetwork, type Network } from "./network";
import { tokenMetadataLookupsTotal } from "./metrics";

export interface TokenMetadata {
  network: Network;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * In-memory cache, keyed by `network:contractId`.
 *
 * The network has to be part of the key. A contract id is only unique within a
 * chain, so a testnet token deployed at the same address as a mainnet one would
 * otherwise serve the wrong symbol and — worse — the wrong `decimals`, which
 * silently rescales every amount rendered from it.
 */
const cache = new Map<string, TokenMetadata>();
const inFlightLookups = new Map<string, Promise<TokenMetadata>>();
const recentFailures = new Map<string, { failures: number; retryAt: number }>();
const INITIAL_FAILURE_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_FAILURE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function cacheKey(network: Network, contractId: string): string {
  return `${network}:${contractId}`;
}

function hasValidDecimals(metadata: { decimals: number }): boolean {
  return Number.isInteger(metadata.decimals) && metadata.decimals >= 0 && metadata.decimals <= 38;
}

/**
 * Populate the in-memory cache from the database on startup.
 *
 * Loads only the given network's rows: a loop indexing one chain has no use for
 * the other's tokens, and keeping them apart is the point of the composite key.
 */
export async function initTokenCache(network?: Network): Promise<void> {
  const net = resolveNetwork(network);
  try {
    const tokens = await prisma.tokenMetadata.findMany({ where: { network: net } });
    for (const token of tokens) {
      if (hasValidDecimals(token)) {
        cache.set(cacheKey(net, token.contractId), token as TokenMetadata);
      }
    }
    console.log(`[cache/${net}] Initialized with ${tokens.length} tokens from DB`);
  } catch (err) {
    console.error(
      `[cache/${net}] Failed to initialize token cache from DB:`,
      (err as Error).message,
    );
    // Continue anyway; it will fill from RPC as needed.
  }
}

/**
 * Get token metadata for a contract on a network.
 * Checks memory → then the database → then Soroban RPC.
 */
export function getTokenMetadata(
  contractId: string,
  network?: Network,
): Promise<TokenMetadata> {
  const net = resolveNetwork(network);
  const key = cacheKey(net, contractId);

  // 1. In-memory cache.
  const cached = cache.get(key);
  if (cached) {
    tokenMetadataLookupsTotal.inc({ outcome: "hit" });
    return Promise.resolve(cached);
  }

  const inFlight = inFlightLookups.get(key);
  if (inFlight) return inFlight;

  const failure = recentFailures.get(key);
  if (failure && Date.now() < failure.retryAt) {
    tokenMetadataLookupsTotal.inc({ outcome: "skipped_recent_failure" });
    return Promise.reject(new Error("Token metadata lookup temporarily suppressed"));
  }

  const lookup = (async (): Promise<TokenMetadata> => {
    let rpcLookupFailed = false;
    try {
      // Another process, or an earlier run, may already have populated the DB.
      const dbToken = await prisma.tokenMetadata.findUnique({
        where: { network_contractId: { network: net, contractId } },
      });
      if (dbToken && hasValidDecimals(dbToken)) {
        const token = dbToken as TokenMetadata;
        cache.set(key, token);
        recentFailures.delete(key);
        tokenMetadataLookupsTotal.inc({ outcome: "hit" });
        return token;
      }

      // Ask this network's endpoint rather than the process default.
      let metadata: Awaited<ReturnType<typeof fetchTokenMetadata>>;
      try {
        metadata = await fetchTokenMetadata(contractId, net);
        if (!hasValidDecimals(metadata)) {
          throw new Error("Token metadata contains invalid decimals");
        }
      } catch (error) {
        rpcLookupFailed = true;
        throw error;
      }
      const token: TokenMetadata = { network: net, contractId, ...metadata };

      recentFailures.delete(key);
      await prisma.tokenMetadata.upsert({
        where: { network_contractId: { network: net, contractId } },
        create: token,
        update: token,
      });

      cache.set(key, token);
      tokenMetadataLookupsTotal.inc({ outcome: "miss" });
      return token;
    } catch (error) {
      tokenMetadataLookupsTotal.inc({ outcome: "failed" });
      if (rpcLookupFailed) {
        const failures = (recentFailures.get(key)?.failures ?? 0) + 1;
        const cooldown = Math.min(
          INITIAL_FAILURE_COOLDOWN_MS * 2 ** (failures - 1),
          MAX_FAILURE_COOLDOWN_MS,
        );
        recentFailures.set(key, { failures, retryAt: Date.now() + cooldown });
      }
      throw error;
    }
  })();

  const sharedLookup = lookup.finally(() => {
    if (inFlightLookups.get(key) === sharedLookup) {
      inFlightLookups.delete(key);
    }
  });
  inFlightLookups.set(key, sharedLookup);
  return sharedLookup;
}

/**
 * Return all tokens currently held in the in-memory cache, optionally narrowed
 * to one network.
 */
export function getAllCachedTokens(network?: Network): TokenMetadata[] {
  const all = Array.from(cache.values());
  return network ? all.filter((t) => t.network === network) : all;
}

/** Read cached decimals without triggering a database or RPC lookup. */
export function getCachedTokenDecimals(
  contractId: string,
  network?: Network,
): number | undefined {
  const net = resolveNetwork(network);
  return cache.get(cacheKey(net, contractId))?.decimals;
}

/** Test-only: drop the in-memory cache. */
export function _resetTokenCache(): void {
  cache.clear();
  inFlightLookups.clear();
  recentFailures.clear();
}