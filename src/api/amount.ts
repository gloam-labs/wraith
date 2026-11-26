/**
 * Amount parsing shared by the money rails.
 *
 * An amount arrives as a JSON number or a plain decimal string. Anything else
 * is refused rather than coerced: `Number("abc")` is NaN, `Number(true)` is 1
 * and `Number([5])` is 5, none of which is an amount somebody meant to send.
 */

import { z } from "zod";

/**
 * A positive amount no greater than `max`, from a JSON number or a plain
 * decimal string. The ceiling also rejects Infinity, which `Number` alone
 * would accept.
 */
export function amountSchema(max: number = Number.MAX_VALUE) {
  return z
    .union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/)])
    .transform(Number)
    .pipe(z.number().positive().max(max));
}

/**
 * Parse an unbounded positive amount, or null when the value is not one.
 *
 * Used by the naira routes, which have no per-order ceiling and must answer
 * their own `invalid_request` rather than let the value reach the provider.
 */
export function parseAmount(value: unknown): number | null {
  const parsed = amountSchema().safeParse(value);
  return parsed.success ? parsed.data : null;
}
