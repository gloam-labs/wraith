import { createHash, timingSafeEqual } from "crypto";
import { Router, type Request, type Response } from "express";

import { requestNetwork } from "../middleware/network";
import { feeReport, recordFeeQuotes } from "./feeLedger";

/**
 * What Veil charges, answered by the server so the number is never in an APK.
 *
 * The fee itself is collected on-chain, in the same transaction as the thing
 * the user is doing — Linq confirmed on 2026-09-30 that they have no developer
 * fee structure, and the money never passes through wraith in either
 * direction, so there is nothing here to deduct from. What this endpoint does
 * is tell the client what to charge and where to send it.
 *
 * That split is the point. An amount compiled into the app can only be changed
 * by building, shipping and waiting for every user to update; a waiver, a
 * promotion or a correction then costs days. Here it is an environment
 * variable.
 */

/** A classic `G…` account. Contracts cannot be paid by a classic payment op. */
function isClassicAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}

export interface PlatformFee {
  /**
   * Whole units of the fee asset, as a decimal string — what to charge.
   *
   * When the caller passed the amount being sent this is computed for it;
   * without one it is the floor, which is what a client too old to send an
   * amount will charge. That fallback is deliberately the smallest honest
   * number rather than the largest: an old client undercharging costs us, and
   * overcharging costs the user.
   */
  amount: string;
  assetCode: string;
  /** Null for native XLM, which has no issuer. */
  assetIssuer: string | null;
  destination: string;
  /** Percent of the sent amount, when the fee scales. Absent when it is flat. */
  percent?: string;
  /** Floor and cap, present only alongside `percent`. */
  min?: string;
  max?: string;
}

/** Stellar carries seven decimal places; anything beyond them cannot be sent. */
const STROOP_DP = 7;

/**
 * A decimal parsed exactly: `value = digits / 10^scale`, with `digits` a
 * BigInt. All fee arithmetic is done on these, never on JavaScript numbers —
 * a float cannot represent most decimal fractions, and the difference lands
 * on somebody's charge. (`4.35` at 1% in floats is `0.0434999`, not `0.0435`.)
 */
export interface DecimalParts {
  digits: bigint;
  scale: number;
}

/**
 * Parse a decimal string exactly, or return null when it is not one. Exponent
 * notation is accepted because `String(number)` produces it for very small
 * and very large numbers (`String(0.0000001)` is `"1e-7"`).
 */
export function parseDecimal(value: string): DecimalParts | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, intPart = "", fracA, fracB, expPart] = match;
  const frac = fracA ?? fracB ?? "";
  let digits = BigInt(intPart + frac || "0");
  if (sign === "-") digits = -digits;
  return { digits, scale: frac.length - (expPart ? parseInt(expPart, 10) : 0) };
}

/**
 * The decimal string naming a `number | string` input. A number is taken at
 * the decimal its string form names — `String(4.35)` is `"4.35"` — and is
 * never itself used in arithmetic.
 */
function decimalString(value: number | string): string {
  return typeof value === "number" ? String(value) : value.trim();
}

