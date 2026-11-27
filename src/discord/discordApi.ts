/**
 * The few Discord REST calls the bot makes.
 *
 * Plain `fetch` against the HTTP API: the bot answers interactions over HTTP
 * and never holds a gateway connection, so it needs no Discord library and no
 * always-open socket.
 *
 * The bot token goes in one header, here, and nowhere else. It is never
 * logged, and an error from this file carries the status and Discord's short
 * error code only.
 */

import { createPublicKey, verify } from "crypto";

import { discordRateLimitedTotal } from "../metrics";
import type { DiscordConfig } from "./config";
import { ROLE_COLORS, ROLE_KEYS, ROLE_NAMES, type RoleKey } from "./roles";

const API = "https://discord.com/api/v10";
/** Everything one call may spend — attempts, waits and retries together. */
const TIMEOUT_MS = 10_000;
/** How many times a 429 is retried before it is given to the caller. */
const RATE_LIMIT_RETRIES = 2;
/** The longest single wait a 429 may cause. Discord asks for minutes; a user will not wait. */
const MAX_RETRY_WAIT_MS = 5_000;
/** What a 429 that named no wait is assumed to want. */
const DEFAULT_RETRY_WAIT_MS = 1_000;
/** How many times a repeatable call is retried on a 5xx or a network error. */
const TRANSPORT_RETRIES = 1;

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    path: string,
  ) {
    super(`Discord ${status}${code === null ? "" : ` (${code})`} on ${path}`);
    this.name = "DiscordApiError";
  }
}

/** Why a 429 was not waited out. Carried on the error; the message stays the same shape. */
export type RateLimitGiveUp = "capped" | "exhausted" | "no-time";

/**
 * A 429 that reached the caller.
 *
 * Same status, code and masked path as any {@link DiscordApiError}; the name
 * says it was Discord's rate limit that ended the call, not a refusal.
 */
export class DiscordRateLimitedError extends DiscordApiError {
  constructor(
    path: string,
    code: number | null,
    public readonly retryAfterMs: number,
    public readonly giveUp: RateLimitGiveUp,
  ) {
    super(429, code, path);
    this.name = "DiscordRateLimitedError";
  }
}

/**
 * The vocabulary of the rate-limit metric label.
 *
 * Bounded by construction: one word per kind of call Discord is asked to make.
 * A path would carry a guild id, a user id and a role id, and /metrics would
 * grow with every member the bot touches.
 */
export const DISCORD_CALL_KINDS = ["member", "role", "roles", "commands", "reply"] as const;
export type DiscordCallKind = (typeof DISCORD_CALL_KINDS)[number];

interface CallOptions {
  /** Metric label for this kind of call. */
  kind: DiscordCallKind;
  /**
   * Whether sending this exact request twice can produce the thing twice.
   *
   * Reads, and writes that set a value rather than append one (a role on or
   * off a member, the whole command set, one message's content), are true.
   * Creating a role is false: a 5xx tells us nothing about whether Discord
   * made it, and the retry would make a second one.
   */
  idempotent: boolean;
}

