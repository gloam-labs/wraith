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

import { githubClientId, githubRepos, githubToken } from "./config";

const TIMEOUT_MS = 10_000;

async function request(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body };
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

/**
 * Merged pull requests by this account across Veil's repositories.
 * Null when GitHub could not be asked, which keeps the member's role as it is.
 */
export async function mergedPullRequestCount(login: string): Promise<number | null> {
  if (!isLogin(login)) return null;
  const repos = githubRepos().map((repo) => `repo:${repo}`).join(" ");
  const query = encodeURIComponent(`is:pr is:merged author:${login} ${repos}`);
  const token = githubToken();
  try {
    const { status, body } = await request(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const total = body?.total_count;
    return status === 200 && typeof total === "number" ? total : null;
  } catch {
    return null;
  }
}
