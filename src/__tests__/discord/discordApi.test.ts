/**
 * What one Discord REST call does when Discord says "slow down".
 *
 * `fetch` is mocked and timers are fake: these tests are about how many
 * requests go out, how long the call waits between them, and what it hands
 * back when it stops trying. Nothing here talks to Discord.
 */
import {
  DiscordApiError,
  DiscordRateLimitedError,
  addRole,
  editInteractionReply,
  ensureRoles,
  memberRoles,
  registerCommands,
  removeRole,
  _resetRoleCache,
} from "../../discord/discordApi";
import type { DiscordConfig } from "../../discord/config";
import { ROLE_NAMES } from "../../discord/roles";
import { renderMetrics, _resetMetrics } from "../../metrics";

const BOT_TOKEN = "bot-token-never-log-me";
const config: DiscordConfig = {
  applicationId: "210613069988593664",
  publicKey: "ab".repeat(32),
  botToken: BOT_TOKEN,
  guildId: "guild-1",
};

/** A Response as far as this module cares: status, ok, body, one header. */
function answer(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;

/** Let queued microtasks run, and any timer due within `ms`. */
async function tick(ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
}

/**
 * Start `promise`, run the timers it needs, and hand back what it threw with
 * the time it threw it. Awaiting the promise alone would hang: its retry waits
 * are fake timers, and nothing advances them while we wait.
 */
async function failWith(promise: Promise<unknown>, runForMs: number): Promise<{ error: unknown; at: number }> {
  let settled: { error: unknown; at: number } | null = null;
  const watched = promise.then(
    () => undefined,
    (error) => {
      settled = { error, at: Date.now() };
    },
  );
  await tick(runForMs);
  await watched;
  if (!settled) throw new Error("the call was expected to fail and did not");
  return settled;
}

function calls(method: string): number {
  return fetchMock.mock.calls.filter(([, init]) => String((init as RequestInit | undefined)?.method) === method).length;
}

beforeEach(() => {
  jest.useFakeTimers();
  _resetRoleCache();
  _resetMetrics();
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("a 429 answer", () => {
  it("waits what Discord asked for and tries again", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(429, { retry_after: 0.5, message: "You are being rate limited." }) as never)
      .mockResolvedValueOnce(answer(204) as never);

    const pending = addRole(config, "user-1", "role-1");
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Not one millisecond early: the wait is Discord's, not ours to shorten.
    await tick(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(1);
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the wait from the Retry-After header when the body says nothing", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(429, null, { "retry-after": "2" }) as never)
      .mockResolvedValueOnce(answer(200, { roles: ["r1"] }) as never);

    const pending = memberRoles(config, "user-1");
    await tick(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await tick(1);
    await expect(pending).resolves.toEqual(["r1"]);
  });

  it("gives up at once when the wait is longer than the cap", async () => {
    const startedAt = Date.now();
    fetchMock.mockResolvedValueOnce(answer(429, { retry_after: 30 }) as never);

    const { error, at } = await failWith(memberRoles(config, "user-1"), 60_000);

    expect(error).toBeInstanceOf(DiscordRateLimitedError);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordRateLimitedError).status).toBe(429);
    expect((error as DiscordRateLimitedError).giveUp).toBe("capped");
    expect((error as DiscordRateLimitedError).retryAfterMs).toBe(30_000);
    // "At once" is the point: one request, nothing left waiting, no time spent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(at - startedAt).toBe(0);
  });

  it("tries a small, fixed number of times", async () => {
    const startedAt = Date.now();
    fetchMock.mockResolvedValue(answer(429, { retry_after: 1 }) as never);

    const { error, at } = await failWith(removeRole(config, "user-1", "role-1"), 60_000);

    expect((error as DiscordRateLimitedError).giveUp).toBe("exhausted");
    // The first try plus two retries.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
    expect(at - startedAt).toBeLessThanOrEqual(10_000);
  });

  it("never spends longer than one call's budget, waits included", async () => {
    // Three waits of 4.9 seconds would take 14.7; the budget is ten.
    const startedAt = Date.now();
    fetchMock.mockResolvedValue(answer(429, { retry_after: 4.9 }) as never);

    const { error, at } = await failWith(memberRoles(config, "user-1"), 60_000);

    expect((error as DiscordRateLimitedError).giveUp).toBe("no-time");
    expect(at - startedAt).toBeLessThanOrEqual(10_000);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("counts a 429 on a command registration against that kind", async () => {
    fetchMock.mockResolvedValueOnce(answer(429, { retry_after: 90 }) as never);
    await failWith(registerCommands(config), 1_000);

    expect(await renderMetrics()).toContain('discord_rate_limited_total{kind="commands"} 1');
  });
});

describe("a 5xx answer or a network error", () => {
  it("retries a repeatable call once", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(500, { message: "internal error" }) as never)
      .mockResolvedValueOnce(answer(204) as never);

    await expect(addRole(config, "user-1", "role-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry the same 5xx twice", async () => {
    fetchMock.mockResolvedValue(answer(503, { message: "maintenance" }) as never);

    const { error } = await failWith(registerCommands(config), 60_000);

    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as DiscordApiError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network error on a repeatable call", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(answer(200, { roles: [] }) as never);

    await expect(memberRoles(config, "user-1")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a network error after the one retry", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const { error } = await failWith(memberRoles(config, "user-1"), 60_000);

    expect(error).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries creating a role: a duplicate name is the failure it would cause", async () => {
    fetchMock.mockImplementation(async (url, init) =>
      String((init as RequestInit | undefined)?.method) === "POST"
        ? (answer(500, { message: "internal error" }) as never)
        : (answer(200, []) as never),
    );

    await failWith(ensureRoles(config), 60_000);

    expect(calls("POST")).toBe(1);
  });
});

describe("ensureRoles under two callers at once", () => {
  const names = Object.values(ROLE_NAMES);

  beforeEach(() => {
    let created = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (String((init as RequestInit | undefined)?.method) === "POST") {
        created += 1;
        return answer(200, { id: `role-${created}`, name: names[created - 1] }) as never;
      }
      return answer(200, []) as never;
    });
  });

  it("creates each missing role once", async () => {
    const [first, second] = await Promise.all([ensureRoles(config), ensureRoles(config)]);
    await tick();

    // One shared lookup: one list, and nine creates rather than eighteen.
    expect(calls("GET")).toBe(1);
    expect(calls("POST")).toBe(names.length);
    expect(second).toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(names.length);
  });

  it("caches, so a third caller asks Discord nothing", async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url) =>
      answer(
        200,
        names.map((name, i) => ({ id: `r${i}`, name })),
      ) as never,
    );

    await ensureRoles(config);
    const afterFirst = fetchMock.mock.calls.length;
    await ensureRoles(config);
    expect(fetchMock).toHaveBeenCalledTimes(afterFirst);
  });

  it("lets a later caller retry a lookup that failed", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await failWith(ensureRoles(config), 60_000);

    let created = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (String((init as RequestInit | undefined)?.method) === "POST") {
        created += 1;
        return answer(200, { id: `role-${created}`, name: names[created - 1] }) as never;
      }
      return answer(200, []) as never;
    });

    const ids = await ensureRoles(config);
    expect(Object.values(ids)).toHaveLength(names.length);
  });
});

