import express from "express";
import {
  setupPreBodyMiddleware,
  setupBodyAndAppMiddleware,
  clearRpcHealthCache,
  checkRpcHealth,
} from "./api/middleware";
import {
  mountRawBodyRoutes,
  assertPreBodyParserOrder,
  mountRoutes,
} from "./api/routes";
import { setupErrorHandlers } from "./api/errorHandlers";

export { clearRpcHealthCache, checkRpcHealth };
export { toDisplayAmount } from "./amount";

/**
 * Creates and configures the Express application.
 *
 * Middleware and route mounting pipeline:
 *  1. Pre-body middleware (Metrics tracking, CORS)
 *  2. Raw-body routes (Linq webhooks, Discord interactions)
 *  3. Body parsers & core middleware (express.json, jsonapi, network, rate limit, stale reads)
 *  4. Ordering assertion (enforces raw-body routes precede body parsers)
 *  5. Application routes (accounts, candles, webhooks, rails, exports, system, transfers)
 *  6. Error handling (404 and global error handlers)
 */
export function createApp(): express.Application {
  const app = express();

  // Render terminates the connection and forwards it, so without this every
  // request's IP is the proxy's and the limiter (60 per minute) is one
  // bucket shared by every user of the app. One hop: trust Render's X-Forwarded-For.
  app.set("trust proxy", 1);

  // 1. Pre-body middleware (HTTP metrics and per-surface CORS)
  setupPreBodyMiddleware(app);

  // 2. Raw-body routes (must mount before express.json() for signature verification)
  const rawRouters = mountRawBodyRoutes(app);

  // 3. Body parsers and core app middleware (express.json, jsonApi, network, limiter, stale reads)
  setupBodyAndAppMiddleware(app);

  // 4. Assert ordering invariant at runtime: raw-body routes must precede express.json()
  assertPreBodyParserOrder(app, rawRouters);

  // 5. Standard application routes
  mountRoutes(app);

  // 6. 404 and global error handlers
  setupErrorHandlers(app);

  return app;
}
