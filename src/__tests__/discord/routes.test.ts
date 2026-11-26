/**
 * The two Discord routes, end to end over HTTP, with real signatures.
 *
 * The database is a small in-memory stand-in and the chain is mocked, because
 * what is under test is the order of the checks: who is refused, what a
 * refusal costs, and that a wallet can only ever sit on one member.
 */
import { generateKeyPairSync, sign } from "crypto";

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

import { assertion, newPasskey } from "./helpers";

interface CodeRow {
  code: string;
  discordUserId: string;
  discordUsername: string;
  expiresAt: Date;
  usedAt: Date | null;
  attempts: number;
  interactionToken?: string | null;
}
interface MemberRow {
  discordUserId: string;
  wallet: string | null;
  spending: string | null;
  names: string[];
  [key: string]: unknown;
}

const codes = new Map<string, CodeRow>();
const members = new Map<string, MemberRow>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakePrisma: Record<string, any> = {
  discordLinkCode: {
    deleteMany: jest.fn(async ({ where }: { where: { OR: Array<Record<string, unknown>> } }) => {
      const userId = where.OR[0].discordUserId;
      for (const [code, row] of codes) if (row.discordUserId === userId && !row.usedAt) codes.delete(code);
    }),
    create: jest.fn(async ({ data }: { data: CodeRow }) => {
      codes.set(data.code, { ...data, usedAt: null, attempts: 0 });
    }),
    findUnique: jest.fn(async ({ where }: { where: { code: string } }) => codes.get(where.code) ?? null),
    update: jest.fn(async ({ where }: { where: { code: string } }) => {
      codes.get(where.code)!.attempts += 1;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { code: string }; data: { usedAt: Date } }) => {
      const row = codes.get(where.code);
      if (!row || row.usedAt) return { count: 0 };
      row.usedAt = data.usedAt;
      return { count: 1 };
    }),
  },
  discordMember: {
    findMany: jest.fn(async ({ where }: { where: { discordUserId: { not: string }; OR: Array<Partial<MemberRow>> } }) =>
      [...members.values()].filter(
        (row) =>
          row.discordUserId !== where.discordUserId.not &&
          where.OR.some((clause) =>
            Object.entries(clause).every(([key, value]) => row[key] === value),
          ),
      ),
    ),
    update: jest.fn(async ({ where, data }: { where: { discordUserId: string }; data: Partial<MemberRow> }) => {
      Object.assign(members.get(where.discordUserId)!, data);
    }),
    upsert: jest.fn(async ({ where, create, update }: { where: { discordUserId: string }; create: MemberRow; update: Partial<MemberRow> }) => {
      const existing = members.get(where.discordUserId);
      if (existing) Object.assign(existing, update);
      else members.set(where.discordUserId, { ...create });
    }),
    findUnique: jest.fn(async ({ where }: { where: { discordUserId: string } }) => members.get(where.discordUserId) ?? null),
    findUniqueOrThrow: jest.fn(async ({ where }: { where: { discordUserId: string } }) => {
      const row = members.get(where.discordUserId);
      if (!row) throw new Error("not found");
      return row;
    }),
  },
  $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(fakePrisma)),
};

jest.mock("../../db", () => ({ prisma: fakePrisma }));

const chain = {
  isVeilWallet: jest.fn(),
  walletSigners: jest.fn(),
};
jest.mock("../../discord/chain", () => ({
  ...jest.requireActual("../../discord/chain"),
  isVeilWallet: (...args: unknown[]) => chain.isVeilWallet(...args),
  walletSigners: (...args: unknown[]) => chain.walletSigners(...args),
}));

const editInteractionReply = jest.fn();
jest.mock("../../discord/discordApi", () => ({
  ...jest.requireActual("../../discord/discordApi"),
  editInteractionReply: (...args: unknown[]) => editInteractionReply(...args),
}));

const syncMember = jest.fn();
jest.mock("../../discord/sync", () => ({
  syncMember: (...args: unknown[]) => syncMember(...args),
  clearRoles: jest.fn(),
}));

import { createDiscordInteractionsRouter } from "../../discord/interactions";
import { createDiscordLinkRouter, createLinkCode } from "../../discord/link";
import { linkChallenge } from "../../discord/proof";

const WALLET = "CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN";
const GUILD = "111111111111111111";
const USER = "222222222222222222";

const discordKey = generateKeyPairSync("ed25519");
const discordPublicHex = discordKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

function app() {
  const server = express();
  server.use("/discord/interactions", createDiscordInteractionsRouter());
  server.use(express.json());
  server.use("/discord", createDiscordLinkRouter());
  return server;
}

function configure() {
  process.env.DISCORD_APPLICATION_ID = "333333333333333333";
  process.env.DISCORD_PUBLIC_KEY = discordPublicHex;
  process.env.DISCORD_BOT_TOKEN = "test-token";
  process.env.DISCORD_GUILD_ID = GUILD;
}

