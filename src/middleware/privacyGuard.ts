/**
 * Privacy guard middleware for stealth scanning (#1320).
 *
 * Stealth scanning requires that an indexer never learns which payments
 * belong to a user. A naive endpoint that accepts viewing keys, meta-addresses,
 * or candidate recipient addresses destroys the privacy guarantee.
 *
 * This middleware rejects any request carrying receiver credentials or
 * candidate addresses with a clear 400 error.
 */
import type { Request, Response, NextFunction } from "express";

const DISALLOWED_KEY_PATTERNS: readonly RegExp[] = [
  /viewing/i,
  /view_?key/i,
  /meta_?address/i,
  /stealth_?address/i,
  /spending_?key/i,
  /spend_?key/i,
  /candidate/i,
  /recipient/i,
  /receiver/i,
  /^address$/i,
] as const;

/**
 * Checks an object (query, headers, or body) for forbidden receiver-identifying keys.
 * Returns the matching key name if found, or null if safe.
 */
export function findPrivacyViolatingParam(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    for (const pattern of DISALLOWED_KEY_PATTERNS) {
      if (pattern.test(key)) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Express middleware that rejects requests containing any parameter, header,
 * or body field that could identify a stealth payment receiver.
 */
export function privacyGuardMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const queryViolator = findPrivacyViolatingParam(req.query);
  if (queryViolator) {
    res.status(400).json({
      error: `Requests containing viewing keys, meta-addresses, candidate addresses, or recipient identifiers are refused to preserve receiver privacy (found query parameter "${queryViolator}").`,
      code: "privacy_violation",
    });
    return;
  }

  const headerViolator = findPrivacyViolatingParam(req.headers);
  if (headerViolator) {
    res.status(400).json({
      error: `Requests containing viewing keys, meta-addresses, candidate addresses, or recipient identifiers are refused to preserve receiver privacy (found header "${headerViolator}").`,
      code: "privacy_violation",
    });
    return;
  }

  const bodyViolator = findPrivacyViolatingParam(req.body);
  if (bodyViolator) {
    res.status(400).json({
      error: `Requests containing viewing keys, meta-addresses, candidate addresses, or recipient identifiers are refused to preserve receiver privacy (found body parameter "${bodyViolator}").`,
      code: "privacy_violation",
    });
    return;
  }

  next();
}
