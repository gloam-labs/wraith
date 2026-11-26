/**
 * The route Discord calls when a member uses a command or presses a button.
 *
 * MUST be mounted before `express.json()`. Discord signs the raw request body,
 * so this router brings its own `express.raw()`, exactly like the Linq
 * webhook. An unsigned or wrongly signed request is answered 401 and nothing
 * else happens; Discord itself probes the endpoint with bad signatures and
 * removes it if they are accepted.
 *
 * Every reply to a member is ephemeral (only they can see it). A wallet
 * address is never written into the server, by the bot or about anyone.
 *
 * Discord allows three seconds to answer. Anything that reads the chain or
 * GitHub answers "working on it" at once and fills in the result afterwards.
 */

import express, { Request, Response, Router } from "express";

import { prisma } from "../db";
import { logger } from "../logger";
import { discordConfig, githubClientId, linkPageUrl, type DiscordConfig } from "./config";
import { editInteractionReply, verifyInteractionSignature } from "./discordApi";
import { finishDeviceFlow, startDeviceFlow } from "./github";
import { CODE_TTL_MS, createLinkCode, unlinkMember } from "./link";
import { syncMember } from "./sync";

const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

const PONG = 1;
const MESSAGE = 4;
const DEFERRED_MESSAGE = 5;

const EPHEMERAL = 64;
const BUTTON_ROW = 1;
const BUTTON = 2;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;
const STYLE_LINK = 5;

const NEVER_ASKED =
  "Veil will never DM you first, and will never ask for a key, a recovery code or a payment.";

type Reply = Record<string, unknown>;

function ephemeral(content: string, components?: unknown[]): Reply {
  return { content, flags: EPHEMERAL, ...(components ? { components } : {}) };
}

function button(label: string, customId: string, style = STYLE_PRIMARY): Reply {
  return { type: BUTTON, style, label, custom_id: customId };
}

function linkButton(label: string, url: string): Reply {
  return { type: BUTTON, style: STYLE_LINK, label, url };
}

function row(...components: Reply[]): Reply {
  return { type: BUTTON_ROW, components };
}

interface Interaction {
  type?: number;
  token?: string;
  guild_id?: string;
  data?: { name?: string; custom_id?: string };
  member?: { user?: { id?: string; username?: string; global_name?: string | null } };
}

/** The public message with the three buttons, posted once by an admin. */
function panel(): Reply {
  return {
    content: [
      "**Get your Veil roles**",
      "",
      "• **Verify wallet**: prove a Veil wallet is yours with your fingerprint. Nothing is sent and nothing is spent.",
      "• **Connect GitHub**: get a contributor role for merged pull requests.",
      "• **Refresh roles**: check again now. Everyone is also re-checked once a day.",
      "",
      NEVER_ASKED,
    ].join("\n"),
    components: [
      row(
        button("Verify wallet", "veil:verify"),
        button("Connect GitHub", "veil:github", STYLE_SECONDARY),
        button("Refresh roles", "veil:refresh", STYLE_SECONDARY),
      ),
    ],
  };
}

async function verifyReply(userId: string, username: string, token: string): Promise<Reply> {
  const code = await createLinkCode(userId, username, token);
  const minutes = Math.round(CODE_TTL_MS / 60_000);
  return ephemeral(
    [
      "**Link your Veil wallet**",
      "",
      "1. Tap the button below on the device that has your Veil wallet.",
      "2. Check that it shows your Discord name, then approve with your fingerprint.",
      "",
      `If the Veil app does not open, go to **Settings → Link Discord** in the app and type this code: \`${code.slice(0, 4)}-${code.slice(4)}\``,
      "",
      `The code works once and lasts ${minutes} minutes. ${NEVER_ASKED}`,
    ].join("\n"),
    [row(linkButton("Open Veil", linkPageUrl(code)))],
  );
}

