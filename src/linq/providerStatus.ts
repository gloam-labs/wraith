/**
 * The one reader of provider order statuses.
 *
 * Linq's statuses are not one vocabulary: a webhook says `order.failed`, a poll
 * says `failed: beneficiary account rejected`, and an order can also be
 * `refund_pending` — which contains "refund" and is not an ending at all. Three
 * functions used to decide this with `includes`, each with its own word list:
 * `terminalStatusOf` (metrics), `isFailureStatus` (the MoneyFailure record) and
 * `statusForClients` (what installed wallet apps are told). Two of them read a
 * pending refund as a finished, failed order (#418).
 *
 * The rules, in this order:
 *
 *   1. A status is split into words: runs of letters, lower-cased. Nothing is
 *      matched inside a word, so "nonrefundable" is not "refund".
 *   2. If any word says the order is still moving ("pending", "awaiting",
 *      "requested", ...), the status is `moving`, whatever ending words appear
 *      beside it.
 *   3. Otherwise each word that names an ending maps to one canonical ending.
 *      A status with at least one is `ended`.
 *   4. Anything else is `unknown`. An unknown status is not guessed at: callers
 *      pass it through unchanged and count it nowhere.
 */

/**
 * Words that mean the order is still moving, whatever ending word appears
 * beside them: "refund_pending", "cancel_requested", "awaiting_refund".
 */
export const STILL_MOVING_WORDS: readonly string[] = [
  "pending",
  "processing",
  "awaiting",
  "queued",
  "initiated",
  "progress",
  "not",
  "requested",
];

/** The endings a provider status can name, in one spelling each. */
export type ProviderEnding =
  | "completed"
  | "settled"
  | "disbursed"
  | "failed"
  | "rejected"
  | "timeout"
  | "expired"
  | "cancelled"
  | "refunded"
  | "reversed";

/**
 * Every whole word that names an ending, and the ending it names. These are
 * the words the substring rules matched in real statuses; a word missing here
 * is unknown, never guessed.
 */
const ENDING_WORDS: Readonly<Record<string, ProviderEnding>> = {
  completed: "completed",
  settled: "settled",
  disbursed: "disbursed",
  failed: "failed",
  fail: "failed",
  failure: "failed",
  rejected: "rejected",
  reject: "rejected",
  timeout: "timeout",
  expired: "expired",
  expire: "expired",
  cancelled: "cancelled",
  canceled: "cancelled",
  cancel: "cancelled",
  cancellation: "cancelled",
  refunded: "refunded",
  refund: "refunded",
  reversed: "reversed",
  reverse: "reversed",
  reversal: "reversed",
};

export type ProviderStatusClass =
  | { kind: "moving" }
  | { kind: "ended"; endings: ProviderEnding[] }
  | { kind: "unknown" };

/** A status as whole lower-case words. "Order.Refund_Pending" → order, refund, pending. */
export function statusWords(status: string | null | undefined): string[] {
  if (!status) return [];
  return status
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Classify a provider status. See the rules at the top of this file. */
export function classifyProviderStatus(
  status: string | null | undefined,
): ProviderStatusClass {
  const words = statusWords(status);
  if (words.some((word) => STILL_MOVING_WORDS.includes(word)))
    return { kind: "moving" };

  const endings: ProviderEnding[] = [];
  for (const word of words) {
    const ending = Object.prototype.hasOwnProperty.call(ENDING_WORDS, word)
      ? ENDING_WORDS[word]
      : undefined;
    if (ending && !endings.includes(ending)) endings.push(ending);
  }
  return endings.length > 0 ? { kind: "ended", endings } : { kind: "unknown" };
}

/** The endings a status names, or none when it is still moving or unknown. */
export function endingsOf(status: string | null | undefined): ProviderEnding[] {
  const c = classifyProviderStatus(status);
  return c.kind === "ended" ? c.endings : [];
}

const UNWIND_ENDINGS: readonly ProviderEnding[] = ["refunded", "reversed"];

/**
 * True when a status is still `moving` and names a refund or reversal in
 * progress (for example `refund_pending`, `awaiting_refund`, `reversal_pending`).
 *
 * Matched by whole words through {@link ENDING_WORDS}, so words like
 * `nonrefundable` never match, ordinary in-progress statuses (`processing`,
 * `pending`, `settled_pending`) return false, and completed endings (`refunded`,
 * `reversed`) return false because their class is `ended`, not `moving`.
 */
export function isRefundOrReversalInProgress(
  status: string | null | undefined,
): boolean {
  if (classifyProviderStatus(status).kind !== "moving") return false;
  return statusWords(status).some((word) => {
    const ending = Object.prototype.hasOwnProperty.call(ENDING_WORDS, word)
      ? ENDING_WORDS[word]
      : undefined;
    return ending !== undefined && UNWIND_ENDINGS.includes(ending);
  });
}
