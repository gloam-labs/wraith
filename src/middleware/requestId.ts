import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { withRequestId } from '../logger';

const HEADER = 'x-request-id';

/** Long enough for any real trace id; past this a caller is writing prose into our logs. */
const MAX_LENGTH = 128;

/**
 * Plain printable ASCII, and nothing else.
 *
 * The id arrives from whoever sent the request and goes out into a log line
 * and back into a response header. A control character in it is a forged log
 * line (or, at the header, a split response), so an id we did not mint is only
 * usable if it is boring.
 */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export interface RequestWithId extends Request {
  requestId: string;
}

/** Is this caller-supplied value something we may echo and log? */
export function isUsableRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_LENGTH &&
    PRINTABLE_ASCII.test(value)
  );
}

/**
 * Assigns a request id to every inbound request, echoes it back on the
 * response, and runs the rest of the request inside an AsyncLocalStorage
 * context so the logger can attach it to every line - including lines
 * emitted from the provider client.
 *
 * If the client already sent an x-request-id we honour it, so a trace can
 * span multiple services. Otherwise, or when what they sent is too long or
 * carries anything but printable ASCII, we mint a new one.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const inbound = typeof req.headers[HEADER] === 'string' ? (req.headers[HEADER] as string).trim() : '';
  const id = isUsableRequestId(inbound) ? inbound : randomUUID();

  (req as RequestWithId).requestId = id;
  res.setHeader(HEADER, id);

  withRequestId(id, () => {
    next();
  });
}

export const REQUEST_ID_HEADER = HEADER;