async function githubReply(userId: string): Promise<Reply> {
  if (!githubClientId()) return ephemeral("GitHub connection is not set up on this server yet.");
  const device = await startDeviceFlow();
  if (!device) return ephemeral("GitHub did not answer. Try again in a moment.");
  const expiresAt = new Date(Date.now() + device.expiresInSeconds * 1000);
  await prisma.discordGithubRequest.upsert({
    where: { discordUserId: userId },
    create: { discordUserId: userId, deviceCode: device.deviceCode, expiresAt },
    update: { deviceCode: device.deviceCode, expiresAt },
  });
  return ephemeral(
    [
      "**Connect GitHub**",
      "",
      `1. Open GitHub with the button below and enter this code: \`${device.userCode}\``,
      "2. Approve, then come back here and press **I've approved it**.",
      "",
      "This only tells us which GitHub account is yours. It gives no access to your repositories.",
    ].join("\n"),
    [row(linkButton("Open GitHub", device.verificationUri), button("I've approved it", "veil:github-done"))],
  );
}

function rolesLine(granted: string[], incomplete: boolean): string {
  const list = granted.length > 0 ? `Your roles: **${granted.join("**, **")}**.` : "You have no Veil roles yet.";
  return incomplete ? `${list}\nSome checks could not be finished just now; they will be tried again.` : list;
}

async function refreshText(config: DiscordConfig, userId: string): Promise<string> {
  const member = await prisma.discordMember.findUnique({ where: { discordUserId: userId } });
  if (!member) return "Nothing is linked yet. Press **Verify wallet** or **Connect GitHub** first.";
  const result = await syncMember(config, member);
  return rolesLine(result.granted, result.incomplete);
}

async function githubDoneText(config: DiscordConfig, userId: string): Promise<string> {
  const pending = await prisma.discordGithubRequest.findUnique({ where: { discordUserId: userId } });
  if (!pending || pending.expiresAt.getTime() <= Date.now()) {
    return "That GitHub request has run out. Press **Connect GitHub** to start again.";
  }
  const outcome = await finishDeviceFlow(pending.deviceCode);
  if (outcome.status === "pending") {
    return "GitHub has not seen your approval yet. Enter the code on GitHub, approve, then press the button again.";
  }
  if (outcome.status === "expired") {
    await prisma.discordGithubRequest.deleteMany({ where: { discordUserId: userId } });
    return "That GitHub request was cancelled or ran out. Press **Connect GitHub** to start again.";
  }
  if (outcome.status === "failed") return "GitHub did not answer. Try the button again in a moment.";

  // A GitHub account belongs to one member: connecting it here takes it off
  // whoever had it before.
  const displaced = await prisma.discordMember.findMany({
    where: { githubId: outcome.id, discordUserId: { not: userId } },
  });
  await prisma.$transaction([
    prisma.discordMember.updateMany({
      where: { githubId: outcome.id, discordUserId: { not: userId } },
      data: { githubId: null, githubLogin: null },
    }),
    prisma.discordMember.upsert({
      where: { discordUserId: userId },
      create: { discordUserId: userId, githubId: outcome.id, githubLogin: outcome.login },
      update: { githubId: outcome.id, githubLogin: outcome.login },
    }),
    prisma.discordGithubRequest.deleteMany({ where: { discordUserId: userId } }),
  ]);
  for (const other of displaced) {
    void syncMember(config, { ...other, githubId: null, githubLogin: null }).catch(() => undefined);
  }

  const member = await prisma.discordMember.findUniqueOrThrow({ where: { discordUserId: userId } });
  const result = await syncMember(config, member);
  return `Connected GitHub account **${outcome.login}**.\n${rolesLine(result.granted, result.incomplete)}`;
}

/**
 * How long a member is left looking at "VEIL is thinking…" before they are
 * told something. The work carries on behind the message either way.
 */
export const DEFERRED_DEADLINE_MS = 45_000;

const STILL_WORKING =
  "This is taking longer than usual. Your request is still being worked on: press **Refresh roles** in a minute to see the result.";

/**
 * Answer now with a placeholder, then replace it when the work is done.
 *
 * The placeholder is always replaced. Members were left on "VEIL is
 * thinking…" with no end (2026-11-18) when a chain read behind it hung:
 * Discord shows that line until the bot says otherwise, and the bot was
 * waiting on something that never came back. So the work races a deadline,
 * and whichever finishes first writes the message.
 */