/** An interaction token in a path is a credential; nothing else here is. */
function maskPath(path: string): string {
  return path.replace(/\/webhooks\/(\d+)\/[^/]+/, "/webhooks/$1/…");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP answer, with whatever body came with it. */
interface DiscordAnswer {
  response: Response;
  parsed: { code?: unknown; retry_after?: unknown } | null;
}

/** One HTTP attempt. Throws whatever fetch throws, including our own abort. */
async function attempt(
  config: DiscordConfig | null,
  method: string,
  path: string,
  body: unknown,
  budgetMs: number,
): Promise<DiscordAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const response = await fetch(`${API}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(config ? { Authorization: `Bot ${config.botToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return { response, parsed: null };
    const parsed = (await response.json().catch(() => null)) as DiscordAnswer["parsed"];
    return { response, parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What this 429 asked us to wait, in ms, uncapped.
 *
 * Discord puts `retry_after` in the body (seconds, fractional) and `Retry-After`
 * in the header (whole seconds). The body is the precise one. Neither present is
 * not "wait nothing": a 429 with no answer gets {@link DEFAULT_RETRY_WAIT_MS}.
 */
function retryAfterMs(response: Response, parsed: { retry_after?: unknown } | null): number {
  const fromBody = Number(parsed?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) return Math.round(fromBody * 1000);
  const header = response.headers?.get?.("retry-after");
  const fromHeader = Number(header?.trim());
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000;
  return DEFAULT_RETRY_WAIT_MS;
}

/**
 * Every call to Discord.
 *
 * A 429 is Discord saying "ask again in a moment", not a failure, so it is
 * waited out and retried up to {@link RATE_LIMIT_RETRIES} times — never longer
 * than {@link MAX_RETRY_WAIT_MS} at a time, and never past the call's own
 * deadline. A wait above the cap fails at once instead: a button press that
 * hangs for thirty seconds is worse than one that says try again.
 *
 * A 5xx or a network error is retried once, and only for an idempotent call.
 * Every other answer is thrown as it arrived.
 *
 * The token is only ever in a header. Paths hold ids, never the token, and the
 * one path that holds a credential (an interaction token) is masked.
 */
async function call<T>(
  config: DiscordConfig | null,
  method: string,
  path: string,
  options: CallOptions,
  body?: unknown,
): Promise<T> {
  const safePath = maskPath(path);
  const deadline = Date.now() + TIMEOUT_MS;
  let rateLimitTries = 0;
  let transportTries = 0;

  for (;;) {
    let result: DiscordAnswer;
    try {
      result = await attempt(config, method, path, body, Math.max(0, deadline - Date.now()));
    } catch (error) {
      // Nothing reached us, or we stopped listening: repeating an idempotent
      // request cannot duplicate an effect.
      if (!options.idempotent || transportTries >= TRANSPORT_RETRIES || Date.now() >= deadline) throw error;
      transportTries += 1;
      continue;
    }

    const { response, parsed } = result;
    if (response.status === 204) return undefined as T;
    if (response.ok) return parsed as T;

    const code = typeof parsed?.code === "number" ? parsed.code : null;

    if (response.status === 429) {
      // Counted as it arrives, before the retry decision: how often Discord
      // pushes us back is the question, not how often we ran out of patience.
      discordRateLimitedTotal.inc({ kind: options.kind });
      const wait = retryAfterMs(response, parsed);
      const giveUp: RateLimitGiveUp | null =
        wait > MAX_RETRY_WAIT_MS
          ? "capped"
          : Date.now() + wait >= deadline
            ? "no-time"
            : rateLimitTries >= RATE_LIMIT_RETRIES
              ? "exhausted"
              : null;
      if (giveUp) throw new DiscordRateLimitedError(safePath, code, wait, giveUp);
      rateLimitTries += 1;
      await sleep(wait);
      continue;
    }

    if (
      response.status >= 500 &&
      options.idempotent &&
      transportTries < TRANSPORT_RETRIES &&
      Date.now() < deadline
    ) {
      transportTries += 1;
      continue;
    }

    throw new DiscordApiError(response.status, code, safePath);
  }
}

/** DER header that turns a raw 32-byte Ed25519 key into one Node can load. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Whether Discord really sent this interaction.
 *
 * Discord signs `timestamp + raw body`. The body must be the bytes that
 * arrived, which is why the interactions route is mounted before any JSON
 * parser.
 */
export function verifyInteractionSignature(
  publicKeyHex: string,
  signatureHex: unknown,
  timestamp: unknown,
  rawBody: Buffer,
): boolean {
  if (typeof signatureHex !== "string" || typeof timestamp !== "string") return false;
  if (!/^[0-9a-f]{128}$/i.test(signatureHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

interface GuildRole {
  id: string;
  name: string;
}

let roleCache: { guildId: string; at: number; ids: Partial<Record<RoleKey, string>> } | null = null;
/**
 * The lookup in flight, shared.
 *
 * Without this, two members syncing at once on a server that is missing a role
 * both see it missing and both create it, and the server keeps two roles with
 * one name. Whoever arrives second joins the first one's lookup rather than
 * starting a second.
 */
let roleLookup: Promise<Partial<Record<RoleKey, string>>> | null = null;
const ROLE_CACHE_MS = 5 * 60 * 1000;

/**
 * The id of each managed role, found by name and created when missing.
 *
 * Found by name so a deployment needs no list of role ids, and so an admin can
 * recolour or reorder a role without the bot losing it. A role the bot creates
 * has no permissions of its own: it is a label, and what it unlocks is set per
 * channel by the server's admins.
 */
export async function ensureRoles(config: DiscordConfig, now = Date.now()): Promise<Partial<Record<RoleKey, string>>> {
  if (roleCache && roleCache.guildId === config.guildId && now - roleCache.at < ROLE_CACHE_MS) {
    return roleCache.ids;
  }
  if (roleLookup) return roleLookup;

  const lookup = (async () => {
    const existing = await call<GuildRole[]>(config, "GET", `/guilds/${config.guildId}/roles`, {
      kind: "roles",
      idempotent: true,
    });
    const ids: Partial<Record<RoleKey, string>> = {};
    for (const key of ROLE_KEYS) {
      const found = existing.find((role) => role.name === ROLE_NAMES[key]);
      if (found) {
        ids[key] = found.id;
        continue;
      }
      // Not retried: a POST that came back 5xx may have made the role anyway,
      // and the retry would make a second one with the same name.
      const created = await call<GuildRole>(
        config,
        "POST",
        `/guilds/${config.guildId}/roles`,
        { kind: "role", idempotent: false },
        {
          name: ROLE_NAMES[key],
          color: ROLE_COLORS[key],
          permissions: "0",
          hoist: false,
          mentionable: false,
        },
      );
      ids[key] = created.id;
    }
    roleCache = { guildId: config.guildId, at: now, ids };
    return ids;
  })().finally(() => {
    // Only forget the promise if nothing newer has already taken its place.
    if (roleLookup === lookup) roleLookup = null;
  });

  roleLookup = lookup;
  return lookup;
}

/** Test-only: forget the cached role ids and any lookup in flight. */
export function _resetRoleCache(): void {
  roleCache = null;
  roleLookup = null;
}

/** The member's current role ids, or null when they are not in the server. */
export async function memberRoles(config: DiscordConfig, userId: string): Promise<string[] | null> {
  try {
    const member = await call<{ roles?: string[] }>(config, "GET", `/guilds/${config.guildId}/members/${userId}`, {
      kind: "member",
      idempotent: true,
    });
    return Array.isArray(member.roles) ? member.roles : [];
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return null;
    throw error;
  }
}

export async function addRole(config: DiscordConfig, userId: string, roleId: string): Promise<void> {
  await call(config, "PUT", `/guilds/${config.guildId}/members/${userId}/roles/${roleId}`, {
    kind: "role",
    idempotent: true,
  });
}

export async function removeRole(config: DiscordConfig, userId: string, roleId: string): Promise<void> {
  await call(config, "DELETE", `/guilds/${config.guildId}/members/${userId}/roles/${roleId}`, {
    kind: "role",
    idempotent: true,
  });
}

/** Replace the "thinking…" placeholder of a deferred interaction. */
export async function editInteractionReply(
  config: DiscordConfig,
  interactionToken: string,
  message: Record<string, unknown>,
): Promise<void> {
  // Authorised by the interaction token in the path; no bot token is sent.
  await call(
    null,
    "PATCH",
    `/webhooks/${config.applicationId}/${interactionToken}/messages/@original`,
    { kind: "reply", idempotent: true },
    message,
  );
}

/** Manage Server. Only members with it can post the verification panel. */
const MANAGE_GUILD = "32";

export const COMMANDS = [
  { name: "verify", description: "Link your Veil wallet and get your roles", type: 1 },
  { name: "github", description: "Connect GitHub to get your contributor role", type: 1 },
  { name: "refresh", description: "Check your wallet and GitHub again now", type: 1 },
  { name: "unlink", description: "Remove your wallet and GitHub from this server", type: 1 },
  {
    name: "veil-panel",
    description: "Post the verification buttons in this channel",
    type: 1,
    default_member_permissions: MANAGE_GUILD,
  },
] as const;

/** Tell Discord which slash commands exist. Replaces the whole set; safe to repeat. */
export async function registerCommands(config: DiscordConfig): Promise<void> {
  await call(
    config,
    "PUT",
    `/applications/${config.applicationId}/guilds/${config.guildId}/commands`,
    { kind: "commands", idempotent: true },
    COMMANDS,
  );
}
