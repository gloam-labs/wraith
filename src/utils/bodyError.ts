/**
 * Request-body errors, and how to log an error without the request body.
 *
 * When the body parser cannot read a request it passes on an error that
 * carries the WHOLE raw body as `err.body`. Logging that error logs the body.
 * On this service a body can hold a national ID number, a phone number or bank
 * details, and none of those may reach a log. So a body-parser failure is
 * answered here as the caller's mistake, and nothing that reaches the log ever
 * includes `body`.
 */

/** The body parser's own failure types all start with one of these. */
const PARSER_TYPE = /^(entity|request|encoding|charset|parameters|stream)\./;

export interface BodyParseFailure {
  status: number;
  type: string;
}

/**
 * The status and type of a body-parser failure, or null when `err` is
 * something else. Only 4xx failures count: those are the caller's.
 */
export function bodyParseFailure(err: unknown): BodyParseFailure | null {
  if (typeof err !== "object" || err === null) return null;
  const { type, status, statusCode } = err as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  if (typeof type !== "string" || !PARSER_TYPE.test(type)) return null;
  const code = typeof status === "number" ? status : statusCode;
  if (typeof code !== "number" || code < 400 || code > 499) return null;
  return { status: code, type };
}

/**
 * What may be written to the log for an unhandled error: its name, message and
 * stack, and nothing else. Fields that libraries attach to errors (`body`,
 * request and response objects, configs with headers) stay out.
 *
 * A JSON syntax error's message can quote a few characters of the input, so a
 * parser failure never reaches this function; `bodyParseFailure` catches it
 * first.
 */
export function loggableError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "NonError", message: typeof err === "string" ? err : "non-error value thrown" };
}
