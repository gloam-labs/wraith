/**
 * The proof is the only thing between "I pasted an address" and "this wallet
 * is mine", so these tests pin every way it must fail.
 */
import { createHash } from "crypto";

import { Keypair } from "@stellar/stellar-sdk";

import {
  isLinkCode,
  linkChallenge,
  linkStatement,
  newLinkCode,
  normalizeLinkCode,
  verifyPasskeyProof,
  verifySpendingProof,
} from "../../discord/proof";
import { assertion, newPasskey } from "./helpers";

const RP = "app.useveilapp.xyz";
const FIELDS = {
  code: "ABCD2345",
  discordUserId: "123456789012345678",
  wallet: "CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN",
  spending: null,
};

describe("the link statement", () => {
  it("is the exact text the apps build, line for line", () => {
    expect(linkStatement(FIELDS)).toBe(
      "veil-discord-link:v1\ncode=ABCD2345\ndiscord=123456789012345678\n" +
        "wallet=CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN\nspending=",
    );
  });

  it("hashes to 32 bytes, and differently for a different member", () => {
    const mine = linkChallenge(FIELDS);
    expect(mine).toHaveLength(32);
    expect(mine.equals(createHash("sha256").update(linkStatement(FIELDS)).digest())).toBe(true);
    expect(mine.equals(linkChallenge({ ...FIELDS, discordUserId: "999" }))).toBe(false);
  });
});

describe("a passkey proof", () => {
  const passkey = newPasskey();
  const challenge = linkChallenge(FIELDS);

  it("is accepted when the wallet's passkey signed this statement", () => {
    expect(verifyPasskeyProof(assertion(passkey, challenge), challenge, RP)).toEqual({ ok: true });
  });

  it("is accepted from the web wallet's origin too", () => {
    const proof = assertion(passkey, challenge, { origin: "https://app.useveilapp.xyz" });
    expect(verifyPasskeyProof(proof, challenge, RP)).toEqual({ ok: true });
  });

  it("is refused when it signed a different code", () => {
    const other = linkChallenge({ ...FIELDS, code: "ZZZZ9999" });
    expect(verifyPasskeyProof(assertion(passkey, other), challenge, RP)).toEqual({
      ok: false,
      reason: "wrong_challenge",
    });
  });

  it("is refused when the public key is somebody else's", () => {
    const proof = { ...assertion(passkey, challenge), publicKey: newPasskey().publicKey };
    expect(verifyPasskeyProof(proof, challenge, RP)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is refused when the signed data was altered afterwards", () => {
    const proof = assertion(passkey, challenge);
    const authData = Buffer.from(proof.authData);
    authData[authData.length - 1] ^= 1;
    expect(verifyPasskeyProof({ ...proof, authData }, challenge, RP)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("is refused from a passkey bound to another site", () => {
    const proof = assertion(passkey, challenge, { rpId: "evil.example" });
    expect(verifyPasskeyProof(proof, challenge, RP)).toEqual({ ok: false, reason: "wrong_rp" });
  });

  it("is refused without the user's fingerprint or screen lock", () => {
    const proof = assertion(passkey, challenge, { flags: 0x01 });
    expect(verifyPasskeyProof(proof, challenge, RP)).toEqual({ ok: false, reason: "not_verified_by_user" });
  });

  it("is refused when it is a registration, not a signature", () => {
    const proof = assertion(passkey, challenge, { type: "webauthn.create" });
    expect(verifyPasskeyProof(proof, challenge, RP)).toEqual({ ok: false, reason: "wrong_type" });
  });

  it("is refused, not thrown on, when the pieces are the wrong shape", () => {
    const proof = assertion(passkey, challenge);
    for (const broken of [
      { ...proof, publicKey: proof.publicKey.subarray(1) },
      { ...proof, signature: Buffer.alloc(10) },
      { ...proof, authData: Buffer.alloc(5) },
      { ...proof, clientDataJSON: Buffer.from("not json") },
      { ...proof, publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]) },
    ]) {
      expect(verifyPasskeyProof(broken, challenge, RP).ok).toBe(false);
    }
  });
});

describe("a spending account proof", () => {
  const keypair = Keypair.random();
  const challenge = linkChallenge({ ...FIELDS, spending: keypair.publicKey() });

  it("is accepted when the account's own key signed", () => {
    expect(verifySpendingProof(keypair.publicKey(), keypair.sign(challenge), challenge)).toBe(true);
  });

  it("is refused for another account's signature, a bad address or a short signature", () => {
    const stranger = Keypair.random();
    expect(verifySpendingProof(keypair.publicKey(), stranger.sign(challenge), challenge)).toBe(false);
    expect(verifySpendingProof("not-an-address", keypair.sign(challenge), challenge)).toBe(false);
    expect(verifySpendingProof(keypair.publicKey(), Buffer.alloc(12), challenge)).toBe(false);
  });
});

describe("link codes", () => {
  it("are eight characters from an alphabet with no look-alikes", () => {
    const code = newLinkCode((max) => max - 1);
    expect(code).toHaveLength(8);
    expect(isLinkCode(code)).toBe(true);
    expect(isLinkCode("ABCD0123")).toBe(false); // 0 and 1 are left out
  });

  it("are read the way a person types them", () => {
    expect(normalizeLinkCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeLinkCode(" abcd 2345 ")).toBe("ABCD2345");
    expect(normalizeLinkCode("abc")).toBeNull();
    expect(normalizeLinkCode(42)).toBeNull();
  });
});
