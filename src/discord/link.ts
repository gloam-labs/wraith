/**
 * The routes the Veil app and the web wallet call to link a wallet.
 *
 *   GET  /discord/link/:code   who this code belongs to, so the app can show
 *                              "link this wallet to @name?" before signing
 *   POST /discord/link         the signed proof; on success the roles are set
 *
 * Neither route returns a wallet address, and neither can be used to ask
 * "which Discord account owns this wallet". The only way in is a fresh code a
 * member asked the bot for, and a signature made with the wallet's own keys.
 */

import { randomInt } from "crypto";
import { Router, Request, Response } from "express";

import { prisma } from "../db";
import { logger } from "../logger";
import { isAccountAddress, isContractAddress, isVeilWallet, walletSigners } from "./chain";
import { discordConfig, discordNetwork, passkeyRpId, type DiscordConfig } from "./config";
import { editInteractionReply } from "./discordApi";
import {
  linkChallenge,
  newLinkCode,
  normalizeLinkCode,
  verifyPasskeyProof,
  verifySpendingProof,
} from "./proof";
import { clearRoles, syncMember } from "./sync";

export const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_NAMES = 10;
const NAME_PATTERN = /^[a-z0-9_]{3,20}$/;

/** Make a code for this member, replacing any they have not used yet. */
export async function createLinkCode(
  discordUserId: string,
  discordUsername: string,
  interactionToken: string | null = null,
  now = Date.now(),
): Promise<string> {
  await prisma.discordLinkCode.deleteMany({
    where: { OR: [{ discordUserId, usedAt: null }, { expiresAt: { lt: new Date(now - 24 * 60 * 60 * 1000) } }] },
  });
  for (let tries = 0; tries < 5; tries += 1) {
    const code = newLinkCode(randomInt);
    try {
      await prisma.discordLinkCode.create({
        data: {
          code,
          discordUserId,
          discordUsername: discordUsername.slice(0, 64),
          expiresAt: new Date(now + CODE_TTL_MS),
          interactionToken,
        },
      });
      return code;
    } catch {
      // The code was already taken. Try another.
    }
  }
  throw new Error("could not allocate a link code");
}

function fromBase64Url(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value.replace(/=+$/, ""), "base64url");
  return bytes.length > 0 && bytes.length <= maxBytes ? bytes : null;
}

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => NAME_PATTERN.test(entry));
  return [...new Set(names)].slice(0, MAX_NAMES);
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code });
}

async function liveCode(raw: unknown, now: number) {
  const code = normalizeLinkCode(raw);
  if (!code) return null;
  const row = await prisma.discordLinkCode.findUnique({ where: { code } });
  if (!row || row.usedAt || row.expiresAt.getTime() <= now || row.attempts >= MAX_ATTEMPTS) return null;
  return row;
}

const CODE_GONE = "That code is not valid any more. Press Verify in Discord to get a new one.";

