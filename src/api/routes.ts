import { Application, Router } from "express";
import { createAccountsRouter } from "./accounts";
import { createCandlesRouter } from "./candles";
import { getOhlcRefreshIntervalMs } from "../ohlcConfig";
import { createWebhooksRouter } from "./webhooks";
import { createLinqWebhookRouter } from "./linqWebhook";
import { createOfframpRouter } from "./offramp";
import { createNgnRouter } from "./ngn";
import { createOpsRouter } from "./ops";
import { createDiscordInteractionsRouter } from "../discord/interactions";
import { createDiscordLinkRouter } from "../discord/link";
import { feesRouter } from "./fees";
import { createGraphQLMiddleware } from "../graphql/server";
import { createPopularAssetsRouter } from "../routes/assets/popular";
import { createExportsRouter } from "../routes/exports";
import { createSearchRouter } from "../routes/search";
import { createSystemRouter } from "../routes/system";
import { createTransfersRouter } from "../routes/transfers";
import { createContractsRouter } from "../routes/contracts";
import { cacheMiddleware } from "../cache/redis";

// ─── Response cache TTLs (opt-in via CACHE_ENABLED) ─────────────────────────
const POPULAR_CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_POPULAR_MS ?? "60000", 10);
const SEARCH_CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_SEARCH_MS ?? "15000", 10);

export interface RawBodyRouters {
  linqRouter: Router;
  discordRouter: Router;
}

/**
 * Mount routes that require unparsed raw request bodies.
 *
 * MUST be mounted BEFORE `express.json()`. Linq and Discord sign the raw request body;
 * re-serialising parsed JSON breaks signature verification.
 */
export function mountRawBodyRoutes(app: Application): RawBodyRouters {
  const linqRouter = createLinqWebhookRouter();
  const discordRouter = createDiscordInteractionsRouter();

  app.use("/webhooks/linq", linqRouter);
  app.use("/discord/interactions", discordRouter);

  return { linqRouter, discordRouter };
}

/**
 * Assert that raw-body routes are strictly mounted before body parsers in the middleware stack.
 * Throws a descriptive error if the order invariant is violated.
 */
export function assertPreBodyParserOrder(app: Application, rawRouters: RawBodyRouters): void {
  const router = (app as unknown as { router?: { stack?: unknown[] }; _router?: { stack?: unknown[] } }).router ??
    (app as unknown as { _router?: { stack?: unknown[] } })._router;

  if (!router || !Array.isArray(router.stack)) {
    throw new Error("Unable to verify middleware stack: router stack not initialized");
  }

  const stack = router.stack as Array<{ name?: string; handle?: unknown }>;
  const linqIdx = stack.findIndex((layer) => layer.handle === rawRouters.linqRouter);
  const discordIdx = stack.findIndex((layer) => layer.handle === rawRouters.discordRouter);
  const jsonIdx = stack.findIndex((layer) => layer.name === "jsonParser");

  if (linqIdx === -1) {
    throw new Error("Security assertion failed: /webhooks/linq raw-body router is not mounted");
  }
  if (discordIdx === -1) {
    throw new Error("Security assertion failed: /discord/interactions raw-body router is not mounted");
  }
  if (jsonIdx === -1) {
    throw new Error("Configuration assertion failed: express.json() is not mounted");
  }

  if (linqIdx > jsonIdx) {
    throw new Error(
      `Security invariant violated: /webhooks/linq (layer index ${linqIdx}) must be mounted before express.json() (layer index ${jsonIdx}) to verify raw request signatures`
    );
  }
  if (discordIdx > jsonIdx) {
    throw new Error(
      `Security invariant violated: /discord/interactions (layer index ${discordIdx}) must be mounted before express.json() (layer index ${jsonIdx}) to verify raw request signatures`
    );
  }
}

/**
 * Mount all standard application routes.
 */
export function mountRoutes(app: Application): void {
  // Accounts and candles routes
  app.use("/accounts", createAccountsRouter());
  if (getOhlcRefreshIntervalMs() !== undefined) {
    app.use("/candles", createCandlesRouter());
  }

  // Webhook subscription management
  app.use("/webhooks", createWebhooksRouter());
  app.use("/offramp", createOfframpRouter());

  // Naira rails: buying with naira, and bills paid out of the wallet
  app.use("/ngn", createNgnRouter());

  // Operator surface: what broke, without database access. Token-gated by OPS_TOKEN
  app.use("/ops", createOpsRouter());

  // Linking a Veil wallet to a Discord member
  app.use("/discord", createDiscordLinkRouter());

  // Fee calculation & quotes
  app.use("/fees", feesRouter());

  // GraphQL
  app.use("/graphql", createGraphQLMiddleware());

  // Assets routes
  app.use("/assets", cacheMiddleware({ ttlMs: POPULAR_CACHE_TTL_MS }), createPopularAssetsRouter());

  // Export routes
  app.use("/", createExportsRouter());

  // Fuzzy search across accounts, assets, and contracts
  app.use("/search", cacheMiddleware({ ttlMs: SEARCH_CACHE_TTL_MS }), createSearchRouter());

  // Core system, transfers, and contract routes
  app.use("/", createSystemRouter());
  app.use("/", createTransfersRouter());
  app.use("/", createContractsRouter());
}
