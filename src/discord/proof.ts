/**
 * Proof that a wallet belongs to the person asking for roles.
 *
 * Pasting an address proves nothing: every address is public. So the member's
 * own keys sign one short statement, and this file checks the signatures.
 *
 *   - The smart wallet (`C…`) is signed for by its passkey. The public key in
 *     the proof must be one the wallet contract lists as a signer; that part
 *     is checked against the chain by the caller, not here.
 *   - The spending account (`G…`) signs with its own Ed25519 key.
 *
 * WHAT IS SIGNED. Not a value the server picks. A passkey signature over 32
 * bytes of the server's choosing would be a blank cheque: the same passkey
 * authorises payments by signing a 32-byte Soroban payload hash, and a server
 * (or anyone who got into it) could hand over exactly such a hash and call it
 * a "Discord code". Instead both sides build the text in {@link linkStatement}
 * and sign its SHA-256. The text starts with a fixed label, so its hash cannot
 * be made to equal the hash of a transaction payload, and the app can show the
 * member every field in it before they approve.
 */

import { createHash, createPublicKey, verify } from "crypto";

import { Keypair, StrKey } from "@stellar/stellar-sdk";

export interface LinkStatementFields {
  code: string;
  discordUserId: string;
  /** The smart wallet, or null when only a spending account is linked. */
  wallet: string | null;
  /** The spending account, or null when only a smart wallet is linked. */
  spending: string | null;
}

/**
 * The exact text both sides hash. Field order and line endings are part of the
 * protocol: the mobile app and the web wallet build the same string, and any
 * change here needs the same change there and a new version label.
 */
export function linkStatement(fields: LinkStatementFields): string {
  return [
    "veil-discord-link:v1",
    `code=${fields.code}`,
    `discord=${fields.discordUserId}`,
    `wallet=${fields.wallet ?? ""}`,
    `spending=${fields.spending ?? ""}`,
  ].join("\n");
}

export function linkChallenge(fields: LinkStatementFields): Buffer {
  return createHash("sha256").update(linkStatement(fields), "utf8").digest();
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** DER header that turns a raw 65-byte P-256 point into a key Node can load. */
const P256_SPKI_PREFIX = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");

export interface PasskeyProof {
  /** Uncompressed P-256 point, 65 bytes: 0x04 ‖ x ‖ y. */
  publicKey: Buffer;
  authData: Buffer;
  clientDataJSON: Buffer;
  /** Raw 64-byte r ‖ s. */
  signature: Buffer;
}

export type ProofFailure =
  | "malformed"
  | "wrong_type"
  | "wrong_challenge"
  | "wrong_rp"
  | "not_verified_by_user"
  | "bad_signature";

export type ProofResult = { ok: true } | { ok: false; reason: ProofFailure };

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * Check one passkey assertion against the statement hash.
 *
 * The origin in `clientDataJSON` is deliberately not compared. It differs by
 * client (the Android app reports its signing certificate, the web wallet its
 * https origin) and nothing here depends on which one it was: the relying
 * party id is what binds a passkey to Veil, and that is checked.
 */
export function verifyPasskeyProof(proof: PasskeyProof, challenge: Buffer, rpId: string): ProofResult {
  if (
    proof.publicKey.length !== 65 ||
    proof.publicKey[0] !== 0x04 ||
    proof.signature.length !== 64 ||
    proof.authData.length < 37 ||
    proof.clientDataJSON.length === 0 ||
    proof.clientDataJSON.length > 4096
  ) {
    return { ok: false, reason: "malformed" };
  }

  let clientData: { type?: unknown; challenge?: unknown };
  try {
    clientData = JSON.parse(proof.clientDataJSON.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (clientData.type !== "webauthn.get") return { ok: false, reason: "wrong_type" };
  if (clientData.challenge !== base64Url(challenge)) return { ok: false, reason: "wrong_challenge" };

  const rpIdHash = createHash("sha256").update(rpId, "utf8").digest();
  if (!proof.authData.subarray(0, 32).equals(rpIdHash)) return { ok: false, reason: "wrong_rp" };

  const flags = proof.authData[32];
  if ((flags & FLAG_USER_PRESENT) === 0 || (flags & FLAG_USER_VERIFIED) === 0) {
    return { ok: false, reason: "not_verified_by_user" };
  }

  const signed = Buffer.concat([
    proof.authData,
    createHash("sha256").update(proof.clientDataJSON).digest(),
  ]);
  try {
    const key = createPublicKey({
      key: Buffer.concat([P256_SPKI_PREFIX, proof.publicKey]),
      format: "der",
      type: "spki",
    });
    const valid = verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, proof.signature);
    return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Check the spending account's Ed25519 signature over the statement hash. */
export function verifySpendingProof(address: string, signature: Buffer, challenge: Buffer): boolean {
  if (!StrKey.isValidEd25519PublicKey(address) || signature.length !== 64) return false;
  try {
    return Keypair.fromPublicKey(address).verify(challenge, signature);
  } catch {
    return false;
  }
}

/** Letters and digits that cannot be mistaken for each other when typed. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

export function isLinkCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === CODE_LENGTH &&
    [...value].every((char) => CODE_ALPHABET.includes(char))
  );
}

/** Accept what a person types: lower case, spaces, a dash in the middle. */
export function normalizeLinkCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.toUpperCase().replace(/[\s-]/g, "");
  return isLinkCode(cleaned) ? cleaned : null;
}

export function newLinkCode(randomInt: (max: number) => number): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}