function b64(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** A complete, correctly signed link request for a fresh code. */
async function signedRequest(overrides: { userId?: string; signWith?: ReturnType<typeof newPasskey> } = {}) {
  const userId = overrides.userId ?? USER;
  const passkey = newPasskey();
  const spending = Keypair.random();
  const code = await createLinkCode(userId, "ada");
  const challenge = linkChallenge({ code, discordUserId: userId, wallet: WALLET, spending: spending.publicKey() });
  const proof = assertion(overrides.signWith ?? passkey, challenge);
  return {
    passkey,
    code,
    body: {
      code,
      wallet: WALLET,
      spending: spending.publicKey(),
      passkey: {
        publicKey: b64(proof.publicKey),
        authData: b64(proof.authData),
        clientDataJSON: b64(proof.clientDataJSON),
        signature: b64(proof.signature),
      },
      spendingSignature: b64(spending.sign(challenge)),
      names: ["Ada", "not a name!", "ada"],
    },
  };
}

beforeEach(() => {
  codes.clear();
  members.clear();
  jest.clearAllMocks();
  configure();
  chain.isVeilWallet.mockResolvedValue(true);
  syncMember.mockResolvedValue({ granted: ["Veil Wallet"], incomplete: false, inServer: true });
  editInteractionReply.mockResolvedValue(undefined);
});

afterAll(() => {
  for (const name of ["DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID"]) {
    delete process.env[name];
  }
});

describe("POST /discord/link", () => {
  it("answers 503 when the bot is not configured", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    const response = await request(app()).post("/discord/link").send({});
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("discord_not_configured");
  });

  it("links a wallet whose own keys signed, and sets the roles", async () => {
    const { passkey, code, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);

    const response = await request(app()).post("/discord/link").send(body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      linked: true,
      discordUsername: "ada",
      roles: ["Veil Wallet"],
      incomplete: false,
      inServer: true,
    });
    expect(members.get(USER)).toMatchObject({ wallet: WALLET, spending: body.spending, names: ["ada"] });
    expect(codes.get(code)?.usedAt).toBeInstanceOf(Date);
    expect(syncMember).toHaveBeenCalledTimes(1);
  });

  it("never returns the wallet address", async () => {
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    const response = await request(app()).post("/discord/link").send(body);
    expect(JSON.stringify(response.body)).not.toContain(WALLET);
  });

  it("refuses a code that was already used", async () => {
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    await request(app()).post("/discord/link").send(body);
    const again = await request(app()).post("/discord/link").send(body);
    expect(again.status).toBe(410);
    expect(again.body.code).toBe("code_invalid");
  });

  it("refuses a valid signature from a passkey the wallet does not list", async () => {
    const { code, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([newPasskey().publicKey.toString("hex")]);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("not_a_signer");
    expect(members.size).toBe(0);
    expect(codes.get(code)?.attempts).toBe(1);
  });

  it("refuses an address that is not a Veil wallet", async () => {
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    chain.isVeilWallet.mockResolvedValue(false);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("not_veil_wallet");
    expect(members.size).toBe(0);
  });

  it("refuses a signature made over another member's code", async () => {
    const mine = await signedRequest();
    const theirs = await signedRequest({ userId: "999999999999999999" });
    chain.walletSigners.mockResolvedValue([mine.passkey.publicKey.toString("hex")]);
    const response = await request(app())
      .post("/discord/link")
      .send({ ...mine.body, code: theirs.code });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("proof_failed");
  });

  it("refuses when the spending account did not sign", async () => {
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    const response = await request(app())
      .post("/discord/link")
      .send({ ...body, spendingSignature: b64(Keypair.random().sign(Buffer.alloc(32))) });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("spending_proof_failed");
  });

  it("says it is not a Veil wallet even when its signer list cannot be read", async () => {
    // A contract that is not a Veil wallet has no signer list. Answering
    // "try again in a moment" would have its owner trying forever.
    const { body } = await signedRequest();
    chain.isVeilWallet.mockResolvedValue(false);
    chain.walletSigners.mockResolvedValue(null);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("not_veil_wallet");
  });

  it("does not call a wallet the network cannot find 'not made by Veil'", async () => {
    const { code, body } = await signedRequest();
    chain.isVeilWallet.mockResolvedValue("missing");
    chain.walletSigners.mockResolvedValue(null);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("wallet_not_found");
    expect(codes.get(code)?.attempts).toBe(0);
    expect(members.size).toBe(0);
  });

  it("does not charge the code an attempt when the chain cannot be read", async () => {
    const { code, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue(null);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(503);
    expect(codes.get(code)?.attempts).toBe(0);
    expect(members.size).toBe(0);
  });

  it("retires a code after five failed proofs", async () => {
    const { body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([]);
    for (let i = 0; i < 5; i += 1) await request(app()).post("/discord/link").send(body);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(410);
  });

  it("moves a wallet to the member who proved it last", async () => {
    members.set("444444444444444444", { discordUserId: "444444444444444444", wallet: WALLET, spending: null, names: ["old"] });
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(200);
    expect(members.get("444444444444444444")).toMatchObject({ wallet: null, names: [] });
    expect(members.get(USER)?.wallet).toBe(WALLET);
  });

  it("turns the member's Discord message into the result", async () => {
    const { passkey, code, body } = await signedRequest();
    codes.get(code)!.interactionToken = "interaction-token";
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);

    await request(app()).post("/discord/link").send(body);

    expect(editInteractionReply).toHaveBeenCalledTimes(1);
    const [, token, message] = editInteractionReply.mock.calls[0];
    expect(token).toBe("interaction-token");
    expect(message.content).toBe("**Wallet linked.**\nYour roles: **Veil Wallet**.");
    // The button that has done its job is taken away.
    expect(message.components).toEqual([]);
  });

  it("links all the same when Discord will not take the message edit", async () => {
    const { passkey, code, body } = await signedRequest();
    codes.get(code)!.interactionToken = "interaction-token";
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    editInteractionReply.mockRejectedValue(new Error("token expired"));
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(200);
    expect(members.get(USER)?.wallet).toBe(WALLET);
  });

  it("does not try to edit a message for a failed proof", async () => {
    const { code, body } = await signedRequest();
    codes.get(code)!.interactionToken = "interaction-token";
    chain.walletSigners.mockResolvedValue([]);
    await request(app()).post("/discord/link").send(body);
    expect(editInteractionReply).not.toHaveBeenCalled();
  });

  it("still reports the link when setting roles fails", async () => {
    const { passkey, body } = await signedRequest();
    chain.walletSigners.mockResolvedValue([passkey.publicKey.toString("hex")]);
    syncMember.mockRejectedValue(new Error("discord down"));
    const response = await request(app()).post("/discord/link").send(body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ linked: true, roles: [], incomplete: true });
  });
});

