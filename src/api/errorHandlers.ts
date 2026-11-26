import { Request, Response, NextFunction, Application } from "express";
import { type RequestWithId } from "../middleware/requestId";
import { HttpError, newCorrelationId } from "../utils/errors";
import { bodyParseFailure, loggableError } from "../utils/bodyError";

// ─── 404 handler ─────────────────────────────────────────────────────────
// `code` here too: an unmatched path under `/ngn` or `/offramp` is an error
// response on those surfaces, and a rail client must not meet a codeless
// body at the edge of the API.
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found", code: "not_found" });
}

// ─── Global error handler ────────────────────────────────────────────────
export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // A deliberately-thrown HttpError carries a message written for the caller,
  // so it keeps its own status and text.
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: err.message, code: err.status >= 500 ? "internal_error" : "invalid_request" });
    return;
  }

  // A body the parser could not read is the caller's mistake, not ours. Its
  // error object carries the whole raw body, which can hold a national ID
  // number or bank details, so only the failure type is logged.
  const parseFailure = bodyParseFailure(err);
  if (parseFailure) {
    console.warn(`[api] Unreadable request body (${parseFailure.type})`);
    res
      .status(parseFailure.status)
      .json({ error: "The request body could not be read", code: "invalid_request" });
    return;
  }

  // The id is the one the request already has, not a fresh one: a person
  // reporting a failed cash-out quotes the id on the screen, and the provider
  // call that failed wrote its log lines under that same id. Minting a second
  // id here meant the report and the logs never met.
  const correlationId = (req as RequestWithId).requestId ?? newCorrelationId();
  // Never the raw error: libraries hang request data on their errors.
  console.error(`[api] Unhandled error (${correlationId}):`, loggableError(err));

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
