import express, { Request, Response, NextFunction, Application, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { createCorsMiddleware } from "../middleware/cors";
import { jsonApiMiddleware } from "../middleware/jsonapi";
import { networkMiddleware, requestNetwork } from "../middleware/network";
import { httpRequestsTotal, httpRequestDurationSeconds } from "../metrics";
import { currentNetwork, type Network } from "../network";
import { getLatestLedger } from "../rpc";
import { getLastIndexedLedger } from "../db";
import { isIndexerStopped } from "../indexer";
import { getRoutePattern } from "../routePatterns";

// ─── RPC Health Check Cache ───────────────────────────────────────────────
// Keyed by network (#163): one cache entry would let a healthy testnet RPC
// mark mainnet requests fresh, or a mainnet outage mark testnet reads stale.
const cachedRpcHealth = new Map<Network, { healthy: boolean; timestamp: number }>();
const RPC_HEALTH_CACHE_TTL_MS = 3000;

// One probe per network at a time. The cache above only covers an answer that
// has already arrived: when it expires under load, every request that arrives
// before the next answer comes back used to make its own RPC call (#459). A
// burst of concurrent reads now shares the probe that is already in flight, and
// the answer — healthy or not — is cached when it lands.
const inFlightRpcHealth = new Map<Network, Promise<boolean>>();

export function clearRpcHealthCache(): void {
  cachedRpcHealth.clear();
  inFlightRpcHealth.clear();
}

async function probeRpcHealth(net: Network): Promise<boolean> {
  try {
    const latest = await getLatestLedger(net);
    const healthy = typeof latest === "number" && latest > 0;
    cachedRpcHealth.set(net, { healthy, timestamp: Date.now() });
    return healthy;
  } catch {
    // A failure is cached for the same three seconds as a success: an RPC that
    // is down should not be re-probed on every request either.
    cachedRpcHealth.set(net, { healthy: false, timestamp: Date.now() });
    return false;
  }
}

export async function checkRpcHealth(network?: Network): Promise<boolean> {
  const net = network ?? currentNetwork();
  const now = Date.now();
  const cached = cachedRpcHealth.get(net);
  if (cached && now - cached.timestamp < RPC_HEALTH_CACHE_TTL_MS) {
    return cached.healthy;
  }

  const inFlight = inFlightRpcHealth.get(net);
  if (inFlight) {
    return inFlight;
  }

  const probe = probeRpcHealth(net);
  inFlightRpcHealth.set(net, probe);
  void probe.finally(() => {
    if (inFlightRpcHealth.get(net) === probe) {
      inFlightRpcHealth.delete(net);
    }
  });
  return probe;
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
 * We record each router's mount pattern when mounted and index the full pattern
 * per Route object at startup. We never read `req.baseUrl`, `req.originalUrl` or
 * `req.path`, avoiding unbounded label cardinality and memory leaks in prom-client.
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
      const routePattern = getRoutePattern(req.route);
      const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
      const status = String(res.statusCode);

      httpRequestsTotal.inc({ method: req.method, route: routePattern, status });
      httpRequestDurationSeconds.observe({ method: req.method, route: routePattern }, durationSeconds);
    });

    next();
  };
}

// ─── Stale read middleware ──────────────────────────────────────────
// Attaches X-Data-Stale and X-As-Of-Ledger headers plus `stale` / `as_of_ledger`
// body parameters when serving indexed ledger data during an RPC outage.
//
// It works from the list below, not from a list of exceptions. RPC health says
// nothing about an answer that was never read from the chain: `/fees` is
// computed from environment variables, the webhook and Discord routes read
// their own records. Exclusion meant each of those waited on an RPC probe
// before its handler ran — on `/fees`, in the middle of a payment — and was
// then told its correct answer was stale whenever the RPC was down or the
// network had no indexer. The same mistake once made `/ngn/onramp/rate`
// return `{"rate":1437.45,"stale":true}` for a rate fetched seconds earlier;
// `/ngn` also uses `stale: true` to mean "Linq was unreachable", which this
// middleware must never have said for it.
//
// So a route is stale-marked only if it is on the list. A new router is
// untouched unless it is added here on purpose.
const INDEXED_DATA_PATHS = [
  "/status",
  "/readyz",
  "/transfers",
  "/summary",
  "/accounts",
  "/assets",
  "/search",
  "/nfts",
  "/host-fn",
  "/tokens",
  "/graphql",
  // The export router is mounted at "/", so its downloads are not under the
  // /transfers prefix and need naming individually.
  "/transfers.csv",
  "/transfers.parquet",
];

/** Segment-aware: `/summaries` is not `/summary`. */
const servesIndexedData = (path: string): boolean =>
  INDEXED_DATA_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

export function createStaleReadMiddleware() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" || !servesIndexedData(req.path)) {
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
 * Mount pre-body middleware (HTTP metrics and per-surface CORS).
 * Must be mounted at the very top of the stack, before raw-body routes and express.json().
 */
export function setupPreBodyMiddleware(app: Application): void {
  app.use(createMetricsMiddleware());

  // ─── CORS, per surface ─────────────────────────────────────────────────────
  // One `cors()` for the whole app answered every request with
  // `Access-Control-Allow-Origin: *`. That is right for the public read API
  // and was never a decision for the routes that create orders. Each surface
  // now has its own policy, and `src/middleware/cors.ts` is where that table
  // lives — it says which surfaces are deliberately open and why, and it
  // reads the allow-list from `CORS_ALLOWED_ORIGINS`, so a new client is an
  // environment change rather than a change to this file.
  //
  // Below the metrics middleware on purpose: a request refused for its origin
  // is a request we answered, and it should be counted like any other. Above
  // every router, so no surface is left uncovered, and above `express.json()`,
  // so a refused request never has its body parsed.
  app.use(createCorsMiddleware());
}

/**
 * Mount body parsers and core application middleware.
 * Must be mounted after raw-body routes (/webhooks/linq, /discord/interactions).
 * Returns the `express.json()` middleware instance so callers can verify
 * stack ordering by handler reference rather than Express internal layer names.
 */
export function setupBodyAndAppMiddleware(app: Application): RequestHandler {
  const jsonParser = express.json();
  app.use(jsonParser);
  app.use(jsonApiMiddleware);
  // Before every router: each request carries exactly one network, resolved and
  // validated once here rather than re-parsed per handler (#163).
  app.use(networkMiddleware);
  app.use(limiter);
  app.use(createStaleReadMiddleware());
  return jsonParser;
}
