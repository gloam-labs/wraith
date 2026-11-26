import { PrismaClient, Prisma } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { recordDbRead, recordDbFallback } from "../metrics";

/**
 * Default allowlist of Prisma models whose reads are permitted to route to read replicas.
 * Big, indexed, event tables where slight eventual consistency is acceptable:
 * - TokenTransfer (token transfer events)
 * - NftTransfer (NFT transfer events)
 * - HostFnLog (contract invocation logs)
 * - LpShareTransfer (liquidity pool share events)
 * - AccountSummary (aggregated account metrics)
 *
 * All other models (orders, indexer state cursors, token/NFT metadata, webhooks, Discord auth)
 * have strict read-after-write consistency requirements and always route to the primary.
 */
export const DEFAULT_REPLICA_MODELS: ReadonlySet<string> = new Set([
  "TokenTransfer",
  "NftTransfer",
  "HostFnLog",
  "LpShareTransfer",
  "AccountSummary",
  "tokenTransfer",
  "nftTransfer",
  "hostFnLog",
  "lpShareTransfer",
  "accountSummary",
]);

export const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

export const primaryContext = new AsyncLocalStorage<boolean>();

/**
 * Execute an async operation forcing all database reads within its scope to use the primary database.
 */
export function withPrimary<T>(fn: () => Promise<T>): Promise<T>;
export function withPrimary<T>(client: PrismaClient, fn: (client: PrismaClient) => Promise<T>): Promise<T>;
export function withPrimary<T>(
  clientOrFn: PrismaClient | (() => Promise<T>),
  maybeFn?: (client: PrismaClient) => Promise<T>
): Promise<T> {
  if (typeof clientOrFn === "function") {
    return primaryContext.run(true, clientOrFn);
  }
  const client = clientOrFn;
  const fn = maybeFn!;
  const primaryClient = (client as any).$primary ?? client;
  return primaryContext.run(true, () => fn(primaryClient));
}

/**
 * Determine if an error is a database connection / infrastructure error (rather than a query syntax,
 * validation, constraint, or argument error).
 */
export function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const err = error as Record<string, any>;

  // Check instance types if available
  if (
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError
  ) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientValidationError) {
    return false;
  }

  // Also check by name (covers mocks or separate Prisma instances)
  if (
    err.name === "PrismaClientInitializationError" ||
    err.name === "PrismaClientRustPanicError"
  ) {
    return true;
  }
  if (err.name === "PrismaClientValidationError") {
    return false;
  }

  // Check Prisma error codes:
  // P1xxx are database connection errors (P1000, P1001, P1002, P1003, P1008, P1011, P1017)
  // P2024 is timed out fetching connection from pool
  if (typeof err.code === "string") {
    if (err.code.startsWith("P1") || err.code === "P2024") {
      return true;
    }
    if (err.code.startsWith("P2")) {
      return false;
    }
  }

  // Node network/socket error codes
  const nodeCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  if (typeof err.code === "string" && nodeCodes.has(err.code)) {
    return true;
  }

  // Error message inspection for connection/timeout issues
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (
    message.includes("connection") ||
    message.includes("connect") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("closed the connection") ||
    message.includes("can't reach database") ||
    message.includes("network error")
  ) {
    return true;
  }

  return false;
}

function getModelDelegate(client: any, model: string): any {
  if (!client || !model) return undefined;
  if (client[model]) return client[model];
  const camelCase = model.charAt(0).toLowerCase() + model.slice(1);
  if (client[camelCase]) return client[camelCase];
  const pascalCase = model.charAt(0).toUpperCase() + model.slice(1);
  if (client[pascalCase]) return client[pascalCase];
  return undefined;
}

export interface RouterOptions {
  replicaUrls: string[];
  healthCheckIntervalMs?: number;
  allowlist?: string[] | Set<string>;
  onRead?: (target: "primary" | "replica") => void;
  onFallback?: () => void;
}

interface ReplicaEntry {
  client: PrismaClient;
  healthy: boolean;
}

const activeRouters = new Set<() => Promise<void>>();

/**
 * Disconnect replica clients and clean up background intervals.
 */
export async function disconnectReplicas(client?: any): Promise<void> {
  if (client && typeof client.$disconnectReplicas === "function") {
    await client.$disconnectReplicas();
    return;
  }
  for (const cleanup of Array.from(activeRouters)) {
    await cleanup();
  }
}

export type RoutedPrismaClient = PrismaClient & {
  $primary: PrismaClient;
  $disconnectReplicas: () => Promise<void>;
  $withPrimary: <T>(fn: (client: PrismaClient) => Promise<T>) => Promise<T>;
};