describe("GET /discord/link/:code", () => {
  it("says whose code it is, typed the way a person types it", async () => {
    const code = await createLinkCode(USER, "ada");
    const response = await request(app()).get(`/discord/link/${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ discordUserId: USER, discordUsername: "ada" });
  });

  it("answers 410 for an unknown or expired code", async () => {
    expect((await request(app()).get("/discord/link/ZZZZ9999")).status).toBe(410);
    const code = await createLinkCode(USER, "ada");
    codes.get(code)!.expiresAt = new Date(Date.now() - 1000);
    expect((await request(app()).get(`/discord/link/${code}`)).status).toBe(410);
  });
});

describe("POST /discord/interactions", () => {
  function signed(payload: unknown, key = discordKey.privateKey) {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), key).toString("hex");
    return request(app())
      .post("/discord/interactions")
      .set("Content-Type", "application/json")
      .set("X-Signature-Ed25519", signature)
      .set("X-Signature-Timestamp", timestamp)
      .send(body);
  }

  it("refuses a request Discord did not sign", async () => {
    const response = await signed({ type: 1 }, generateKeyPairSync("ed25519").privateKey);
    expect(response.status).toBe(401);
  });

  it("refuses a request with no signature at all", async () => {
    const response = await request(app()).post("/discord/interactions").send({ type: 1 });
    expect(response.status).toBe(401);
  });

  it("answers Discord's ping", async () => {
    const response = await signed({ type: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 1 });
  });

  it("gives a member a private code and a link when they verify", async () => {
    const response = await signed({
      type: 3,
      token: "interaction-token",
      guild_id: GUILD,
      data: { custom_id: "veil:verify" },
      member: { user: { id: USER, username: "ada" } },
    });
    expect(response.status).toBe(200);
    expect(response.body.type).toBe(4);
    expect(response.body.data.flags).toBe(64);
    const [code] = [...codes.keys()];
    expect(codes.get(code)).toMatchObject({
      discordUserId: USER,
      discordUsername: "ada",
      interactionToken: "interaction-token",
    });
    expect(response.body.data.content).toContain(`${code.slice(0, 4)}-${code.slice(4)}`);
    expect(response.body.data.components[0].components[0].url).toBe(
      `https://app.useveilapp.xyz/link-discord?code=${code}`,
    );
  });

  it("does nothing for a command sent from another server", async () => {
    const response = await signed({
      type: 2,
      token: "t",
      guild_id: "555555555555555555",
      data: { name: "verify" },
      member: { user: { id: USER, username: "ada" } },
    });
    expect(response.body.data.content).toContain("inside the Veil server");
    expect(codes.size).toBe(0);
  });
});
