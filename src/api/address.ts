/**
 * Stellar address checks shared by the money rails.
 *
 * Both `/ngn` and `/offramp` name an address the provider has to be able to pay
 * to — a delivery on the onramp, a refund when a bill or cash-out fails after
 * the user has paid. One copy of the check lives here so the two routers cannot
 * drift: the copy that drifts is discovered at the moment the money is already
 * gone.
 */

import type { Response } from "express";
import { sendError } from "./errors";

/** A classic `G…` account, which is what the provider pays to and refunds to. */
export function isClassicAddress(value: unknown): value is string {
  return typeof value === "string" && /^G[A-Z2-7]{55}$/.test(value);
}

/**
 * Refuse an address the provider cannot pay to.
 *
 * A `C…` address is called out by name because it is the mistake this exists to
 * catch: a Veil smart-wallet address is a contract, and the provider pays by
 * classic operation, which cannot name a contract as its destination. Getting
 * this wrong on a refund is worse than on a delivery — it fails at the moment
 * the user has already paid and been told their money is coming back.
 *
 * Returns true when it has already answered, in the style of the other
 * `reject*` helpers.
 */
export function rejectContractAddress(res: Response, address: unknown, field: string): boolean {
  if (typeof address === "string" && address.startsWith("C")) {
    sendError(
      res,
      400,
      "invalid_address",
      `${field} must be the classic account, not the smart-wallet contract. Linq pays by classic operation, which cannot name a contract as its destination.`,
    );
    return true;
  }
  if (!isClassicAddress(address)) {
    sendError(res, 400, "invalid_address", `${field} must be a valid Stellar account address`);
    return true;
  }
  return false;
}