export function withReadReplicas(primary: PrismaClient, options: RouterOptions): RoutedPrismaClient {
  (primary as any).$primary = primary;

  if (options.replicaUrls.length === 0) {
    return primary as RoutedPrismaClient;
  }

  const allowlist: ReadonlySet<string> = options.allowlist
    ? new Set(
        Array.from(options.allowlist).flatMap((m) => [
          m,
          m.charAt(0).toLowerCase() + m.slice(1),
          m.charAt(0).toUpperCase() + m.slice(1),
        ])
      )
    : DEFAULT_REPLICA_MODELS;

  const handleReadMetric = options.onRead ?? recordDbRead;
  const handleFallbackMetric = options.onFallback ?? recordDbFallback;

  const replicas: ReplicaEntry[] = options.replicaUrls.map((url) => ({
    client: new PrismaClient({ datasourceUrl: url }),
    healthy: true,
  }));

  let currentIndex = 0;

  function getReplica(): ReplicaEntry | null {
    const healthyReplicas = replicas.filter((r) => r.healthy);
    if (healthyReplicas.length === 0) {
      return null;
    }
    const entry = healthyReplicas[currentIndex % healthyReplicas.length];
    currentIndex = (currentIndex + 1) % healthyReplicas.length;
    return entry;
  }

  // Health check loop
  const interval = setInterval(async () => {
    for (const replica of replicas) {
      try {
        await replica.client.$queryRaw`SELECT 1`;
        replica.healthy = true;
      } catch (err) {
        replica.healthy = false;
        console.warn(`[Router] Replica health check failed, marking unhealthy.`);
      }
    }
  }, options.healthCheckIntervalMs ?? 10000);

  // Allow process to exit without waiting for interval
  if (interval.unref) {
    interval.unref();
  }

  const cleanup = async () => {
    if (interval) {
      clearInterval(interval);
    }
    await Promise.all(replicas.map((r) => r.client.$disconnect()));
    activeRouters.delete(cleanup);
  };
  activeRouters.add(cleanup);

  // Intercept reads and route them
  // Note: Raw queries ($queryRaw, $executeRaw) are top-level client methods that bypass
  // $allModels and always execute safely on the primary database.
  const extension = primary.$extends({
    client: {
      async $disconnect() {
        await cleanup();
        return primary.$disconnect();
      },
      async $disconnectReplicas() {
        await cleanup();
      },
      async $withPrimary<T>(this: any, fn: (client: PrismaClient) => Promise<T>): Promise<T> {
        return withPrimary(this, fn);
      },
    },
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const isRead = READ_OPERATIONS.has(operation);

          if (!isRead) {
            // All write operations always route to primary
            return query(args);
          }

          // Check for callers forcing primary:
          // 1. Through withPrimary / primaryContext
          // 2. Through args.forcePrimary
          const forcePrimary = Boolean(
            primaryContext.getStore() || (args && (args as any).forcePrimary)
          );
          if (args && (args as any).forcePrimary !== undefined) {
            delete (args as any).forcePrimary;
          }

          if (forcePrimary) {
            handleReadMetric("primary");
            return query(args);
          }

          // Transaction check: queries inside transactions always use primary
          const context = Prisma.getExtensionContext(this);
          const isTransaction = !("$transaction" in context);
          if (isTransaction) {
            handleReadMetric("primary");
            return query(args);
          }

          // Allowlist check: only allowlisted models may route to replicas
          if (!model || !allowlist.has(model)) {
            handleReadMetric("primary");
            return query(args);
          }

          // Model is allowlisted and read can go to replica if one is healthy
          const replicaEntry = getReplica();
          if (!replicaEntry) {
            // No healthy replica available: use primary
            handleReadMetric("primary");
            return query(args);
          }

          try {
            const delegate = getModelDelegate(replicaEntry.client, model);
            if (!delegate || typeof delegate[operation] !== "function") {
              handleReadMetric("primary");
              return query(args);
            }
            const result = await delegate[operation](args);
            handleReadMetric("replica");
            return result;
          } catch (error) {
            if (isConnectionError(error)) {
              // Immediately mark the failing replica unhealthy so subsequent reads skip it
              replicaEntry.healthy = false;
              console.warn("[Router] Replica query failed with connection error, marking unhealthy.");
              handleFallbackMetric();
              handleReadMetric("primary");
              return query(args);
            }
            // For errors that are the query's own fault (bad args, validation, etc.),
            // do not mark replica unhealthy and do not fall back to primary.
            throw error;
          }
        },
      },
    },
  });

  Object.defineProperty(extension, "$primary", {
    get: () => primary,
    configurable: true,
    enumerable: false,
  });

  return extension as unknown as RoutedPrismaClient;
}