describe("the rate-limit metric", () => {
  it("counts every 429 by kind, never by path", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(429, { retry_after: 0.1 }) as never)
      .mockResolvedValueOnce(answer(204) as never);
    const roleCall = addRole(config, "user-1", "role-9");
    await tick(100);
    await roleCall;

    fetchMock.mockResolvedValueOnce(answer(429, { retry_after: 99 }) as never);
    await failWith(memberRoles(config, "user-1"), 1_000);

    const text = await renderMetrics();
    expect(text).toContain('discord_rate_limited_total{kind="role"} 1');
    expect(text).toContain('discord_rate_limited_total{kind="member"} 1');
    expect(text).not.toContain("guild-1");
    expect(text).not.toContain("user-1");
    // Only the five words this module can name are ever a label value.
    const kinds = [...text.matchAll(/discord_rate_limited_total\{kind="([^"]+)"\}/g)].map((match) => match[1]);
    expect(new Set(kinds).size).toBeLessThanOrEqual(5);
  });
});

describe("the bot token", () => {
  it("is sent in one header and appears in no error", async () => {
    fetchMock.mockResolvedValueOnce(answer(403, { code: 50013 }) as never);
    const { error } = await failWith(addRole(config, "user-1", "role-1"), 1_000);

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect((error as Error).message).toBe("Discord 403 (50013) on /guilds/guild-1/members/user-1/roles/role-1");
    expect((error as Error).message).not.toContain(BOT_TOKEN);
  });

  it("masks an interaction token in a failing path", async () => {
    fetchMock.mockResolvedValueOnce(answer(400, { code: 50027 }) as never);
    const { error } = await failWith(editInteractionReply(config, "interaction-token-secret", { content: "done" }), 1_000);

    expect((error as Error).message).toBe("Discord 400 (50027) on /webhooks/210613069988593664/…/messages/@original");
    expect((error as Error).message).not.toContain("interaction-token-secret");
  });

  it("is not carried by a rate-limit error either", async () => {
    fetchMock.mockResolvedValueOnce(answer(429, { retry_after: 60 }) as never);
    const { error } = await failWith(editInteractionReply(config, "interaction-token-secret", { content: "done" }), 1_000);

    expect(error).toBeInstanceOf(DiscordRateLimitedError);
    expect((error as Error).message).not.toContain(BOT_TOKEN);
    expect((error as Error).message).not.toContain("interaction-token-secret");
  });
});
