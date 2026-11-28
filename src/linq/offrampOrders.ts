/**
 * Reconciliation for offramp orders.
 *
 * The webhook used to write this update inline. The periodic sweep needs the
 * same write, and two implementations of "apply Linq's status to our row" is
 * how a webhook and a poll start disagreeing. Both now go through here.
 */

import { prisma } from "../db";
import { recordOrderTerminal, terminalStatusOf } from "../metrics";
import { isFailureStatus, recordMoneyFailure } from "./moneyFailures";
import { resolveEventNetwork } from "./webhook";

export interface OfframpReconciliationEvent {
  orderId: string;
  network?: string;
  status?: string;
  event: string;
  amountStableCoin?: number;
  amountNGN?: number;
  txHash?: string;
}

/**
 * Apply an event or status-poll result to an offramp order.
 *
 * Returns false when the network is invalid or the order is not ours. Nothing
 * here creates a row: an event for an order we never placed is not ours to act
 * on.
 *
 * Returns true without writing when the status and amounts are unchanged —
 * idempotent so a wallet polling a finished order and a re-delivered webhook
 * never re-fire money-failure counters or terminal metrics.
 *
 * Fields that main writes (txHash, settled amounts) are always applied when
 * present, even when the status has not changed. A poll may settle the row
 * before a webhook arrives with the transaction hash; dropping those fields
 * because the status is already terminal would lose data.
 */
export async function reconcileOfframpOrder(
  event: OfframpReconciliationEvent,
): Promise<boolean> {
  const network = resolveEventNetwork(event);
  if (!network) return false;

  const existing = await prisma.offrampOrder.findUnique({
    where: { network_orderId: { network, orderId: event.orderId } },
  });
  if (!existing) return false;

  const status = event.status ?? event.event;

  const wasTerminal = terminalStatusOf(existing.status);
  const isTerminal = terminalStatusOf(status);

  if (status !== existing.status) {
    // Only write final amounts on a terminal transition. Writing them on an
    // intermediate status (e.g. "processing") would store an in-flight figure
    // as the settled amount, which the cache path would then show as final.
    // "completed" and "settled" both carry final amounts; so do other terminals.
    const isFinalTransition = isTerminal !== null;

    await prisma.offrampOrder.update({
      where: { network_orderId: { network, orderId: event.orderId } },
      data: {
        status,
        ...(isFinalTransition && event.amountStableCoin != null
          ? { settledStableCoin: String(event.amountStableCoin) }
          : {}),
        ...(isFinalTransition && event.amountNGN != null
          ? { settledNGN: String(event.amountNGN) }
          : {}),
        ...(event.txHash ? { depositTxHash: event.txHash } : {}),
      },
    });

    if (isTerminal && !wasTerminal) recordOrderTerminal("offramp", status);

    // Record a money failure only on the transition into a failure status, not
    // on every subsequent poll. The counter and incident table must not grow
    // each time a finished-failed order is re-polled.
    if (isFailureStatus(status)) {
      await recordMoneyFailure({
        network: existing.network,
        rail: "offramp",
        kind: "payout_rejected",
        orderId: event.orderId,
        publicId: existing.publicId,
        providerCode: status,
        message: `Offramp order ended as "${status}" — the naira payout did not complete.`,
      });
    }
  } else {
    // Status is unchanged. The row update above is skipped, but fields that
    // main writes — txHash and settled amounts — must still be applied when
    // the event carries them and the row does not already have them. A webhook
    // arriving after a poll has already set the terminal status is the common
    // case for txHash delivery.
    const extraFields: Record<string, string> = {};
    if (event.txHash && !existing.depositTxHash)
      extraFields.depositTxHash = event.txHash;
    if (isTerminal !== null && event.amountStableCoin != null && existing.settledStableCoin == null)
      extraFields.settledStableCoin = String(event.amountStableCoin);
    if (isTerminal !== null && event.amountNGN != null && existing.settledNGN == null)
      extraFields.settledNGN = String(event.amountNGN);

    if (Object.keys(extraFields).length > 0) {
      await prisma.offrampOrder.update({
        where: { network_orderId: { network, orderId: event.orderId } },
        data: extraFields,
      });
    }
  }

  return true;
}
