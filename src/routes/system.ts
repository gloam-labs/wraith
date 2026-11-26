import { Router, Request, Response, NextFunction } from "express";
import { renderMetrics, metricsContentType } from "../metrics";
import { getAllCachedTokens } from "../tokenCache";
import { parseOr400 } from "../openapi/validation";
import { readyzQuerySchema } from "../openapi/schemas";
import { requestNetwork } from "../middleware/network";
import { enabledNetworks, type Network } from "../network";
import { prisma, getLastIndexedLedger } from "../db";
import { getLatestLedger } from "../rpc";
import {
  getIndexerStats,
  getAllIndexerStats,
  runningNetworks,
  isIndexerRunning,
  getIndexerUnstartedReason,
} from "../indexer";
import { getDependencyStatus, dependencyStatusBoundMs } from "../dependencies";
import { cacheStatus } from "../cache/redis";

/**
 * System router for health, status, metrics, and readiness probes.
 *
 * Endpoints:
 *   GET /healthz  — K8s/Render liveness probe
 *   GET /metrics  — Prometheus scrape endpoint
 *   GET /tokens   — List of cached tokens
 *   GET /readyz   — K8s/Render readiness probe
 *   GET /status   — Detailed indexer status and health
 */
export function createSystemRouter(): Router {
  const router = Router();

  // ─── GET /healthz — K8s/Render liveness probe ───────────────────────────
  router.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // ─── GET /metrics — Prometheus scrape endpoint ──────────────────────────
  router.get("/metrics", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const body = await renderMetrics();
      res.setHeader("Content-Type", metricsContentType);
      res.send(body);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /tokens ─────────────────────────────────────────────────────────────
  router.get("/tokens", (req: Request, res: Response) => {
    const network = requestNetwork(req);
    const tokens = getAllCachedTokens(network);
    res.json({ ok: true, network, tokens });
  });

  // ─── GET /readyz — K8s/Render readiness probe ───────────────────────────
  router.get("/readyz", async (_req: Request, res: Response) => {
    const parsed = parseOr400(readyzQuerySchema, _req.query, res);
    if (!parsed) return;
    const { maxLag } = parsed;
    const selected = requestNetwork(_req);

    let dbUp: boolean;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbUp = true;
    } catch {
      dbUp = false;
    }

    const checkNetwork = async (net: Network) => {
      let latest: number | null = null;
      let rpc = false;
      try {
        latest = await getLatestLedger(net);
        rpc = typeof latest === "number" && latest > 0;
      } catch {
        rpc = false;
      }

      let lastIndexed: number | null = null;
      let indexerCaughtUp = false;
      try {
        lastIndexed = await getLastIndexedLedger(net);
        const lag = lastIndexed !== null && latest !== null ? latest - lastIndexed : Infinity;
        indexerCaughtUp = lag <= maxLag;
      } catch {
        indexerCaughtUp = false;
      }

      return {
        checks: { db: dbUp, rpc, indexerCaughtUp },
        lastIndexedLedger: lastIndexed,
        latestLedger: latest,
        lagLedgers: latest !== null && lastIndexed !== null ? latest - lastIndexed : null,
      };
    };

    const networks = enabledNetworks();
    const results = await Promise.all(networks.map(async (net) => [net, await checkNetwork(net)] as const));
    const byNetwork = Object.fromEntries(results);

    const selectedResult = byNetwork[selected] ?? (await checkNetwork(selected));
    const checks = selectedResult.checks;
    const lastIndexed = selectedResult.lastIndexedLedger;
    const allHealthy = Object.values(checks).every(Boolean);

    if (!checks.db) {
      res.status(503).json({ ok: false, status: "down", network: selected, checks, networks: byNetwork });
    } else {
      const status = allHealthy ? "healthy" : "degraded";
      if (!allHealthy) {
        res.setHeader("X-Data-Stale", "true");
        if (lastIndexed !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexed));
        }
      }
      res.json({
        ok: true,
        status,
        network: selected,
        checks,
        networks: byNetwork,
        ...(lastIndexed !== null ? { as_of_ledger: lastIndexed } : {}),
        ...(allHealthy ? {} : { stale: true }),
      });
    }
  });

  // ─── GET /status ─────────────────────────────────────────────────────────
  router.get("/status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const selected = requestNetwork(req);
      const [lastIndexedResult, latestLedgerResult] = await Promise.allSettled([
        getLastIndexedLedger(selected),
        getLatestLedger(selected),
      ]);

      if (lastIndexedResult.status === "rejected") {
        res.status(503).json({ ok: false, status: "down", error: "Database unavailable" });
        return;
      }

      const lastIndexedLedger = lastIndexedResult.value;
      const rpcSuccess = latestLedgerResult.status === "fulfilled" && typeof latestLedgerResult.value === "number";
      const latestLedger = rpcSuccess ? latestLedgerResult.value : null;
      const stats = getIndexerStats(selected);
      const dependencies = getDependencyStatus();

      const networks = enabledNetworks();
      const loopStats = getAllIndexerStats();
      const perNetwork = await Promise.all(
        networks.map(async (net) => {
          const [indexed, tip] = await Promise.allSettled([
            getLastIndexedLedger(net),
            getLatestLedger(net),
          ]);
          const indexedLedger = indexed.status === "fulfilled" ? indexed.value : null;
          const tipLedger =
            tip.status === "fulfilled" && typeof tip.value === "number" ? tip.value : null;
          const isRunning =
            typeof isIndexerRunning === "function"
              ? isIndexerRunning(net)
              : (loopStats[net] !== undefined || runningNetworks().includes(net));
          const unstartedReason =
            !isRunning && typeof getIndexerUnstartedReason === "function"
              ? getIndexerUnstartedReason(net)
              : undefined;
          return [
            net,
            {
              lastIndexedLedger: indexedLedger,
              latestLedger: tipLedger,
              lagLedgers:
                tipLedger !== null ? tipLedger - (indexedLedger ?? tipLedger) : null,
              running: isRunning,
              ...(unstartedReason ? { reason: unstartedReason } : {}),
              ...(loopStats[net] ?? {}),
            },
          ] as const;
        })
      );
      const byNetwork = Object.fromEntries(perNetwork);

      if (rpcSuccess && latestLedger !== null && dependencies.railsUsable) {
        res.json({
          ok: true,
          status: "healthy",
          network: selected,
          lastIndexedLedger,
          last_indexed_ledger: lastIndexedLedger,
          latestLedger,
          lagLedgers: latestLedger - (lastIndexedLedger ?? latestLedger),
          ...stats,
          networks: byNetwork,
          dependencies,
          dependency_status_bound_ms: dependencyStatusBoundMs,
          cache: cacheStatus(),
        });
      } else {
        res.setHeader("X-Data-Stale", "true");
        if (lastIndexedLedger !== null) {
          res.setHeader("X-As-Of-Ledger", String(lastIndexedLedger));
        }
        res.json({
          ok: true,
          status: "degraded",
          network: selected,
          stale: true,
          as_of_ledger: lastIndexedLedger ?? undefined,
          lastIndexedLedger,
          last_indexed_ledger: lastIndexedLedger,
          latestLedger: rpcSuccess ? latestLedger : null,
          lagLedgers: rpcSuccess && latestLedger !== null ? latestLedger - (lastIndexedLedger ?? latestLedger) : null,
          ...stats,
          networks: byNetwork,
          dependencies,
          dependency_status_bound_ms: dependencyStatusBoundMs,
          cache: cacheStatus(),
        });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
