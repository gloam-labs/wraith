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

import type { DiscordConfig } from "./config";
import { ROLE_COLORS, ROLE_KEYS, ROLE_NAMES, type RoleKey } from "./roles";

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 10_000;

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

async function call<T>(
  config: DiscordConfig | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
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
    if (response.status === 204) return undefined as T;
    const parsed = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (!response.ok) {
      // Paths hold ids, never the token; an interaction token path is masked.
      const safePath = path.replace(/\/webhooks\/(\d+)\/[^/]+/, "/webhooks/$1/…");
      throw new DiscordApiError(response.status, typeof parsed?.code === "number" ? parsed.code : null, safePath);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
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
  const existing = await call<GuildRole[]>(config, "GET", `/guilds/${config.guildId}/roles`);
  const ids: Partial<Record<RoleKey, string>> = {};
  for (const key of ROLE_KEYS) {
    const found = existing.find((role) => role.name === ROLE_NAMES[key]);
    if (found) {
      ids[key] = found.id;
      continue;
    }
    const created = await call<GuildRole>(config, "POST", `/guilds/${config.guildId}/roles`, {
      name: ROLE_NAMES[key],
      color: ROLE_COLORS[key],
      permissions: "0",
      hoist: false,
      mentionable: false,
    });
    ids[key] = created.id;
  }
  roleCache = { guildId: config.guildId, at: now, ids };
  return ids;
}

/** Test-only: forget the cached role ids. */
export function _resetRoleCache(): void {
  roleCache = null;
}

/** The member's current role ids, or null when they are not in the server. */
export async function memberRoles(config: DiscordConfig, userId: string): Promise<string[] | null> {
  try {
    const member = await call<{ roles?: string[] }>(config, "GET", `/guilds/${config.guildId}/members/${userId}`);
    return Array.isArray(member.roles) ? member.roles : [];
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return null;
    throw error;
  }
}

export async function addRole(config: DiscordConfig, userId: string, roleId: string): Promise<void> {
  await call(config, "PUT", `/guilds/${config.guildId}/members/${userId}/roles/${roleId}`);
}

export async function removeRole(config: DiscordConfig, userId: string, roleId: string): Promise<void> {
  await call(config, "DELETE", `/guilds/${config.guildId}/members/${userId}/roles/${roleId}`);
}

/** Replace the "thinking…" placeholder of a deferred interaction. */
export async function editInteractionReply(
  config: DiscordConfig,
  interactionToken: string,
  message: Record<string, unknown>,
): Promise<void> {
  // Authorised by the interaction token in the path; no bot token is sent.
  await call(null, "PATCH", `/webhooks/${config.applicationId}/${interactionToken}/messages/@original`, message);
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
  await call(config, "PUT", `/applications/${config.applicationId}/guilds/${config.guildId}/commands`, COMMANDS);
}
