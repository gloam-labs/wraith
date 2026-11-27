import { endingsOf, statusWords, type ProviderEnding } from "./providerStatus";

/**
 * The order status as sent to wallet apps.
 *
 * Installed Veil APKs decide an order is finished only when its status
 * contains "settled", "disbursed", "failed" or "timeout". The provider also
 * ends orders as "refunded" (and can expire, cancel or reverse them), which
 * those apps do not recognise -- so a refunded order was shown as still waiting
 * for payment, with a Pay button pointing at a deposit address that no longer
 * exists. A user got stuck on exactly that screen.
 *
 * Apps cannot be rebuilt on demand, so the fix lives here: an ending the old
 * apps do not know is sent with a word they do ("failed" or "timeout"), which
 * moves them to the finished screen with its "any USDC that arrived is
 * refunded" note. The provider's own word stays first, so newer apps and humans
 * reading it lose nothing, and the raw value is also returned as
 * `providerStatus`.
 */
export function statusForClients(status: string): string {
  // Only a real ending is ever re-worded. A status that is still moving
  // ("refund_pending", "cancel_requested") or that no rule knows goes out
  // exactly as the provider sent it, so an app never finishes an order that
  // has not ended (#418).
  const endings = endingsOf(status);
  if (endings.length === 0) return status;

  // Already carries a word installed apps finish on: leave it alone.
  if (endings.some((e) => APP_FINISHES_ON.includes(e))) return status;
  if (endings.includes("expired")) return `${status} (timeout)`;
  if (endings.some((e) => e === "refunded" || e === "cancelled" || e === "reversed")) {
    return `${status} (failed)`;
  }
  return status;
}

/** The endings installed apps already treat as finished. */
const APP_FINISHES_ON: readonly ProviderEnding[] = ["settled", "disbursed", "failed", "timeout"];

/**
 * The same translation for the **bills** rail, which speaks a second dialect.
 *
 * The onramp and offramp screens end on "settled", "disbursed", "failed" or
 * "timeout" (above). The airtime/electricity screens do not: they end on
 * `/complete|success|delivered/` for a win and `/fail|refund|revers|cancel/`
 * for a loss. Linq ends a vend as "settled" or "disbursed" — a word the bills
 * screen has no case for — so a top-up that was delivered and paid for left the
 * app on "Waiting for the top-up…" forever, with no reference on screen and the
 * poll's only record of its own failure a `console.warn` nobody can read.
 *
 * So a successful ending is sent carrying both dialects: the provider's own
 * word first, then "(completed)", which the bills screen recognises. The loss
 * cases already work — `statusForClients` appends "(failed)" for a refund,
 * cancel or reversal, and "fail" is in the bills screen's vocabulary too.
 *
 * Installed APKs cannot be rebuilt on demand, which is why this lives on the
 * server. `src/api/ngn.ts` also returns the raw provider value as
 * `providerStatus`, so nothing is lost for a newer client or a human reading it.
 */
export function billStatusForClients(status: string): string {
  const endings = endingsOf(status);
  const paidOut = endings.includes("settled") || endings.includes("disbursed");
  const alreadyUnderstood = statusWords(status).some((w) => BILLS_SCREEN_WINS.includes(w));
  if (paidOut && !alreadyUnderstood) return `${status} (completed)`;
  return statusForClients(status);
}

/** Words the bills screen already ends on as a win. */
const BILLS_SCREEN_WINS: readonly string[] = [
  "complete",
  "completed",
  "success",
  "successful",
  "deliver",
  "delivered",
];