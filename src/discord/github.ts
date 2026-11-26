/**
 * Connecting a GitHub account, and counting what it has contributed.
 *
 * GitHub's device flow: the member is shown a short code, enters it on
 * github.com, and GitHub tells us which account approved. It needs a client id
 * and no secret, no redirect page and no scopes: all we learn is who they are.
 * The access token is used once, to read the account's name and id, and is
 * then dropped. It is never stored.
 *
 * A contribution is a merged pull request in one of Veil's repositories. That
 * is a public fact about a public account, so the daily recount needs no
 * access to anything of the member's.
 */

import { Counter } from "prom-client";
import { registry } from "../metrics";
import { githubClientId, githubRepos, githubToken } from "./config";

const TIMEOUT_MS = 10_000;
/** The daily check should never hold a Discord interaction for minutes. */
const SEARCH_MAX_WAIT_MS = 20_000;
/** Refresh is pressed often; a short count cache keeps those reads cheap. */
const COUNT_CACHE_TTL_MS = 10 * 60 * 1000;
const CHECKS_METRIC = "veil_discord_github_checks_total";

/** Only `get` is used, so a mocked Response needs no full Headers object. */
interface ResponseHeaders {
  get(name: string): string | null;
}

interface GithubResponse {
  status: number;
  body: Record<string, unknown> | null;
  headers: ResponseHeaders;
}

function headersOf(value: unknown): ResponseHeaders {
  const candidate = value as { get?: unknown } | null;
  if (candidate && typeof candidate.get === "function") return value as ResponseHeaders;
  return { get: () => null };
}

/**
 * Daily checks by final outcome. The label is a fixed three-word vocabulary;
 * no login, URL or token can reach it.
 */
const checksTotal = new Counter({
  name: CHECKS_METRIC,
  help: "Daily Discord GitHub contribution checks by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

function recordCheck(outcome: "ok" | "rate_limited" | "error"): void {
  checksTotal.inc({ outcome });
}

async function request(url: string, init: RequestInit): Promise<GithubResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body, headers: headersOf(response.headers) };
  } finally {
    clearTimeout(timer);
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
}

/** Start the flow. Null when GitHub is not configured or did not answer. */
export async function startDeviceFlow(): Promise<DeviceCode | null> {
  const clientId = githubClientId();
  if (!clientId) return null;
  try {
    const { status, body } = await request("https://github.com/login/device/code", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId }),
    });
    if (status !== 200 || !body) return null;
    const { device_code, user_code, verification_uri, expires_in } = body;
    if (typeof device_code !== "string" || typeof user_code !== "string") return null;
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: typeof verification_uri === "string" ? verification_uri : "https://github.com/login/device",
      expiresInSeconds: typeof expires_in === "number" ? expires_in : 900,
    };
  } catch {
    return null;
  }
}

export type DeviceOutcome =
  | { status: "connected"; id: string; login: string }
  | { status: "pending" }
  | { status: "expired" }
  | { status: "failed" };

