/**
 * From facts about a member to the roles they should have.
 *
 * Pure: no network, no database. Each fact is `true`, `false` or a number when
 * it was read, and `null` when it could not be. A role decided by a `null`
 * fact comes back as "unknown" and is left exactly as it is in Discord.
 *
 * Nothing here looks at a balance. A role that says how much someone holds
 * makes them a target, so activity is a count of transactions, never a sum.
 */

import type { Thresholds } from "./config";

export const ROLE_KEYS = [
  "wallet",
  "name",
  "veilian",
  "active",
  "power",
  "early",
  "contributor",
  "coreContributor",
  "topContributor",
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

/** The name each role carries in the server. The bot finds roles by name. */
export const ROLE_NAMES: Record<RoleKey, string> = {
  wallet: "Veil Wallet",
  name: "Name Holder",
  veilian: "Veil-ian",
  active: "Active",
  power: "Power User",
  early: "Early User",
  contributor: "Contributor",
  coreContributor: "Core Contributor",
  topContributor: "Top Contributor",
};

/** Colours in Veil's palette, as Discord's decimal RGB. */
export const ROLE_COLORS: Record<RoleKey, number> = {
  wallet: 0xfdda24,
  name: 0xb7ace8,
  veilian: 0x00a7b5,
  active: 0x8f959c,
  power: 0xe8ebee,
  early: 0xcaced3,
  contributor: 0x75797f,
  coreContributor: 0xb7ace8,
  topContributor: 0xfdda24,
};

export interface MemberFacts {
  /** The linked smart wallet runs Veil's code. False when none is linked. */
  veilWallet: boolean | null;
  holdsName: boolean | null;
  holdsVeilian: boolean | null;
  /** Transactions in the last thirty days. */
  recentTransactions: number | null;
  /** When the spending account first acted. Undefined: not looked up. */
  firstSeenAt: Date | null | undefined;
  /** Merged pull requests. Zero when no GitHub account is connected. */
  mergedPullRequests: number | null;
}

export type Decision = "grant" | "revoke" | "unknown";

function fromBoolean(value: boolean | null): Decision {
  if (value === null) return "unknown";
  return value ? "grant" : "revoke";
}

/**
 * One of several tiers, highest first. A member gets the single highest tier
 * they reach: a Power User is not also listed as Active.
 */
function tiered<K extends RoleKey>(
  count: number | null,
  tiers: readonly [K, number][],
): Record<K, Decision> {
  const out = {} as Record<K, Decision>;
  const reached = count === null ? null : tiers.find(([, minimum]) => count >= minimum)?.[0] ?? null;
  for (const [key] of tiers) {
    out[key] = count === null ? "unknown" : key === reached ? "grant" : "revoke";
  }
  return out;
}

export function decideRoles(facts: MemberFacts, limits: Thresholds): Record<RoleKey, Decision> {
  let early: Decision;
  if (!limits.earlyBefore) early = "unknown";
  else if (facts.firstSeenAt === undefined) early = "unknown";
  else if (facts.firstSeenAt === null) early = "revoke";
  else early = facts.firstSeenAt.getTime() < limits.earlyBefore.getTime() ? "grant" : "revoke";

  return {
    wallet: fromBoolean(facts.veilWallet),
    name: fromBoolean(facts.holdsName),
    veilian: fromBoolean(facts.holdsVeilian),
    early,
    ...tiered(facts.recentTransactions, [
      ["power", limits.power],
      ["active", limits.active],
    ]),
    ...tiered(facts.mergedPullRequests, [
      ["topContributor", limits.topContributor],
      ["coreContributor", limits.coreContributor],
      ["contributor", limits.contributor],
    ]),
  };
}

export interface RoleChanges {
  add: string[];
  remove: string[];
}

/**
 * The role ids to add and remove, given what the member has now.
 *
 * Only roles this bot manages are ever touched, and only where the decision is
 * definite. A role with no id (it does not exist in the server) is skipped.
 */
export function planChanges(
  decisions: Record<RoleKey, Decision>,
  roleIds: Partial<Record<RoleKey, string>>,
  current: readonly string[],
): RoleChanges {
  const has = new Set(current);
  const changes: RoleChanges = { add: [], remove: [] };
  for (const key of ROLE_KEYS) {
    const id = roleIds[key];
    if (!id) continue;
    if (decisions[key] === "grant" && !has.has(id)) changes.add.push(id);
    if (decisions[key] === "revoke" && has.has(id)) changes.remove.push(id);
  }
  return changes;
}

/** The names of the roles a set of decisions grants, for telling the member. */
export function grantedNames(decisions: Record<RoleKey, Decision>): string[] {
  return ROLE_KEYS.filter((key) => decisions[key] === "grant").map((key) => ROLE_NAMES[key]);
}
