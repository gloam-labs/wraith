/**
 * Configuration for the Veil Discord roles bot.
 *
 * The bot is optional. With no `DISCORD_*` variables set, every route in this
 * directory answers 503 and the daily job never starts; nothing here is read
 * at boot, and nothing here can stop the service from starting. That is the
 * rule from `validateEnv.ts`: a partial dependency degrades, it does not gate.
 *
 * Everything is read from the environment on each call, like `network.ts`, so
 * a test can set a variable and see it.
 */

import type { Network } from "../network";
import { parseNetwork } from "../network";

/** The Soroban code every Veil wallet on mainnet runs. */
const DEFAULT_WALLET_WASM_HASHES = [
  "b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5",
];

const DEFAULT_VEILIANS_CONTRACT = "CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN";
const DEFAULT_NAMES_CONTRACT = "CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4";
const DEFAULT_GITHUB_REPOS = ["Miracle656/veil", "gloam-labs/wraith", "Divinity-Labs/Lens"];

function text(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function list(name: string, fallback: string[]): string[] {
  const raw = text(name);
  if (!raw) return fallback;
  const parsed = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function positiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(text(name) ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface DiscordConfig {
  applicationId: string;
  /** Hex Ed25519 key Discord signs every interaction with. */
  publicKey: string;
  botToken: string;
  guildId: string;
}

/** The four values without which there is no bot. Null when any is missing. */
export function discordConfig(): DiscordConfig | null {
  const applicationId = text("DISCORD_APPLICATION_ID");
  const publicKey = text("DISCORD_PUBLIC_KEY");
  const botToken = text("DISCORD_BOT_TOKEN");
  const guildId = text("DISCORD_GUILD_ID");
  if (!applicationId || !publicKey || !botToken || !guildId) return null;
  return { applicationId, publicKey, botToken, guildId };
}

export function isDiscordConfigured(): boolean {
  return discordConfig() !== null;
}

/** The chain the roles describe. Mainnet unless told otherwise. */
export function discordNetwork(): Network {
  return parseNetwork(process.env.DISCORD_NETWORK) ?? "mainnet";
}

/** Public mainnet RPC endpoints that need no key. Tried after any configured one. */
const PUBLIC_MAINNET_RPC_URLS = [
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://rpc.lightsail.network/",
  "https://mainnet.sorobanrpc.com",
];

/**
 * The RPC endpoints the bot reads the chain through, in the order to try them.
 *
 * `DISCORD_SOROBAN_RPC_URL` may hold one address or several separated by
 * commas. On mainnet the public endpoints are always added after them, so the
 * bot keeps working when the configured one is slow or down. Empty on testnet
 * with nothing configured: the caller then falls back to the indexer's.
 */
export function discordRpcUrls(): string[] {
  const configured = list("DISCORD_SOROBAN_RPC_URL", []);
  const fallbacks = discordNetwork() === "mainnet" ? PUBLIC_MAINNET_RPC_URLS : [];
  return [...new Set([...configured, ...fallbacks])];
}

export function horizonUrl(): string {
  const network = discordNetwork();
  const specific = text(network === "mainnet" ? "HORIZON_URL_MAINNET" : "HORIZON_URL_TESTNET");
  if (specific) return specific.replace(/\/+$/, "");
  return network === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
}

/** Lower-case hex hashes of the wallet code that counts as "made by Veil". */
export function walletWasmHashes(): string[] {
  return list("VEIL_WALLET_WASM_HASHES", DEFAULT_WALLET_WASM_HASHES).map((hash) => hash.toLowerCase());
}

export function veiliansContractId(): string {
  return text("VEIL_VEILIANS_CONTRACT_ID") ?? DEFAULT_VEILIANS_CONTRACT;
}

export function namesContractId(): string {
  return text("VEIL_NAMES_CONTRACT_ID") ?? DEFAULT_NAMES_CONTRACT;
}

/** The domain every Veil passkey is bound to. */
export function passkeyRpId(): string {
  return text("VEIL_PASSKEY_RP_ID") ?? "app.useveilapp.xyz";
}

/** The page a member opens to prove a wallet is theirs. The code is appended. */
export function linkPageUrl(code: string): string {
  const base = text("DISCORD_LINK_PAGE_URL") ?? "https://app.useveilapp.xyz/link-discord";
  return `${base}${base.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`;
}

/** GitHub OAuth app client id (device flow, so there is no secret). */
export function githubClientId(): string | null {
  return text("DISCORD_GITHUB_CLIENT_ID");
}

/** Optional token that only raises GitHub's rate limit for the daily count. */
export function githubToken(): string | null {
  return text("DISCORD_GITHUB_TOKEN");
}

export function githubRepos(): string[] {
  return list("DISCORD_GITHUB_REPOS", DEFAULT_GITHUB_REPOS);
}

export interface Thresholds {
  /** Transactions in the last 30 days for the Active role. */
  active: number;
  /** Transactions in the last 30 days for the Power User role. */
  power: number;
  /** Merged pull requests for each contributor tier. */
  contributor: number;
  coreContributor: number;
  topContributor: number;
  /** A spending account older than this gets Early User. Null: role unused. */
  earlyBefore: Date | null;
}

export function thresholds(): Thresholds {
  const cutoff = text("DISCORD_EARLY_BEFORE");
  const parsed = cutoff ? new Date(cutoff) : null;
  return {
    active: positiveInt("DISCORD_ACTIVE_MIN_TX", 3),
    power: positiveInt("DISCORD_POWER_MIN_TX", 20),
    contributor: positiveInt("DISCORD_CONTRIBUTOR_MIN_PRS", 1),
    coreContributor: positiveInt("DISCORD_CORE_MIN_PRS", 5),
    topContributor: positiveInt("DISCORD_TOP_MIN_PRS", 15),
    earlyBefore: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
  };
}

/** How often every linked member is checked again. A day unless overridden. */
export function recheckIntervalMs(): number {
  return positiveInt("DISCORD_RECHECK_INTERVAL_MS", 24 * 60 * 60 * 1000);
}

/**
 * How often the job looks for members whose last attempt is overdue.
 *
 * This is the tick, not the interval: a member is due when their own
 * `lastAttemptAt` is older than {@link recheckIntervalMs}. Fifteen minutes
 * means a restart costs at most a quarter of an hour of lateness instead of a
 * whole day, and it is short enough that a deploy a day can no longer mean the
 * check never runs at all.
 */
export function recheckTickMs(): number {
  return positiveInt("DISCORD_RECHECK_TICK_MS", 15 * 60 * 1000);
}

/** How long a member is left alone after the member-gone check count is reached. */
export function absentRecheckIntervalMs(): number {
  return positiveInt("DISCORD_ABSENT_RECHECK_INTERVAL_MS", 7 * 24 * 60 * 60 * 1000);
}

/** Consecutive "member is gone" checks before a member is only checked weekly. */
export function absentChecksBeforeBackoff(): number {
  return positiveInt("DISCORD_ABSENT_CHECKS_BEFORE_BACKOFF", 3);
}

/** The longest a repeatedly failing member waits between attempts. */
export function maxFailureBackoffMs(): number {
  return positiveInt("DISCORD_MAX_FAILURE_BACKOFF_MS", 24 * 60 * 60 * 1000);
}