/** Ask GitHub whether the member has approved yet, and if so who they are. */
export async function finishDeviceFlow(deviceCode: string): Promise<DeviceOutcome> {
  const clientId = githubClientId();
  if (!clientId) return { status: "failed" };
  try {
    const token = await request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const error = token.body?.error;
    if (error === "authorization_pending" || error === "slow_down") return { status: "pending" };
    if (error === "expired_token" || error === "access_denied") return { status: "expired" };
    const accessToken = token.body?.access_token;
    if (typeof accessToken !== "string") return { status: "failed" };

    const user = await request("https://api.github.com/user", {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}` },
    });
    const id = user.body?.id;
    const login = user.body?.login;
    if (user.status !== 200 || typeof id !== "number" || typeof login !== "string") return { status: "failed" };
    return { status: "connected", id: String(id), login };
  } catch {
    return { status: "failed" };
  }
}

/** GitHub logins: letters, digits and single hyphens, at most 39 characters. */
function isLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

interface SearchLimit {
  remaining: number | null;
  resetAt: number | null;
}

interface CachedCount {
  count: number;
  expiresAt: number;
}

let searchLimit: SearchLimit = { remaining: null, resetAt: null };
const countCache = new Map<string, CachedCount>();
/** One search at a time: a refresh burst must not spend the same last call twice. */
let queue: Promise<void> = Promise.resolve();

function withLock<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function numberHeader(headers: ResponseHeaders, name: string): number | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function retryAfterMs(headers: ResponseHeaders): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function noteSearchLimit(headers: ResponseHeaders): void {
  const remaining = numberHeader(headers, "x-ratelimit-remaining");
  const reset = numberHeader(headers, "x-ratelimit-reset");
  searchLimit = {
    remaining: remaining === null ? null : Math.max(0, Math.floor(remaining)),
    resetAt: reset === null ? null : reset * 1000,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True only when the wait fits the daily check's budget. */
async function waitAtMost(ms: number): Promise<boolean> {
  if (ms <= 0) return true;
  if (ms > SEARCH_MAX_WAIT_MS) return false;
  await sleep(ms);
  return true;
}

function cacheKey(login: string): string {
  return login.toLowerCase();
}

function cachedCount(login: string, now: number): number | null {
  const key = cacheKey(login);
  const hit = countCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    countCache.delete(key);
    return null;
  }
  return hit.count;
}

function rememberCount(login: string, count: number, now: number): void {
  countCache.set(cacheKey(login), { count, expiresAt: now + COUNT_CACHE_TTL_MS });
}

function readCount(response: GithubResponse): number | null {
  const total = response.body?.total_count;
  return response.status === 200 && typeof total === "number" ? total : null;
}

/**
 * Merged pull requests by this account across Veil's repositories.
 * Null when GitHub could not be asked, which keeps the member's role as it is.
 */
export async function mergedPullRequestCount(login: string): Promise<number | null> {
  if (!isLogin(login)) return null;
  return withLock(async () => {
    const now = Date.now();
    const hit = cachedCount(login, now);
    if (hit !== null) return hit;

    if (searchLimit.remaining === 0) {
      if (searchLimit.resetAt === null || !(await waitAtMost(searchLimit.resetAt - now))) {
        recordCheck("rate_limited");
        return null;
      }
    }

    const repos = githubRepos().map((repo) => `repo:${repo}`).join(" ");
    const query = encodeURIComponent(`is:pr is:merged author:${login} ${repos}`);
    const token = githubToken();
    const url = `https://api.github.com/search/issues?q=${query}&per_page=1`;
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const first = await request(url, { headers });
      noteSearchLimit(first.headers);
      if (first.status === 403 || first.status === 429) {
        const resetWait = searchLimit.resetAt === null ? null : searchLimit.resetAt - Date.now();
        const wait = retryAfterMs(first.headers) ?? resetWait;
        if (wait === null || !(await waitAtMost(wait))) {
          recordCheck("rate_limited");
          return null;
        }
        const retry = await request(url, { headers });
        noteSearchLimit(retry.headers);
        if (retry.status === 403 || retry.status === 429) {
          recordCheck("rate_limited");
          return null;
        }
        const retryCount = readCount(retry);
        if (retryCount === null) {
          recordCheck("error");
          return null;
        }
        rememberCount(login, retryCount, Date.now());
        recordCheck("ok");
        return retryCount;
      }

      const count = readCount(first);
      if (count === null) {
        recordCheck("error");
        return null;
      }
      rememberCount(login, count, Date.now());
      recordCheck("ok");
      return count;
    } catch {
      recordCheck("error");
      return null;
    }
  });
}

/** Test-only: clears the rate-limit note, the count cache and the call queue. */
export function _resetGithubChecks(): void {
  searchLimit = { remaining: null, resetAt: null };
  countCache.clear();
  queue = Promise.resolve();
}
