import { Request, Response, NextFunction, Application } from "express";
import { HttpError, newCorrelationId } from "../utils/errors";

/**
 * 404 handler for unmatched routes.
 *
 * An unmatched path under `/ngn` or `/offramp` is an error response on those
 * surfaces, and a rail client must not meet a codeless body at the edge of the API.
 */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found", code: "not_found" });
}

/**
 * Global error handler for uncaught exceptions and rejected promises.
 *
 * A deliberately-thrown HttpError carries a message written for the caller,
 * so it keeps its own status and text.
 * Anything else is unhandled: the caller receives an opaque 500 with a correlationId,
 * while the detail stays in the server log to prevent leaking connection strings or stack traces.
 */
export function globalErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: err.message,
      code: err.status >= 500 ? "internal_error" : "invalid_request",
    });
    return;
  }

  const correlationId = newCorrelationId();
  console.error(`[api] Unhandled error (${correlationId}):`, err);

  res.status(500).json({
    error: "Internal server error",
    code: "internal_error",
    correlationId,
  });
}

/**
 * Mount error handlers at the end of the middleware and router stack.
 */
export function setupErrorHandlers(app: Application): void {
  app.use(notFoundHandler);
  app.use(globalErrorHandler);
}