async function completeLink(config: DiscordConfig, req: Request, res: Response): Promise<void> {
  const now = Date.now();
  const body = (req.body ?? {}) as Record<string, unknown>;

  const row = await liveCode(body.code, now);
  if (!row) return fail(res, 410, "code_invalid", CODE_GONE);

  const wallet = body.wallet == null || body.wallet === "" ? null : body.wallet;
  const spending = body.spending == null || body.spending === "" ? null : body.spending;
  if (wallet === null && spending === null) {
    return fail(res, 400, "nothing_to_link", "Send a wallet address, a spending account, or both.");
  }
  if (wallet !== null && !isContractAddress(wallet)) {
    return fail(res, 400, "bad_wallet", "The wallet address is not a valid contract address.");
  }
  if (spending !== null && !isAccountAddress(spending)) {
    return fail(res, 400, "bad_spending", "The spending account is not a valid account address.");
  }

  const challenge = linkChallenge({ code: row.code, discordUserId: row.discordUserId, wallet, spending });

  // A failed proof costs the code one of its attempts; a chain we could not
  // read costs nothing, because that is not the member's doing.
  const refuse = async (code: string, message: string): Promise<void> => {
    await prisma.discordLinkCode.update({ where: { code: row.code }, data: { attempts: { increment: 1 } } });
    fail(res, 401, code, message);
  };

  if (wallet !== null) {
    const passkey = (body.passkey ?? {}) as Record<string, unknown>;
    const publicKey = fromBase64Url(passkey.publicKey, 65);
    const authData = fromBase64Url(passkey.authData, 1024);
    const clientDataJSON = fromBase64Url(passkey.clientDataJSON, 4096);
    const signature = fromBase64Url(passkey.signature, 64);
    if (!publicKey || !authData || !clientDataJSON || !signature) {
      return refuse("proof_missing", "The wallet's passkey signature is missing or unreadable.");
    }
    const checked = verifyPasskeyProof({ publicKey, authData, clientDataJSON, signature }, challenge, passkeyRpId());
    if (!checked.ok) {
      return refuse("proof_failed", "The passkey signature did not check out. Nothing was linked.");
    }

    const [veil, signers] = await Promise.all([isVeilWallet(wallet), walletSigners(wallet)]);
    // "Not a Veil wallet" is checked before "could not read": a contract that
    // is not a Veil wallet has no signer list to read, and telling its owner
    // to try again in a moment would have them trying forever.
    if (veil === false) {
      return refuse("not_veil_wallet", "That address is not a wallet made by Veil.");
    }
    if (veil === "missing") {
      logger.warn("discord.link.wallet_missing", {});
      return fail(
        res,
        409,
        "wallet_not_found",
        "The network has no record of this wallet right now. If it has not been used for a few months, make any small payment from it first, then try again.",
      );
    }
    if (veil === null || signers === null) {
      logger.warn("discord.link.chain_unreachable", { codeRead: veil !== null, signersRead: signers !== null });
      return fail(res, 503, "chain_unreachable", "The network could not be reached to check the wallet. Try again in a moment.");
    }
    if (!signers.includes(publicKey.toString("hex"))) {
      return refuse("not_a_signer", "That passkey is not one of this wallet's keys.");
    }
  }

  if (spending !== null) {
    const signature = fromBase64Url(body.spendingSignature, 64);
    if (!signature || !verifySpendingProof(spending, signature, challenge)) {
      return refuse("spending_proof_failed", "The spending account's signature did not check out. Nothing was linked.");
    }
  }

  const names = cleanNames(body.names);
  const discordUserId = row.discordUserId;

  // One step: spend the code, take these addresses off anyone else, and put
  // them on this member. Spending the code is conditional, so two requests
  // racing on one code cannot both win.
  const displaced = await prisma.$transaction(async (tx) => {
    const spent = await tx.discordLinkCode.updateMany({
      where: { code: row.code, usedAt: null },
      data: { usedAt: new Date(now), interactionToken: null },
    });
    if (spent.count !== 1) return null;

    const others = await tx.discordMember.findMany({
      where: {
        discordUserId: { not: discordUserId },
        OR: [...(wallet ? [{ wallet }] : []), ...(spending ? [{ spending }] : [])],
      },
      select: { discordUserId: true, wallet: true, spending: true },
    });
    for (const other of others) {
      await tx.discordMember.update({
        where: { discordUserId: other.discordUserId },
        data: {
          ...(wallet && other.wallet === wallet ? { wallet: null, nonceHistory: [] } : {}),
          ...(spending && other.spending === spending ? { spending: null, firstSeenAt: null } : {}),
          names: [],
        },
      });
    }

    const data = {
      network: discordNetwork(),
      wallet,
      spending,
      names,
      linkedAt: new Date(now),
      nonceHistory: [],
      firstSeenAt: null,
    };
    await tx.discordMember.upsert({
      where: { discordUserId },
      create: { discordUserId, ...data },
      update: data,
    });
    return others.map((other) => other.discordUserId);
  });
  if (displaced === null) return fail(res, 410, "code_invalid", CODE_GONE);

  const member = await prisma.discordMember.findUniqueOrThrow({ where: { discordUserId } });
  let roles: string[] = [];
  let incomplete = true;
  let inServer = true;
  try {
    const result = await syncMember(config, member, now);
    roles = result.granted;
    incomplete = result.incomplete;
    inServer = result.inServer;
  } catch (error) {
    // The link itself is saved; the roles will be set by the next check.
    logger.warn("discord.link.sync_failed", { reason: error instanceof Error ? error.name : "unknown" });
  }

  // Whoever held these addresses before no longer does. Bring them up to date.
  for (const otherId of displaced) {
    const other = await prisma.discordMember.findUnique({ where: { discordUserId: otherId } });
    if (other) void syncMember(config, other).catch(() => undefined);
  }

  // Turn the "tap to link" message in Discord into the result, so the member
  // is not left looking at a button that has already done its job. Best
  // effort: the link is saved whether or not Discord takes the edit.
  if (row.interactionToken) {
    const lines = [
      "**Wallet linked.**",
      roles.length > 0 ? `Your roles: **${roles.join("**, **")}**.` : "You have no Veil roles yet.",
      ...(incomplete ? ["Some checks could not be finished just now; they will be tried again."] : []),
    ];
    void editInteractionReply(config, row.interactionToken, { content: lines.join("\n"), components: [] }).catch(
      () => undefined,
    );
  }

  res.json({ linked: true, discordUsername: row.discordUsername, roles, incomplete, inServer });
}

export function createDiscordLinkRouter(): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next) => {
    if (!discordConfig()) {
      fail(res, 503, "discord_not_configured", "Discord linking is not switched on for this deployment.");
      return;
    }
    next();
  });

  router.get("/link/:code", async (req: Request, res: Response) => {
    try {
      const row = await liveCode(req.params.code, Date.now());
      if (!row) return fail(res, 410, "code_invalid", CODE_GONE);
      res.json({
        discordUserId: row.discordUserId,
        discordUsername: row.discordUsername,
        expiresAt: row.expiresAt.toISOString(),
      });
    } catch {
      fail(res, 500, "internal", "Could not look up that code.");
    }
  });

  router.post("/link", async (req: Request, res: Response) => {
    const config = discordConfig();
    if (!config) return fail(res, 503, "discord_not_configured", "Discord linking is not switched on for this deployment.");
    try {
      await completeLink(config, req, res);
    } catch (error) {
      logger.error("discord.link.failed", { reason: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) fail(res, 500, "internal", "Could not link the wallet. Nothing was changed.");
    }
  });

  return router;
}

/** Remove everything about a member and take the managed roles off them. */
export async function unlinkMember(config: DiscordConfig, discordUserId: string): Promise<void> {
  await prisma.$transaction([
    prisma.discordMember.deleteMany({ where: { discordUserId } }),
    prisma.discordLinkCode.deleteMany({ where: { discordUserId } }),
    prisma.discordGithubRequest.deleteMany({ where: { discordUserId } }),
  ]);
  await clearRoles(config, discordUserId);
}
