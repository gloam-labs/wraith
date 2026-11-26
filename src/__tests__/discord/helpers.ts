/** Real keys and real signatures for the Discord link tests. Nothing here is mocked. */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "crypto";

export interface TestPasskey {
  privateKey: KeyObject;
  /** Uncompressed P-256 point: 0x04 ‖ x ‖ y. */
  publicKey: Buffer;
}

export function newPasskey(): TestPasskey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    publicKey: Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(jwk.x as string, "base64url"),
      Buffer.from(jwk.y as string, "base64url"),
    ]),
  };
}

export interface AssertionOptions {
  rpId?: string;
  flags?: number;
  type?: string;
  origin?: string;
}

/** What a passkey returns when asked to sign `challenge`. */
export function assertion(passkey: TestPasskey, challenge: Buffer, options: AssertionOptions = {}) {
  const authData = Buffer.concat([
    createHash("sha256").update(options.rpId ?? "app.useveilapp.xyz").digest(),
    Buffer.from([options.flags ?? 0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: options.type ?? "webauthn.get",
      challenge: challenge.toString("base64url"),
      origin: options.origin ?? "android:apk-key-hash:test",
    }),
  );
  const signed = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
  const signature = sign("sha256", signed, { key: passkey.privateKey, dsaEncoding: "ieee-p1363" });
  return { publicKey: passkey.publicKey, authData, clientDataJSON, signature };
}
