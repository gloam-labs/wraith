/**
 * Checking one member and making their Discord roles match.
 *
 * The same function runs when a member links, when they press Refresh, and on
 * a timer for everyone. That is what keeps a role honest: a Veil-ian that is
 * sold or a name that runs out stops counting at the next check.
 *
 * A read that fails never removes a role. See `chain.ts`: `null` is "could not
 * check", and `decideRoles` leaves those roles alone.
 */

import type { DiscordMember } from "@prisma/client";

import { prisma } from "../db";
import { logger } from "../logger";
import { recordDiscordChecks, setDiscordOldestUncheckedAge } from "../metrics";
import {
  activeNames,
  firstOperationAt,
  holdsVeilian,
  isVeilWallet,
  ownsAnyName,
  recentOperationCount,
  walletNonce,
} from "./chain";
import {
  absentChecksBeforeBackoff,
  absentRecheckIntervalMs,
  discordConfig,
  maxFailureBackoffMs,
  recheckIntervalMs,
  recheckTickMs,
  thresholds,
  type DiscordConfig,
} from "./config";
import { addRole, ensureRoles, memberRoles, registerCommands, removeRole } from "./discordApi";
import { mergedPullRequestCount } from "./github";
import { decideRoles, grantedNames, planChanges, type Decision, type MemberFacts, type RoleKey } from "./roles";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Readings older than this are dropped; a little past the window we measure. */
const HISTORY_KEEP_MS = 35 * 24 * 60 * 60 * 1000;

export interface NonceReading {
  at: string;
  nonce: number;
}

export function parseNonceHistory(value: unknown): NonceReading[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is NonceReading =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as NonceReading).at === "string" &&
      Number.isSafeInteger((entry as NonceReading).nonce),
  );
}

/**
 * Wallet actions in the last thirty days, from nonce readings.
 *
 * The baseline is the newest reading that is at least thirty days old, or the
 * oldest reading we have when none is that old (a member who linked last week
 * is measured from when they linked). Also returns the history to store.
 */
export function nonceActivity(
  history: readonly NonceReading[],
  nonce: number,
  now: number,
): { count: number; history: NonceReading[] } {
  const kept = history
    .filter((reading) => now - Date.parse(reading.at) <= HISTORY_KEEP_MS)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const old = kept.filter((reading) => now - Date.parse(reading.at) >= THIRTY_DAYS_MS);
  const baseline = old.length > 0 ? old[old.length - 1] : kept[0];
  const count = baseline ? Math.max(0, nonce - baseline.nonce) : 0;
  // One reading a day is enough; a Refresh pressed ten times adds nothing.
  const last = kept[kept.length - 1];
  const fresh = !last || now - Date.parse(last.at) >= 12 * 60 * 60 * 1000;
  return {
    count,
    history: fresh ? [...kept, { at: new Date(now).toISOString(), nonce }] : kept,
  };
}

export interface GatheredFacts {
  facts: MemberFacts;
  /** Values worth saving on the member row. */
  save: { names?: string[]; nonceHistory?: NonceReading[]; firstSeenAt?: Date };
}