function deferred(
  config: DiscordConfig,
  res: Response,
  token: string,
  work: () => Promise<string>,
  deadlineMs = DEFERRED_DEADLINE_MS,
): void {
  res.json({ type: DEFERRED_MESSAGE, data: { flags: EPHEMERAL } });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(STILL_WORKING), deadlineMs);
    timer.unref();
  });
  const done = work()
    .catch((error) => {
      logger.warn("discord.interaction.failed", { reason: error instanceof Error ? error.name : "unknown" });
      return "Something went wrong on our side. Nothing was changed. Try again in a moment.";
    })
    .finally(() => clearTimeout(timer));

  const reply = (content: string) =>
    editInteractionReply(config, token, { content }).catch((error) => {
      logger.warn("discord.interaction.reply_failed", { reason: error instanceof Error ? error.message : "unknown" });
    });

  void Promise.race([done, deadline]).then(async (first) => {
    await reply(first);
    // When the deadline won, the real answer still replaces the holding
    // message once it arrives, for as long as Discord accepts edits.
    if (first === STILL_WORKING) await reply(await done);
  });
}

/** Test-only handle on the deferred helper. */
export const _deferred = deferred;

async function handle(config: DiscordConfig, interaction: Interaction, res: Response): Promise<void> {
  if (interaction.type === PING) {
    res.json({ type: PONG });
    return;
  }

  const user = interaction.member?.user;
  const token = interaction.token;
  if (interaction.guild_id !== config.guildId || !user?.id || !token) {
    res.json({ type: MESSAGE, data: ephemeral("Use this inside the Veil server.") });
    return;
  }
  const userId = user.id;
  const username = user.global_name || user.username || "your account";

  const action =
    interaction.type === APPLICATION_COMMAND
      ? interaction.data?.name
      : interaction.type === MESSAGE_COMPONENT
        ? interaction.data?.custom_id?.replace(/^veil:/, "")
        : undefined;

  switch (action) {
    case "veil-panel":
      res.json({ type: MESSAGE, data: panel() });
      return;
    case "verify":
      res.json({ type: MESSAGE, data: await verifyReply(userId, username, token) });
      return;
    case "github":
      res.json({ type: MESSAGE, data: await githubReply(userId) });
      return;
    case "github-done":
      deferred(config, res, token, () => githubDoneText(config, userId));
      return;
    case "refresh":
      deferred(config, res, token, () => refreshText(config, userId));
      return;
    case "unlink":
      deferred(config, res, token, async () => {
        await unlinkMember(config, userId);
        return "Your wallet and GitHub account are no longer linked here, and your Veil roles have been removed.";
      });
      return;
    default:
      res.json({ type: MESSAGE, data: ephemeral("That is not something this bot knows how to do.") });
  }
}

export function createDiscordInteractionsRouter(): Router {
  const router = Router();

  router.post("/", express.raw({ type: "*/*", limit: "64kb" }), async (req: Request, res: Response) => {
    const config = discordConfig();
    if (!config) {
      res.status(503).json({ error: "Discord is not configured", code: "discord_not_configured" });
      return;
    }
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const signed = verifyInteractionSignature(
      config.publicKey,
      req.headers["x-signature-ed25519"],
      req.headers["x-signature-timestamp"],
      raw,
    );
    if (!signed) {
      res.status(401).json({ error: "invalid request signature" });
      return;
    }

    let interaction: Interaction;
    try {
      interaction = JSON.parse(raw.toString("utf8")) as Interaction;
    } catch {
      res.status(400).json({ error: "unreadable interaction" });
      return;
    }

    try {
      await handle(config, interaction, res);
    } catch (error) {
      logger.warn("discord.interaction.failed", { reason: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) {
        res.json({ type: MESSAGE, data: ephemeral("Something went wrong on our side. Try again in a moment.") });
      }
    }
  });

  return router;
}