/** Exact comparison of two parsed decimals: -1, 0 or 1. */
export function compareDecimal(a: DecimalParts, b: DecimalParts): number {
  const scale = Math.max(a.scale, b.scale);
  const av = a.digits * 10n ** BigInt(scale - a.scale);
  const bv = b.digits * 10n ** BigInt(scale - b.scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** The canonical decimal string for a parsed decimal: no trailing zeros. */
export function formatDecimal(parts: DecimalParts): string {
  let { digits, scale } = parts;
  if (digits === 0n) return "0";
  while (digits % 10n === 0n) {
    digits /= 10n;
    scale -= 1;
  }
  const negative = digits < 0n;
  const str = (negative ? -digits : digits).toString();
  let out: string;
  if (scale <= 0) out = str + "0".repeat(-scale);
  else if (str.length > scale) out = `${str.slice(0, -scale)}.${str.slice(-scale)}`;
  else out = `0.${"0".repeat(scale - str.length)}${str}`;
  return negative ? `-${out}` : out;
}

/**
 * A parsed decimal floored to whole stroops. Fee-path values are
 * non-negative, so BigInt's truncating division is a floor.
 */
function stroopsFloor({ digits, scale }: DecimalParts): bigint {
  if (scale <= STROOP_DP) return digits * 10n ** BigInt(STROOP_DP - scale);
  return digits / 10n ** BigInt(scale - STROOP_DP);
}

/** The canonical decimal string for a stroop count. */
function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const raw = (negative ? -stroops : stroops).toString().padStart(STROOP_DP + 1, "0");
  const whole = raw.slice(0, -STROOP_DP);
  const frac = raw.slice(-STROOP_DP).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

function validRate(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const parts = parseDecimal(raw);
  if (!parts) return null;
  // A fee over 100% is always a misconfiguration, and charging it would take
  // more than the user is sending.
  if (compareDecimal(parts, { digits: 0n, scale: 0 }) <= 0) return null;
  if (compareDecimal(parts, { digits: 100n, scale: 0 }) > 0) return null;
  return formatDecimal(parts);
}

/**
 * The fee for sending `sent`, as a decimal string.
 *
 * Rounded DOWN to stroop precision. Rounding is a choice about who absorbs the
 * remainder, and on a charge the user did not ask for it should not be them.
 * The floor is applied afterwards, so rounding down can never produce a fee of
 * zero where one was configured.
 */
export function feeForAmount(
  sent: number | string,
  policy: { percent: number | string; min: number | string | null; max: number | string | null },
): string {
  const sentParts = parseDecimal(decimalString(sent)) ?? { digits: 0n, scale: 0 };
  const percentParts = parseDecimal(decimalString(policy.percent)) ?? { digits: 0n, scale: 0 };
  // In stroops: floor(sent × percent / 100 × 10^STROOP_DP), computed exactly.
  // The shift folds the two scales, the division by 100 and the stroop
  // scaling into one power of ten; a negative shift divides, and BigInt
  // division truncates — which, for these non-negative values, is the
  // rounding down the policy promises.
  const shift = BigInt(STROOP_DP - sentParts.scale - percentParts.scale - 2);
  const product = sentParts.digits * percentParts.digits;
  let fee = shift >= 0n ? product * 10n ** shift : product / 10n ** -shift;
  if (policy.max !== null) {
    const cap = parseDecimal(decimalString(policy.max));
    if (cap) fee = fee > stroopsFloor(cap) ? stroopsFloor(cap) : fee;
  }
  if (policy.min !== null) {
    const floor = parseDecimal(decimalString(policy.min));
    if (floor) fee = fee < stroopsFloor(floor) ? stroopsFloor(floor) : fee;
  }
  return formatStroops(fee);
}

/**
 * Which rule decided a fee — what the ledger records so a charge can be
 * explained later without re-deriving it from a policy that may have changed.
 *
 * `no_amount` is the floor told to a client that sent no amount; `floor` is
 * the floor overriding a percent that came out smaller.
 */
export type FeeBasis = "percent" | "floor" | "cap" | "flat" | "no_amount";

export function feeBasis(fee: PlatformFee, sent?: number | string): FeeBasis {
  if (fee.percent === undefined) return "flat";
  if (sent === undefined) return "no_amount";
  // Exact comparisons: the label is what the ledger records to explain the
  // charge, and a float `===` can call a capped fee a percent fee (or the
  // reverse) on values a hair apart.
  const charged = parseDecimal(fee.amount);
  const uncapped = parseDecimal(feeForAmount(sent, { percent: fee.percent, min: null, max: null }));
  if (!charged || !uncapped) return "percent";
  if (fee.max !== undefined) {
    const cap = parseDecimal(fee.max);
    if (cap && compareDecimal(charged, cap) === 0 && compareDecimal(uncapped, charged) > 0) return "cap";
  }
  if (fee.min !== undefined) {
    const floor = parseDecimal(fee.min);
    if (floor && compareDecimal(charged, floor) === 0 && compareDecimal(uncapped, charged) < 0) return "floor";
  }
  return "percent";
}

function validAmount(value: string | undefined): string | null {
  const amount = value?.trim();
  if (!amount) return null;
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) return null;
  const parts = parseDecimal(amount);
  if (!parts || parts.digits <= 0n) return null;
  return amount;
}

/**
 * The fee for each asset we charge on, keyed by asset code.
 *
 * Per asset, and always **in the asset being sent**. Charging 0.1 USDC on an
 * XLM transfer would need a second balance the sender may not have and a
 * trustline they may not hold — and because the fee rides in the same
 * transaction as the payment, a fee they cannot cover would take their actual
 * payment down with it. A fee denominated in what they are already sending is
 * payable by definition: if they can send it, they can pay it.
 *
 * Every malformed entry is dropped rather than guessed at. A fee is a payment
 * the user did not ask for; if we cannot say exactly what it is and where it
 * goes, we do not charge it.
 */
export function configuredFees(sentAmount?: number | string): Record<string, PlatformFee> {
  const destination = process.env.VEIL_FEE_DESTINATION?.trim();
  if (!destination || !isClassicAddress(destination)) return {};

  const fees: Record<string, PlatformFee> = {};
  const percent = validRate(process.env.VEIL_FEE_PERCENT);

  /**
   * One asset's entry, flat or proportional.
   *
   * A flat fee is regressive here and the numbers are stark: 0.1 USDC is 10%
   * of a 1 USDC send and 0.01% of a 1,000 one, so the people being onboarded
   * with a thousand naira pay the heaviest rate while large senders pay
   * nothing worth naming. A percent with a floor and a cap keeps the small
   * sends cheap without making the large ones punitive.
   */
  const entry = (code: string, issuer: string | null, flat: string | null, min: string | null, max: string | null): PlatformFee | null => {
    if (percent === null) {
      // No rate configured: the flat amount, exactly as before.
      return flat ? { amount: flat, assetCode: code, assetIssuer: issuer, destination } : null;
    }
    const floor = min ?? flat;
    const cap = max;
    const sentParts = sentAmount !== undefined ? parseDecimal(decimalString(sentAmount)) : null;
    // Without an amount to price, answer with the floor — see `amount` above.
    const amount =
      sentParts && sentParts.digits > 0n
        ? feeForAmount(sentAmount!, { percent, min: floor, max: cap })
        : formatStroops(floor !== null ? stroopsFloor(parseDecimal(floor)!) : 0n);
    if (!validAmount(amount)) return null;
    return {
      amount,
      assetCode: code,
      assetIssuer: issuer,
      destination,
      percent,
      ...(floor !== null ? { min: formatStroops(stroopsFloor(parseDecimal(floor)!)) } : {}),
      ...(cap !== null ? { max: formatStroops(stroopsFloor(parseDecimal(cap)!)) } : {}),
    };
  };

  // USDC, or whichever issued asset VEIL_FEE_ASSET_CODE names.
  const issuedCode = process.env.VEIL_FEE_ASSET_CODE?.trim() || "USDC";
  const issuer = process.env.VEIL_FEE_ASSET_ISSUER?.trim();
  if (issuer && isClassicAddress(issuer)) {
    const fee = entry(
      issuedCode,
      issuer,
      validAmount(process.env.VEIL_FEE_AMOUNT),
      validAmount(process.env.VEIL_FEE_MIN),
      validAmount(process.env.VEIL_FEE_MAX),
    );
    if (fee) fees[issuedCode] = fee;
  }

  // Native XLM, which has no issuer and needs no trustline.
  const xlm = entry(
    "XLM",
    null,
    validAmount(process.env.VEIL_FEE_AMOUNT_XLM),
    validAmount(process.env.VEIL_FEE_MIN_XLM),
    validAmount(process.env.VEIL_FEE_MAX_XLM),
  );
  if (xlm) fees["XLM"] = xlm;

  return fees;
}

/** The longest range one report may cover, so a request cannot scan the whole ledger. */
export const MAX_REPORT_DAYS = 92;

/** `YYYY-MM-DD` that is also a real calendar date. */
function isUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A validated inclusive date range, or the reason it is not one. */
export function reportRange(from: string, to: string): { from: string; to: string } | string {
  if (!isUtcDate(from) || !isUtcDate(to)) return "from and to must be dates in YYYY-MM-DD form (UTC)";
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
  if (days < 1) return "from must not be after to";
  if (days > MAX_REPORT_DAYS) return `A report covers at most ${MAX_REPORT_DAYS} days`;
  return { from, to };
}

function bearer(req: Request): string {
  const match = /^Bearer +(\S+)$/i.exec(String(req.headers.authorization ?? "").trim());
  return match ? match[1] : "";
}

/** Constant-time comparison; hashing first makes the lengths equal. */
function sameSecret(given: string, expected: string): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function feesRouter(): Router {
  const router = Router();

  /**
   * Unauthenticated and uncached: it carries no personal data, and a stale
   * fee is one a user was shown but did not agree to.
   */
  router.get("/", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    // `?amount=` is the amount being sent, so the fee can scale with it. A
    // client too old to send one gets the floor, which is why this is optional
    // rather than required: the shipped APKs predate it and must keep working.
    // It is parsed as a decimal string — at most seven places, the same rule
    // `validAmount` applies to configured amounts — never through `Number`,
    // so the amount priced is the amount the client wrote.
    const rawAmount = req.query["amount"];
    const sent = typeof rawAmount === "string" ? (validAmount(rawAmount) ?? undefined) : undefined;
    const fees = configuredFees(sent);
    const assets = Object.keys(fees);
    // `enabled: false` rather than a 404, so a client can tell "no fee today"
    // from "this backend is too old to know about fees" and does not read a
    // deliberate waiver as a failure.
    res.json(assets.length > 0 ? { enabled: true, fees } : { enabled: false, fees: {} });

    // Recorded after the answer is sent, and never awaited: the person is in
    // the middle of a payment, and a ledger outage must not become a failed
    // send. `recordFeeQuotes` cannot throw. See `./feeLedger`.
    void recordFeeQuotes(
      requestNetwork(req),
      sent,
      Object.values(fees).map((fee) => ({ fee, basis: feeBasis(fee, sent) })),
    );
  });

  /**
   * What was charged, per UTC day and asset, and under which policy.
   *
   * Behind a bearer token, `VEIL_FEE_REPORT_TOKEN`: nothing in it identifies a
   * person, but collected totals are the operator's business volume, not
   * something to publish. Without the token configured the route answers 503,
   * so a deployment never serves it open by accident.
   */
  router.get("/report", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const expected = process.env.VEIL_FEE_REPORT_TOKEN?.trim();
    if (!expected) {
      res.status(503).json({ error: "Fee reporting is not configured on this deployment" });
      return;
    }
    if (!sameSecret(bearer(req), expected)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res.status(401).json({ error: "A valid report token is required" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const from = req.query["from"] === undefined ? today : String(req.query["from"]);
    const to = req.query["to"] === undefined ? from : String(req.query["to"]);
    const range = reportRange(from, to);
    if (typeof range === "string") {
      res.status(400).json({ error: range });
      return;
    }

    try {
      res.json(await feeReport(requestNetwork(req), range.from, range.to));
    } catch (err) {
      console.error(`[fees] report failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Could not read the fee ledger" });
    }
  });

  return router;
}
