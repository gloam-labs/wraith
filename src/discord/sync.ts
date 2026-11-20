/**
 * Checking one member and making their Discord roles match.
 *
 * The same function runs when a member links, when they press Refresh, and
 * once a day for everyone. That is what keeps a role honest: a Veil-ian that
 * is sold or a name that runs out stops counting at the next check.
 *
 * A read that fails never removes a role. See `chain.ts`: `null` is "could not
 * check", and `decideRoles` leaves those roles alone.
 */

import { Prisma, type DiscordMember } from "@prisma/client";
import { when } from "../prismaWhen";

import { prisma } from "../db";
import { logger } from "../logger";
import {
  activeNames,
  firstOperationAt,
  holdsVeilian,
  isVeilWallet,
  ownsAnyName,
  recentOperationCount,
  walletNonce,
} from "./chain";
import { discordConfig, recheckIntervalMs, thresholds, type DiscordConfig } from "./config";
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
      ...when<Prisma.DiscordMemberUpdateInput>(Boolean(save.nonceHistory), {
        nonceHistory: save.nonceHistory as unknown as object,
      }),
      ...when<Prisma.DiscordMemberUpdateInput>(Boolean(save.firstSeenAt), {
        firstSeenAt: save.firstSeenAt,
      }),
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

let running = false;

/** Check every linked member once, oldest check first. Never throws. */
export async function recheckAll(pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<number> {
  const config = discordConfig();
  if (!config || running) return 0;
  running = true;
  let checked = 0;
  try {
    const members = await prisma.discordMember.findMany({
      orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }],
      take: BATCH_SIZE,
    });
    for (const member of members) {
      try {
        await syncMember(config, member);
        checked += 1;
      } catch (error) {
        // One member's failure (they left, Discord hiccuped) must not stop the rest.
        logger.warn("discord.recheck.member_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
      await pause(PAUSE_MS);
    }
    logger.info("discord.recheck.done", { checked, total: members.length });
  } catch (error) {
    logger.warn("discord.recheck.failed", { reason: error instanceof Error ? error.name : "unknown" });
  } finally {
    running = false;
  }
  return checked;
}

/**
 * Start the daily recheck, and tell Discord which commands exist.
 *
 * Does nothing at all when the bot is not configured. Nothing here is awaited
 * by startup and nothing here can throw into it: the bot is an extra, and the
 * service must come up the same with it broken as with it absent.
 */
export function startDiscordRolesJob(): NodeJS.Timeout | null {
  const config = discordConfig();
  if (!config) return null;

  void registerCommands(config).catch((error) => {
    logger.warn("discord.commands.register_failed", { reason: error instanceof Error ? error.message : "unknown" });
  });

  const timer = setInterval(() => void recheckAll(), recheckIntervalMs());
  timer.unref();
  return timer;
}
