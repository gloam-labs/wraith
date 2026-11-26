import type { Thresholds } from "../../discord/config";
import { decideRoles, grantedNames, planChanges, type MemberFacts } from "../../discord/roles";
import { nonceActivity, parseNonceHistory } from "../../discord/sync";

const LIMITS: Thresholds = {
  active: 3,
  power: 20,
  contributor: 1,
  coreContributor: 5,
  topContributor: 15,
  earlyBefore: new Date("2026-12-01T00:00:00Z"),
};

const NOTHING: MemberFacts = {
  veilWallet: false,
  holdsName: false,
  holdsVeilian: false,
  recentTransactions: 0,
  firstSeenAt: null,
  mergedPullRequests: 0,
};

describe("deciding roles", () => {
  it("grants nothing to a member with nothing", () => {
    expect(grantedNames(decideRoles(NOTHING, LIMITS))).toEqual([]);
  });

  it("grants each holding its own role", () => {
    const facts = { ...NOTHING, veilWallet: true, holdsName: true, holdsVeilian: true };
    expect(grantedNames(decideRoles(facts, LIMITS))).toEqual(["Veil Wallet", "Name Holder", "Veil-ian"]);
  });

  it("gives one activity tier, the highest reached", () => {
    expect(grantedNames(decideRoles({ ...NOTHING, recentTransactions: 2 }, LIMITS))).toEqual([]);
    expect(grantedNames(decideRoles({ ...NOTHING, recentTransactions: 3 }, LIMITS))).toEqual(["Active"]);
    const power = decideRoles({ ...NOTHING, recentTransactions: 20 }, LIMITS);
    expect(grantedNames(power)).toEqual(["Power User"]);
    expect(power.active).toBe("revoke");
  });

  it("gives one contributor tier, the highest reached", () => {
    expect(grantedNames(decideRoles({ ...NOTHING, mergedPullRequests: 1 }, LIMITS))).toEqual(["Contributor"]);
    expect(grantedNames(decideRoles({ ...NOTHING, mergedPullRequests: 7 }, LIMITS))).toEqual(["Core Contributor"]);
    expect(grantedNames(decideRoles({ ...NOTHING, mergedPullRequests: 40 }, LIMITS))).toEqual(["Top Contributor"]);
  });

  it("grants Early User only before the cutoff, and not at all without one", () => {
    const early = { ...NOTHING, firstSeenAt: new Date("2026-11-01T00:00:00Z") };
    const late = { ...NOTHING, firstSeenAt: new Date("2026-12-02T00:00:00Z") };
    expect(decideRoles(early, LIMITS).early).toBe("grant");
    expect(decideRoles(late, LIMITS).early).toBe("revoke");
    expect(decideRoles(early, { ...LIMITS, earlyBefore: null }).early).toBe("unknown");
  });

  it("leaves a role undecided when its fact could not be read", () => {
    const decisions = decideRoles(
      { ...NOTHING, veilWallet: null, holdsVeilian: null, recentTransactions: null, mergedPullRequests: null },
      LIMITS,
    );
    expect(decisions.wallet).toBe("unknown");
    expect(decisions.veilian).toBe("unknown");
    expect(decisions.active).toBe("unknown");
    expect(decisions.power).toBe("unknown");
    expect(decisions.topContributor).toBe("unknown");
    expect(decisions.name).toBe("revoke");
  });
});

describe("planning role changes", () => {
  const ids = { wallet: "r-wallet", name: "r-name", veilian: "r-veilian", active: "r-active" };

  it("adds what is missing and removes what no longer holds", () => {
    const decisions = decideRoles({ ...NOTHING, veilWallet: true, holdsName: true }, LIMITS);
    expect(planChanges(decisions, ids, ["r-name", "r-veilian", "someone-elses-role"])).toEqual({
      add: ["r-wallet"],
      remove: ["r-veilian"],
    });
  });

  it("never removes a role whose check failed", () => {
    const decisions = decideRoles({ ...NOTHING, holdsVeilian: null, recentTransactions: null }, LIMITS);
    expect(planChanges(decisions, ids, ["r-veilian", "r-active"])).toEqual({ add: [], remove: [] });
  });

  it("never touches a role the bot does not manage", () => {
    const changes = planChanges(decideRoles(NOTHING, LIMITS), ids, ["admin", "moderator"]);
    expect(changes).toEqual({ add: [], remove: [] });
  });
});

describe("activity from nonce readings", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-11-18T12:00:00Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();

  it("is zero on the first reading, which becomes the baseline", () => {
    const measured = nonceActivity([], 12, now);
    expect(measured.count).toBe(0);
    expect(measured.history).toEqual([{ at: at(0), nonce: 12 }]);
  });

  it("is measured from the oldest reading when none is thirty days old", () => {
    expect(nonceActivity([{ at: at(7), nonce: 10 }, { at: at(3), nonce: 14 }], 19, now).count).toBe(9);
  });

  it("is measured from the newest reading at least thirty days old", () => {
    const history = [{ at: at(34), nonce: 2 }, { at: at(31), nonce: 5 }, { at: at(10), nonce: 8 }];
    expect(nonceActivity(history, 11, now).count).toBe(6);
  });

  it("drops readings past the window and does not add two in one day", () => {
    const history = [{ at: at(60), nonce: 1 }, { at: at(0.1), nonce: 9 }];
    expect(nonceActivity(history, 9, now).history).toEqual([{ at: at(0.1), nonce: 9 }]);
  });

  it("ignores stored values that are not readings", () => {
    expect(parseNonceHistory([{ at: "x", nonce: 1 }, { nonce: 2 }, "junk", null])).toEqual([{ at: "x", nonce: 1 }]);
    expect(parseNonceHistory(null)).toEqual([]);
  });
});
