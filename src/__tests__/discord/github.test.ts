/**
 * The daily Discord role check must stay inside GitHub's search rate limit.
 *
 * A 403/429 used to become "could not check", which is safe for the role, but
 * it happened to almost every member: the running job asked GitHub 40 times a
 * minute. These tests pin the limit handling without a real GitHub login.
 */
jest.mock("../../discord/config", () => ({
  githubClientId: () => null,
  githubRepos: () => ["Miracle656/veil"],
  githubToken: () => null,
}));

import { mergedPullRequestCount, _resetGithubChecks } from "../../discord/github";
import { renderMetrics, _resetMetrics } from "../../metrics";

const fetchMock = jest.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    json: jest.fn().mockResolvedValue(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const NOW = Date.parse("2026-11-24T12:00:00.000Z");
const resetIn = (seconds: number) => String(Math.floor(NOW / 1000) + seconds);

/** Let pending fetch/await continuations run while timers are faked. */
async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  fetchMock.mockReset();
  _resetGithubChecks();
  _resetMetrics();
});

afterEach(() => {
  jest.useRealTimers();
});

it("returns the merged-PR count from a successful search", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { total_count: 7 }, {
    "x-ratelimit-remaining": "9",
    "x-ratelimit-reset": resetIn(60),
  }));

  await expect(mergedPullRequestCount("alice")).resolves.toBe(7);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("waits for a near reset before spending the next search call", async () => {
  fetchMock
    .mockResolvedValueOnce(reply(200, { total_count: 0 }, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": resetIn(5),
    }))
    .mockResolvedValueOnce(reply(200, { total_count: 2 }, {
      "x-ratelimit-remaining": "9",
      "x-ratelimit-reset": resetIn(60),
    }));

  await expect(mergedPullRequestCount("alice")).resolves.toBe(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const pending = mergedPullRequestCount("bob");
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5_000);
  await expect(pending).resolves.toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not call GitHub when the reset is too far away", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { total_count: 0 }, {
    "x-ratelimit-remaining": "0",
    "x-ratelimit-reset": resetIn(120),
  }));

  await expect(mergedPullRequestCount("alice")).resolves.toBe(0);
  await expect(mergedPullRequestCount("bob")).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("respects retry-after on a 429 and never turns a limit into zero", async () => {
  fetchMock
    .mockResolvedValueOnce(reply(429, {}, { "retry-after": "2" }))
    .mockResolvedValueOnce(reply(200, { total_count: 3 }, {
      "x-ratelimit-remaining": "9",
      "x-ratelimit-reset": resetIn(60),
    }));

  const pending = mergedPullRequestCount("alice");
  await flush();
  await jest.advanceTimersByTimeAsync(2_000);
  await expect(pending).resolves.toBe(3);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("returns null, not zero, when a 403 cannot be retried soon", async () => {
  fetchMock.mockResolvedValueOnce(reply(403, {}, { "retry-after": "60" }));

  await expect(mergedPullRequestCount("alice")).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("reuses a fresh count instead of spending another search call", async () => {
  fetchMock.mockResolvedValueOnce(reply(200, { total_count: 4 }, {
    "x-ratelimit-remaining": "9",
    "x-ratelimit-reset": resetIn(60),
  }));

  await expect(mergedPullRequestCount("alice")).resolves.toBe(4);
  await expect(mergedPullRequestCount("alice")).resolves.toBe(4);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("exposes ok, rate_limited and error outcomes in the rendered metrics", async () => {
  fetchMock
    .mockResolvedValueOnce(reply(200, { total_count: 1 }, {
      "x-ratelimit-remaining": "9",
      "x-ratelimit-reset": resetIn(60),
    }))
    .mockResolvedValueOnce(reply(429, {}, { "retry-after": "60" }))
    .mockResolvedValueOnce(reply(500, {}));

  await expect(mergedPullRequestCount("alice")).resolves.toBe(1);
  await expect(mergedPullRequestCount("bob")).resolves.toBeNull();
  await expect(mergedPullRequestCount("carol")).resolves.toBeNull();

  const metrics = await renderMetrics();
  expect(metrics).toContain('veil_discord_github_checks_total{outcome="ok"} 1');
  expect(metrics).toContain('veil_discord_github_checks_total{outcome="rate_limited"} 1');
  expect(metrics).toContain('veil_discord_github_checks_total{outcome="error"} 1');
});