function larger(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Ask the chain and GitHub everything the roles depend on. */
export async function gatherFacts(member: DiscordMember, now = Date.now()): Promise<GatheredFacts> {
  const addresses = [member.wallet, member.spending].filter((value): value is string => Boolean(value));
  const save: GatheredFacts["save"] = {};

  const [veilWallet, veilian, nonce, spendingOps, pullRequests] = await Promise.all([
    // A wallet the network cannot find today is "could not check", which
    // leaves the role as it is rather than taking it away.
    member.wallet
      ? isVeilWallet(member.wallet).then((answer) => (answer === "missing" ? null : answer))
      : Promise.resolve(false),
    holdsVeilian(addresses),
    member.wallet ? walletNonce(member.wallet) : Promise.resolve(null),
    member.spending ? recentOperationCount(member.spending, now) : Promise.resolve(null),
    member.githubLogin ? mergedPullRequestCount(member.githubLogin) : Promise.resolve(0),
  ]);

  let holdsName: boolean | null;
  if (addresses.length === 0) {
    holdsName = false;
  } else if (member.names.length > 0) {
    const active = await activeNames(member.names, addresses);
    holdsName = active === null ? null : active.length > 0;
    // A candidate that failed today is kept: it may be renewed tomorrow.
    if (active !== null && active.length === 0) holdsName = await ownsAnyName(addresses);
  } else {
    holdsName = await ownsAnyName(addresses);
  }

  let walletActivity: number | null = null;
  if (member.wallet && nonce !== null) {
    const measured = nonceActivity(parseNonceHistory(member.nonceHistory), nonce, now);
    walletActivity = measured.count;
    save.nonceHistory = measured.history;
  }
  // With neither address linked there is no activity to speak of: a definite 0.
  const recentTransactions = addresses.length === 0 ? 0 : larger(walletActivity, spendingOps);

  let firstSeenAt: Date | null | undefined = member.firstSeenAt ?? undefined;
  if (firstSeenAt === undefined && thresholds().earlyBefore) {
    if (!member.spending) {
      firstSeenAt = null;
    } else {
      const found = await firstOperationAt(member.spending);
      if (found) {
        firstSeenAt = found;
        save.firstSeenAt = found;
      }
    }
  }

  return {
    facts: {
      veilWallet,
      holdsName,
      holdsVeilian: veilian,
      recentTransactions,
      firstSeenAt,
      mergedPullRequests: pullRequests,
    },
    save,
  };
}

export interface SyncResult {
  /** False when the member has left the server. */
  inServer: boolean;
  decisions: Record<RoleKey, Decision>;
  granted: string[];
  /** True when at least one thing could not be checked this time. */
  incomplete: boolean;
}

/** Check one member and apply the difference to their roles. */
export async function syncMember(config: DiscordConfig, member: DiscordMember, now = Date.now()): Promise<SyncResult> {
  const { facts, save } = await gatherFacts(member, now);
  const decisions = decideRoles(facts, thresholds());
  const limits = thresholds();
  const incomplete = Object.entries(decisions).some(
    ([key, decision]) => decision === "unknown" && !(key === "early" && !limits.earlyBefore),
  );

  const current = await memberRoles(config, member.discordUserId);
  if (current !== null) {
    const roleIds = await ensureRoles(config);
    const changes = planChanges(decisions, roleIds, current);
    for (const id of changes.add) await addRole(config, member.discordUserId, id);
    for (const id of changes.remove) await removeRole(config, member.discordUserId, id);
  }

  await prisma.discordMember.update({
    where: { discordUserId: member.discordUserId },
    data: {
      checkedAt: new Date(now),
      ...(save.nonceHistory ? { nonceHistory: save.nonceHistory as unknown as object } : {}),
      ...(save.firstSeenAt ? { firstSeenAt: save.firstSeenAt } : {}),
    },
  });

  return { inServer: current !== null, decisions, granted: grantedNames(decisions), incomplete };
}

/**
 * Take every managed role off a member who has unlinked. Their row is already
 * gone, so the decisions are stated directly: nothing is theirs any more.
 */
export async function clearRoles(config: DiscordConfig, discordUserId: string): Promise<void> {
  const current = await memberRoles(config, discordUserId);
  if (current === null) return;
  const managed = new Set(Object.values(await ensureRoles(config)));
  for (const id of current) {
    if (managed.has(id)) await removeRole(config, discordUserId, id);
  }
}

/** Members checked per run, and the pause between them, to stay well inside rate limits. */
const BATCH_SIZE = 200;
const PAUSE_MS = 1_500;

/**
 * Rows a run reads to find the members that are due.
 *
 * The database can only filter on the base interval; a member on a backoff is
 * filtered out in memory. Reading a few batches' worth means a run still sees
 * the members a backoff has skipped over, so `skipped` counts something real.
 */
const CANDIDATE_WINDOW = BATCH_SIZE * 4;

/**
 * When this member was last attempted.
 *
 * `lastAttemptAt` is written by the background job for every attempt, success
 * or failure. `checkedAt` is written by any successful read, including one a
 * member asked for with Refresh, so the newer of the two is the honest answer:
 * a member checked by hand an hour ago is not due just because the job has not
 * touched them yet. Rows from before `lastAttemptAt` existed fall back to
 * `checkedAt`, then to when they linked.
 */
function lastAttemptOf(member: DiscordMember): number {
  const attempted = member.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const checked = member.checkedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const newest = Math.max(attempted, checked);
  return Number.isFinite(newest) ? newest : member.createdAt.getTime();
}

/**
 * How long to wait after this member's last attempt before trying again.
 *
 * Three cases, in order:
 *
 *  - **Gone from the server.** After {@link absentChecksBeforeBackoff}
 *    consecutive checks that found them missing, they are checked weekly. The
 *    row is kept: they may come back, and their roles with it.
 *  - **Kept failing.** Each consecutive failure doubles the wait, up to
 *    {@link maxFailureBackoffMs}. Without this, a member whose check throws
 *    keeps their old attempt time and is picked first again every day; once
 *    two hundred of them fail, nobody else is ever checked.
 *  - **Everything else.** The plain recheck interval.
 */
export function recheckDelayMs(member: DiscordMember): number {
  if (member.absentChecks >= absentChecksBeforeBackoff()) return absentRecheckIntervalMs();
  const base = recheckIntervalMs();
  if (member.failedAttempts <= 0) return base;
  return Math.min(maxFailureBackoffMs(), base * 2 ** Math.min(member.failedAttempts, 10));
}

/** True when this member's last attempt is old enough to try again. */
export function isDue(member: DiscordMember, now = Date.now()): boolean {
  return now - lastAttemptOf(member) >= recheckDelayMs(member);
}

export interface AttemptResult {
  /** False when the check found the member has left the server. */
  inServer: boolean;
  result: SyncResult;
}

/**
 * One attempt at one member, with the attempt itself recorded either way.
 *
 * The bookkeeping lives here rather than in {@link syncMember} because this is
 * the background path: a member pressing Refresh should not have their retry
 * counters moved by a check they asked for.
 *
 * A failure is recorded and then re-thrown to the caller. Nothing about the
 * member's roles is touched by it: `syncMember` only writes roles after a read
 * it could complete.
 */
export async function attemptMember(
  config: DiscordConfig,
  member: DiscordMember,
  now = Date.now(),
): Promise<AttemptResult> {
  try {
    const result = await syncMember(config, member, now);
    await prisma.discordMember.update({
      where: { discordUserId: member.discordUserId },
      data: {
        lastAttemptAt: new Date(now),
        failedAttempts: 0,
        absentChecks: result.inServer ? 0 : member.absentChecks + 1,
      },
    });
    return { inServer: result.inServer, result };
  } catch (error) {
    // If even this write fails the member stays due and the next tick retries.
    await prisma.discordMember
      .update({
        where: { discordUserId: member.discordUserId },
        data: { lastAttemptAt: new Date(now), failedAttempts: member.failedAttempts + 1 },
      })
      .catch(() => undefined);
    throw error;
  }
}

export interface RecheckSummary {
  checked: number;
  failed: number;
  /** Due, but left for a later run because this one was full. */
  skipped: number;
}

let running = false;

/**
 * Check the members whose last attempt is overdue, oldest attempt first.
 *
 * "Overdue" comes from the data, not from process uptime, so a restart no
 * longer postpones everybody by a whole day. Never throws: a failing member
 * goes to the back of the queue instead of stopping the run.
 */
export async function recheckAll(
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<RecheckSummary> {
  const summary: RecheckSummary = { checked: 0, failed: 0, skipped: 0 };
  const config = discordConfig();
  if (!config || running) return summary;
  running = true;
  const now = Date.now();
  try {
    // The SQL filter is the base interval, a superset of what is due; the
    // per-member backoff is applied below.
    const candidates = await prisma.discordMember.findMany({
      where: {
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: new Date(now - recheckIntervalMs()) } }],
      },
      orderBy: [{ lastAttemptAt: { sort: "asc", nulls: "first" } }],
      take: CANDIDATE_WINDOW,
    });
    const due = candidates.filter((member) => isDue(member, now));
    const batch = due.slice(0, BATCH_SIZE);
    summary.skipped = due.length - batch.length;

    for (const member of batch) {
      try {
        await attemptMember(config, member, now);
        summary.checked += 1;
      } catch (error) {
        // One member's failure (they left, Discord hiccuped) must not stop the
        // rest, and must not touch their roles.
        summary.failed += 1;
        logger.warn("discord.recheck.member_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      await pause(PAUSE_MS);
    }

    recordDiscordChecks("checked", summary.checked);
    recordDiscordChecks("failed", summary.failed);
    recordDiscordChecks("skipped", summary.skipped);
    setDiscordOldestUncheckedAge(backlogAgeSeconds(due.slice(BATCH_SIZE), now));

    logger.info("discord.recheck.done", {
      checked: summary.checked,
      failed: summary.failed,
      skipped: summary.skipped,
      candidates: candidates.length,
    });
  } catch (error) {
    logger.warn("discord.recheck.failed", { reason: error instanceof Error ? error.name : "unknown" });
  } finally {
    running = false;
  }
  return summary;
}

/**
 * How stale the queue this run could not reach is, in seconds.
 *
 * `waiting` is oldest-attempt-first, so its head is the member who has gone
 * longest without a check. Zero when the run got to everybody who was due.
 */
function backlogAgeSeconds(waiting: readonly DiscordMember[], now: number): number {
  const oldest = waiting[0];
  return oldest ? Math.max(0, Math.floor((now - lastAttemptOf(oldest)) / 1000)) : 0;
}

/**
 * Start the recheck, and tell Discord which commands exist.
 *
 * Runs once at start and then on a short tick, so a deploy no longer means the
 * check never runs at all. Does nothing at all when the bot is not configured:
 * no timer is created. Nothing here is awaited by startup and nothing here can
 * throw into it — the bot is an extra, and the service must come up the same
 * with it broken as with it absent.
 */
export function startDiscordRolesJob(): NodeJS.Timeout | null {
  const config = discordConfig();
  if (!config) return null;

  void registerCommands(config).catch((error) => {
    logger.warn("discord.commands.register_failed", { reason: error instanceof Error ? error.message : "unknown" });
  });

  void recheckAll().catch(() => undefined);
  const timer = setInterval(() => void recheckAll().catch(() => undefined), recheckTickMs());
  timer.unref();
  return timer;
}
