/**
 * The recheck must run because members are overdue, not because the process
 * happens to have been up for a day (#385).
 *
 * The old timer started from zero at every start, so a deploy a day meant the
 * check never ran; and a member whose check threw kept their old `checkedAt`
 * and was picked first again the next day, so two hundred failures could
 * starve everybody else. These tests pin both, plus the absence backoff, the
 * counters, and that an unconfigured bot creates no timer.
 *
 * `syncMember` runs for real. Only the two edges it reads through are replaced:
 * the chain and GitHub (no network) and Discord's HTTP calls (no bot token).
 * The database is a small in-memory stand-in. Nothing here reaches either
 * service.
 */
/** The row shape `recheckAll` and `syncMember` read, plus an index signature. */
type MemberRow = DiscordMember & Record<string, unknown>;

const members = new Map<string, MemberRow>();

function row(overrides: Partial<MemberRow> & { discordUserId: string }): MemberRow {
  return {
    network: "mainnet",
    wallet: null,
    spending: null,
    linkedAt: null,
    names: [],
    githubId: null,
    githubLogin: null,
    nonceHistory: null,
    firstSeenAt: null,
    lastAttemptAt: null,
    failedAttempts: 0,
    absentChecks: 0,
    checkedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    updatedAt: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

const fakePrisma = {
  discordMember: {
    /** The same two clauses `recheckAll` asks for: never attempted, or older than the cutoff. */
    findMany: jest.fn(
      async ({ where, take }: { where: { OR: Array<Record<string, unknown>> }; take: number }) => {
        const cutoff = (where.OR[1] as { lastAttemptAt: { lte: Date } }).lastAttemptAt.lte.getTime();
        const due = [...members.values()].filter(
          (member) => member.lastAttemptAt === null || member.lastAttemptAt.getTime() <= cutoff,
        );
        due.sort((a, b) => (a.lastAttemptAt?.getTime() ?? -Infinity) - (b.lastAttemptAt?.getTime() ?? -Infinity));
        return due.slice(0, take).map((member) => ({ ...member }));
      },
    ),
    update: jest.fn(
      async ({ where, data }: { where: { discordUserId: string }; data: Partial<MemberRow> }) => {
        Object.assign(members.get(where.discordUserId)!, data);
      },
    ),
  },
};
jest.mock("../../db", () => ({ prisma: fakePrisma }));

jest.mock("../../discord/chain", () => ({
  activeNames: jest.fn(async () => []),
  firstOperationAt: jest.fn(async () => null),
  holdsVeilian: jest.fn(async () => false),
  isVeilWallet: jest.fn(async () => false),
  ownsAnyName: jest.fn(async () => false),
  recentOperationCount: jest.fn(async () => 0),
  walletNonce: jest.fn(async () => null),
}));

jest.mock("../../discord/github", () => ({ mergedPullRequestCount: jest.fn(async () => 0) }));

const memberRoles = jest.fn<Promise<string[] | null>, [unknown, string]>();
jest.mock("../../discord/discordApi", () => ({
  addRole: jest.fn(async () => undefined),
  ensureRoles: jest.fn(async () => ({})),
  memberRoles: (...args: unknown[]) => memberRoles(...(args as [unknown, string])),
  registerCommands: jest.fn(async () => undefined),
  removeRole: jest.fn(async () => undefined),
}));

import type { DiscordMember } from "@prisma/client";

import { registerCommands } from "../../discord/discordApi";
import { recheckAll, recheckDelayMs, startDiscordRolesJob } from "../../discord/sync";
import { renderMetrics, _resetMetrics } from "../../metrics";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

function configure() {
  process.env.DISCORD_APPLICATION_ID = "1";
  process.env.DISCORD_PUBLIC_KEY = "k";
  process.env.DISCORD_BOT_TOKEN = "t";
  process.env.DISCORD_GUILD_ID = "2";
}

/** No sleeping between members: the pause is not what these tests are about. */
const noPause = () => Promise.resolve();

beforeEach(() => {
  members.clear();
  jest.clearAllMocks();
  configure();
  _resetMetrics();
  memberRoles.mockResolvedValue([]);
});

afterAll(() => {
  for (const name of [
    "DISCORD_APPLICATION_ID",
    "DISCORD_PUBLIC_KEY",
    "DISCORD_BOT_TOKEN",
    "DISCORD_GUILD_ID",
    "DISCORD_RECHECK_INTERVAL_MS",
    "DISCORD_RECHECK_TICK_MS",
    "DISCORD_ABSENT_CHECKS_BEFORE_BACKOFF",
    "DISCORD_ABSENT_RECHECK_INTERVAL_MS",
    "DISCORD_MAX_FAILURE_BACKOFF_MS",
  ]) {
    delete process.env[name];
  }
});

describe("deciding who is due", () => {
  it("checks a member whose last attempt is older than the interval", async () => {
    members.set("overdue", row({ discordUserId: "overdue", lastAttemptAt: new Date(Date.now() - 25 * HOUR) }));
    const summary = await recheckAll(noPause);
    expect(summary).toEqual({ checked: 1, failed: 0, skipped: 0 });
    expect(memberRoles).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a member checked an hour ago, even on a fresh process", async () => {
    members.set("recent", row({ discordUserId: "recent", lastAttemptAt: new Date(Date.now() - HOUR) }));
    const summary = await recheckAll(noPause);
    expect(summary.checked).toBe(0);
    expect(memberRoles).not.toHaveBeenCalled();
  });

  it("falls back to the last successful read for rows that predate lastAttemptAt", async () => {
    members.set("legacy", row({ discordUserId: "legacy", checkedAt: new Date(Date.now() - 2 * DAY) }));
    const summary = await recheckAll(noPause);
    expect(summary.checked).toBe(1);
  });

  it("does not re-check a member who pressed Refresh an hour ago", async () => {
    // Refresh writes `checkedAt` but never `lastAttemptAt`; the newer reading
    // is the one that decides whether they are due.
    members.set(
      "refreshed",
      row({
        discordUserId: "refreshed",
        lastAttemptAt: new Date(Date.now() - 2 * DAY),
        checkedAt: new Date(Date.now() - HOUR),
      }),
    );
    const summary = await recheckAll(noPause);
    expect(summary.checked).toBe(0);
    expect(memberRoles).not.toHaveBeenCalled();
  });
});

describe("a failing member", () => {
  it("is moved to the back of the queue, not picked first again", async () => {
    const started = new Date(Date.now() - 25 * HOUR);
    members.set("bad", row({ discordUserId: "bad", lastAttemptAt: started }));
    // A real failure path: Discord answers the member lookup with an error.
    memberRoles.mockRejectedValueOnce(new Error("Discord 500"));

    const first = await recheckAll(noPause);
    expect(first).toEqual({ checked: 0, failed: 1, skipped: 0 });

    const stored = members.get("bad")!;
    expect(stored.failedAttempts).toBe(1);
    expect(stored.lastAttemptAt!.getTime()).toBeGreaterThan(started.getTime());
    // A failed check never claims the roles were verified.
    expect(stored.checkedAt).toBeNull();

    // Straight away, their wait has doubled, so they are not due again.
    const second = await recheckAll(noPause);
    expect(second.checked).toBe(0);
    expect(memberRoles).toHaveBeenCalledTimes(1);
  });

  it("does not change any role", async () => {
    const { addRole, removeRole } = jest.requireMock("../../discord/discordApi") as {
      addRole: jest.Mock;
      removeRole: jest.Mock;
    };
    members.set("bad", row({ discordUserId: "bad", lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    memberRoles.mockRejectedValueOnce(new Error("role too low"));
    await recheckAll(noPause);
    expect(addRole).not.toHaveBeenCalled();
    expect(removeRole).not.toHaveBeenCalled();
  });

  it("waits longer each time, up to the configured ceiling", () => {
    process.env.DISCORD_RECHECK_INTERVAL_MS = `${HOUR}`;
    process.env.DISCORD_MAX_FAILURE_BACKOFF_MS = `${DAY}`;
    expect(recheckDelayMs(row({ discordUserId: "a", failedAttempts: 0 }))).toBe(HOUR);
    expect(recheckDelayMs(row({ discordUserId: "b", failedAttempts: 1 }))).toBe(2 * HOUR);
    expect(recheckDelayMs(row({ discordUserId: "c", failedAttempts: 2 }))).toBe(4 * HOUR);
    expect(recheckDelayMs(row({ discordUserId: "d", failedAttempts: 9 }))).toBe(DAY);
  });

  it("resets the failure count after a successful check", async () => {
    members.set(
      "recovered",
      row({ discordUserId: "recovered", lastAttemptAt: new Date(Date.now() - 3 * DAY), failedAttempts: 4 }),
    );
    await recheckAll(noPause);
    expect(members.get("recovered")!.failedAttempts).toBe(0);
  });
});

describe("a member who has left the server", () => {
  it("counts consecutive absence and keeps their row", async () => {
    members.set("gone", row({ discordUserId: "gone", lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    memberRoles.mockResolvedValue(null);
    await recheckAll(noPause);
    expect(members.has("gone")).toBe(true);
    expect(members.get("gone")!.absentChecks).toBe(1);
  });

  it("is checked weekly once the absence count is reached", async () => {
    process.env.DISCORD_ABSENT_CHECKS_BEFORE_BACKOFF = "2";
    process.env.DISCORD_ABSENT_RECHECK_INTERVAL_MS = `${WEEK}`;
    members.set(
      "gone",
      row({ discordUserId: "gone", lastAttemptAt: new Date(Date.now() - 2 * DAY), absentChecks: 2 }),
    );
    const summary = await recheckAll(noPause);
    expect(summary.checked).toBe(0);
    expect(memberRoles).not.toHaveBeenCalled();
  });

  it("comes back into the normal queue when they rejoin", async () => {
    members.set(
      "back",
      row({ discordUserId: "back", lastAttemptAt: new Date(Date.now() - 8 * DAY), absentChecks: 5 }),
    );
    await recheckAll(noPause);
    expect(members.get("back")!.absentChecks).toBe(0);
  });
});

describe("the metrics", () => {
  it("counts checked, failed and skipped, and reports the backlog age", async () => {
    members.set("ok", row({ discordUserId: "ok", lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    members.set("bad", row({ discordUserId: "bad", lastAttemptAt: new Date(Date.now() - 3 * DAY) }));
    memberRoles.mockImplementation(async (_config, userId) => {
      if (userId === "bad") throw new Error("boom");
      return [];
    });

    await recheckAll(noPause);

    const text = await renderMetrics();
    expect(text).toMatch(/discord_member_checks_total\{outcome="checked"\} 1/);
    expect(text).toMatch(/discord_member_checks_total\{outcome="failed"\} 1/);
    // Nothing was left over, but the series still exists at zero so a
    // dashboard can tell "no skips" from "no data".
    expect(text).toMatch(/discord_member_checks_total\{outcome="skipped"\} 0/);
    expect(text).toContain("discord_oldest_unchecked_age_seconds");
  });

  it("exports every outcome from the first scrape, even with nothing due", async () => {
    await recheckAll(noPause);

    const text = await renderMetrics();
    for (const outcome of ["checked", "failed", "skipped"]) {
      expect(text).toMatch(new RegExp(`discord_member_checks_total\\{outcome="${outcome}"\\} 0`));
    }
  });

  it("counts the members a full run could not reach as skipped", async () => {
    // One more than a run handles, so exactly one member is left over.
    for (let i = 0; i < 201; i += 1) {
      members.set(`m${i}`, row({ discordUserId: `m${i}`, lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    }

    const summary = await recheckAll(noPause);

    expect(summary).toEqual({ checked: 200, failed: 0, skipped: 1 });
    const text = await renderMetrics();
    expect(text).toMatch(/discord_member_checks_total\{outcome="skipped"\} 1/);
    // The leftover is the one still waiting, so the gauge is not zero.
    expect(text).toMatch(/discord_oldest_unchecked_age_seconds [1-9]/);
  });

  it("does not label a series with a Discord user id", async () => {
    members.set("secret-id", row({ discordUserId: "secret-id", lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    await recheckAll(noPause);
    expect(await renderMetrics()).not.toContain("secret-id");
  });
});

describe("starting the job", () => {
  it("creates no timer when the bot is not configured", () => {
    delete process.env.DISCORD_BOT_TOKEN;
    expect(startDiscordRolesJob()).toBeNull();
    expect(registerCommands).not.toHaveBeenCalled();
  });

  it("runs once at start rather than waiting a whole interval", async () => {
    members.set("overdue", row({ discordUserId: "overdue", lastAttemptAt: new Date(Date.now() - 2 * DAY) }));
    const timer = startDiscordRolesJob();
    expect(timer).not.toBeNull();
    try {
      // The start-up run is deliberately not awaited by the caller; wait for
      // it to finish rather than for a fixed delay, so nothing logs after the
      // test has ended.
      await waitFor(async () => (await renderMetrics()).includes('discord_member_checks_total{outcome="checked"} 1'));
      expect(members.get("overdue")!.failedAttempts).toBe(0);
    } finally {
      clearInterval(timer!);
    }
  });
});

/** Poll until `done()` is true, so no assertion races the background run. */
async function waitFor(done: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the background run");
    await new Promise((resolve) => setImmediate(resolve));
  }
}
