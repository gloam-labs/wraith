import {
  statusForClients,
  billStatusForClients,
} from "../../linq/statusForClients";
import { isFailureStatus } from "../../linq/moneyFailures";
import { classifyProviderStatus } from "../../linq/providerStatus";
import { terminalStatusOf } from "../../metrics";

/**
 * Every real ending, and exactly what each function returned for it before
 * status matching moved from substrings to whole words (#418). Installed wallet
 * apps cannot be rebuilt, so a change in any of these strings is a change in
 * what a phone shows. The table was recorded against the substring version and
 * must not be edited to make a new classifier pass.
 *
 * Columns: provider status, statusForClients, billStatusForClients,
 * isFailureStatus, terminalStatusOf.
 */
const ENDINGS: Array<[string, string, string, boolean, string | null]> = [
  ["completed", "completed", "completed", false, "completed"],
  ["order.completed", "order.completed", "order.completed", false, "completed"],
  ["Completed", "Completed", "Completed", false, "completed"],
  ["settled", "settled", "settled (completed)", false, "settled"],
  ["SETTLED", "SETTLED", "SETTLED (completed)", false, "settled"],
  [
    "payment_settled",
    "payment_settled",
    "payment_settled (completed)",
    false,
    "settled",
  ],
  ["disbursed", "disbursed", "disbursed (completed)", false, "disbursed"],
  ["failed", "failed", "failed", true, "failed"],
  ["Failed", "Failed", "Failed", true, "failed"],
  ["order.failed", "order.failed", "order.failed", true, "failed"],
  ["Order Failed", "Order Failed", "Order Failed", true, "failed"],
  ["payment_failed", "payment_failed", "payment_failed", true, "failed"],
  [
    "failed: beneficiary account rejected",
    "failed: beneficiary account rejected",
    "failed: beneficiary account rejected",
    true,
    "failed",
  ],
  [
    "failed: provider declined",
    "failed: provider declined",
    "failed: provider declined",
    true,
    "failed",
  ],
  ["timeout", "timeout", "timeout", true, "timeout"],
  ["provider_timeout", "provider_timeout", "provider_timeout", true, "timeout"],
  [
    "timeout: payout never completed",
    "timeout: payout never completed",
    "timeout: payout never completed",
    true,
    "completed",
  ],
  ["expired", "expired (timeout)", "expired (timeout)", true, "expired"],
  [
    "order.expired",
    "order.expired (timeout)",
    "order.expired (timeout)",
    true,
    "expired",
  ],
  ["refunded", "refunded (failed)", "refunded (failed)", true, "refunded"],
  ["Refunded", "Refunded (failed)", "Refunded (failed)", true, "refunded"],
  ["refund", "refund (failed)", "refund (failed)", true, "refunded"],
  [
    "order.refunded",
    "order.refunded (failed)",
    "order.refunded (failed)",
    true,
    "refunded",
  ],
  ["cancelled", "cancelled (failed)", "cancelled (failed)", true, "cancelled"],
  ["canceled", "canceled (failed)", "canceled (failed)", true, "cancelled"],
  [
    "order.cancelled",
    "order.cancelled (failed)",
    "order.cancelled (failed)",
    true,
    "cancelled",
  ],
  ["reversed", "reversed (failed)", "reversed (failed)", true, "reversed"],
  [
    "order.reversed",
    "order.reversed (failed)",
    "order.reversed (failed)",
    true,
    "reversed",
  ],
  ["rejected", "rejected", "rejected", true, null],
  ["payout_rejected", "payout_rejected", "payout_rejected", true, null],
];

describe("a real ending keeps exactly the output it had before", () => {
  it.each(ENDINGS)("%s", (status, forClients, forBills, failure, terminal) => {
    expect(statusForClients(status)).toBe(forClients);
    expect(billStatusForClients(status)).toBe(forBills);
    expect(isFailureStatus(status)).toBe(failure);
    expect(terminalStatusOf(status)).toBe(terminal);
  });
});

/**
 * Statuses that contain an ending word but describe an order still in flight.
 * The substring version read every one of these as an ending: it wrote a
 * MoneyFailure row and told installed apps the order was finished.
 */
const STILL_MOVING = [
  "refund_pending",
  "refund_processing",
  "cancel_requested",
  "reversal_pending",
  "awaiting_refund",
  "cancellation_pending",
  "Refund Pending",
  "order.refund_pending",
  "settled_pending",
];

describe("a status that is still moving is never an ending", () => {
  it.each(STILL_MOVING)("%s", (status) => {
    expect(classifyProviderStatus(status).kind).toBe("moving");
    expect(isFailureStatus(status)).toBe(false);
    expect(terminalStatusOf(status)).toBeNull();
    // Passed through as the provider sent it: no "(failed)", "(timeout)" or
    // "(completed)" for an app to read as finished.
    expect(statusForClients(status)).toBe(status);
    expect(billStatusForClients(status)).toBe(status);
  });
});

/**
 * A status no rule knows. It must reach the app exactly as sent and be counted
 * nowhere: guessing an ending from part of a word is how a pending refund
 * became a failed payout.
 */
const UNKNOWN = [
  "on_hold",
  "nonrefundable",
  "refundable_hold",
  "uncancelled",
  "irreversible",
  "failover",
  "expiresAt",
  "successful",
  "delivered",
  "complete",
  "",
];

describe("an unknown status passes through and is counted nowhere", () => {
  it.each(UNKNOWN)("%j", (status) => {
    expect(classifyProviderStatus(status).kind).toBe("unknown");
    expect(isFailureStatus(status)).toBe(false);
    expect(terminalStatusOf(status)).toBeNull();
    expect(statusForClients(status)).toBe(status);
    expect(billStatusForClients(status)).toBe(status);
  });

  it("treats a missing status as unknown", () => {
    expect(classifyProviderStatus(null).kind).toBe("unknown");
    expect(classifyProviderStatus(undefined).kind).toBe("unknown");
    expect(isFailureStatus(null)).toBe(false);
    expect(isFailureStatus(undefined)).toBe(false);
  });
});

describe("classifyProviderStatus", () => {
  it("matches whole words only", () => {
    expect(classifyProviderStatus("refunded")).toEqual({
      kind: "ended",
      endings: ["refunded"],
    });
    expect(classifyProviderStatus("nonrefundable").kind).toBe("unknown");
  });

  it("lets a still-moving word win over any ending beside it", () => {
    expect(classifyProviderStatus("failed_pending").kind).toBe("moving");
    expect(classifyProviderStatus("pending: refund failed").kind).toBe(
      "moving",
    );
  });

  it("reports every ending a status names, in the order it names them", () => {
    expect(classifyProviderStatus("timeout: payout never completed")).toEqual({
      kind: "ended",
      endings: ["timeout", "completed"],
    });
  });
});
