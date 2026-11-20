import express, { Request, Response, NextFunction, Application } from "express";
import rateLimit from "express-rate-limit";
import { createCorsMiddleware } from "../middleware/cors";
import { jsonApiMiddleware } from "../middleware/jsonapi";
import { networkMiddleware, requestNetwork } from "../middleware/network";
import { httpRequestsTotal, httpRequestDurationSeconds } from "../metrics";
import { currentNetwork, type Network } from "../network";
import { getLatestLedger } from "../rpc";
import { getLastIndexedLedger } from "../db";
import { isIndexerStopped } from "../indexer";

// ─── RPC Health Check Cache ───────────────────────────────────────────────
// Keyed by network (#163): one cache entry would let a healthy testnet RPC
// mark mainnet requests fresh, or a mainnet outage mark testnet reads stale.
const cachedRpcHealth = new Map<Network, { healthy: boolean; timestamp: number }>();
const RPC_HEALTH_CACHE_TTL_MS = 3000;

export function clearRpcHealthCache(): void {
  cachedRpcHealth.clear();
}

export async function checkRpcHealth(network?: Network): Promise<boolean> {
  const net = network ?? currentNetwork();
  const now = Date.now();
  const cached = cachedRpcHealth.get(net);
  if (cached && now - cached.timestamp < RPC_HEALTH_CACHE_TTL_MS) {
    return cached.healthy;
  }

  try {
    const latest = await getLatestLedger(net);
    const healthy = typeof latest === "number" && latest > 0;
    cachedRpcHealth.set(net, { healthy, timestamp: now });
    return healthy;
  } catch {
    cachedRpcHealth.set(net, { healthy: false, timestamp: now });
    return false;
  }
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
// Skip rate limiting in test environment to avoid 429 errors during tests
export const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "60", 10),
  standardHeaders: true,
  legacyHeaders: false,
  // `veil_rate_limited`, not `rate_limited`: this is our limiter, and a rail
  // client has to tell it apart from the provider's shared limit.
  message: { error: "Too many requests, please try again later.", code: "veil_rate_limited" },
  // /metrics is exempt: a scrape endpoint that starts 429ing goes blind exactly
  // when load is high enough to matter, which is when you need the graphs.
  skip: (req) => process.env.NODE_ENV === "test" || req.path === "/metrics",
});

// ─── HTTP metrics middleware ──────────────────────────────────────────────
/**
 * First in the chain, deliberately: mounted below networkMiddleware and the
 * rate limiter it would never see the requests those two reject, so a 429
 * storm or a flood of invalid ?network= values would be invisible in
 * http_requests_total — exactly the traffic you want a counter for.
 *
 * The route label is the full Express route pattern (e.g. /search, /offramp/rate,
 * /accounts/:address/transfers) resolved from router mount patterns, and never
 * the raw URL: addresses and contract ids must not become label values.
 *
 * `method` is bounded by the set Node's HTTP parser accepts and `status` by
 * the status codes we emit, so every label here has a fixed domain.
 */
export function createMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip /metrics: a scrape endpoint that increments its own counters
    // creates a feedback loop and misrepresents real traffic.
    if (req.path === "/metrics") {
      return next();
    }

    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const routePattern = req.route?.path ?? "unknown";
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const status = String(res.statusCode);

      httpRequestsTotal.inc({ method: req.method, route: routePattern, status });
      httpRequestDurationSeconds.observe({ method: req.method, route: routePattern }, durationSeconds);
    });

    next();
  };
}

// ─── Stale read middleware ──────────────────────────────────────────
/**
 * Attaches X-Data-Stale and X-As-Of-Ledger headers plus `stale` / `as_of_ledger`
 * body parameters when serving DB data during an RPC outage.
 */
export function createStaleReadMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // /metrics is served from in-process counters, so the RPC health probe
    // below would add a network round-trip to every scrape and report nothing.
    if (req.method !== "GET" || req.path === "/healthz" || req.path === "/metrics") {
      return next();
    }

    // The naira rails answer from Linq, not from indexed ledger data, so RPC
    // health says nothing about whether their answer is current. Marking a live
    // exchange rate `stale` because mainnet has no indexer configured is simply
    // untrue — `/ngn/onramp/rate` was returning `{"rate":1437.45,"stale":true}`
    // for a rate fetched seconds earlier.
    //
    // It also collides with a flag these routes already set for a different
    // meaning: `/ngn` marks `stale: true` for "Linq was unreachable, this is
    // our last known record". Letting this middleware write the same key would
    // have the app tell people the payment provider is down while it is
    // answering perfectly well.
    //
    // `/ops` joins them for a simpler reason: it reads failure records, not
    // chain data. RPC health says nothing about whether its answer is current,
    // and stamping `stale: true` onto an operator's incident list during an
    // RPC outage is noise at exactly the wrong moment.
    if (req.path.startsWith("/ngn") || req.path.startsWith("/offramp") || req.path.startsWith("/ops")) {
      return next();
    }

    try {
      const net = requestNetwork(req);
      const indexerStopped =
        typeof isIndexerStopped === "function"
          ? isIndexerStopped(net)
          : false;
      const rpcHealthy = await checkRpcHealth(net);
      if (indexerStopped || !rpcHealthy) {
        const lastIndexed = await getLastIndexedLedger(net).catch(() => null);
        res.setHeader("X-Data-Stale", "true");
        if (indexerStopped) {
          res.setHeader("X-Indexer-Running", "false");
        }
        if (lastIndexed !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexed));
        }

        const originalJson = res.json.bind(res);
        res.json = (body: any) => {
          if (body && typeof body === "object" && !Array.isArray(body) && body.error === undefined) {
            if (body.stale === undefined) {
              body.stale = true;
            }
            if (body.indexer_running === undefined && indexerStopped) {
              body.indexer_running = false;
            }
            if (body.as_of_ledger === undefined && lastIndexed !== null) {
              body.as_of_ledger = lastIndexed;
            }
          }
          return originalJson(body);
        };
      }
    } catch {
      // Fall through cleanly
    }
    next();
  };
}

/**
 * Mount pre-body middleware (HTTP metrics and CORS).
 * Must be mounted at the very top of the stack, before raw-body routes and express.json().
 */
export function setupPreBodyMiddleware(app: Application): void {
  app.use(createMetricsMiddleware());
  app.use(createCorsMiddleware());
}

/**
 * Mount body parsers and core application middleware.
 * Must be mounted after raw-body routes (/webhooks/linq, /discord/interactions).
 */
export function setupBodyAndAppMiddleware(app: Application): void {
  app.use(express.json());
  app.use(jsonApiMiddleware);
  app.use(networkMiddleware);
  app.use(limiter);
  app.use(createStaleReadMiddleware());
}
