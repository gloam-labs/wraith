import express from "express";
import { requestId } from "./middleware/requestId";
import { indexRoutePatterns } from "./routePatterns";
import {
  checkRpcHealth,
  clearRpcHealthCache,
  setupPreBodyMiddleware,
  setupBodyAndAppMiddleware,
} from "./api/middleware";
import {
  mountRawBodyRoutes,
  assertPreBodyParserOrder,
  mountRoutes,
} from "./api/routes";
import { setupErrorHandlers } from "./api/errorHandlers";

// ─── Amount formatting ────────────────────────────────────────────────────
export { toDisplayAmount } from "./amount";
export { checkRpcHealth, clearRpcHealthCache };

export function createApp(): express.Application {
  const app = express();

  // Render terminates the connection and forwards it, so without this every
  // request's IP is the proxy's and the limiter below (60 per minute) is one
  // bucket shared by every user of the app. A cash-out screen polls about ten
  // times a minute; a handful of people at once emptied the bucket and the next
  // person got "too many requests" for no reason of their own. One hop: trust
  // Render's X-Forwarded-For, nothing further back.
  app.set("trust proxy", 1);

  // ─── Request id ───────────────────────────────────────────────────────────
  // First, above everything that can answer: the two raw-body routers, CORS,
  // the limiter, and the error handler at the bottom. An id that started after
  // a router would leave the requests that router refuses — and every log line
  // it wrote — without one, which is exactly the report a person files.
  // It reads a header and writes a header, so it is safe above `express.json()`
  // and above the signature-verifying webhook routes.
  app.use(requestId);

  // 1. Pre-body middleware (HTTP metrics and per-surface CORS)
  setupPreBodyMiddleware(app);

  // 2. Raw-body routes (must be mounted BEFORE express.json() for signature verification)
  const rawRouters = mountRawBodyRoutes(app);

  // 3. Body parsers and core application middleware
  const jsonParser = setupBodyAndAppMiddleware(app);

  // Boot-time invariant: verify raw-body routers precede jsonParser in the stack
  assertPreBodyParserOrder(app, rawRouters, jsonParser);

  // 4. Standard application routes
  mountRoutes(app);

  // 5. 404 and global error handlers
  setupErrorHandlers(app);

  // Index full Express route patterns per Route object for bounded metrics labels
  indexRoutePatterns(app);

  return app;
}
