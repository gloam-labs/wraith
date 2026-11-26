import { describe, it, expect, jest, afterEach } from "@jest/globals";
import { readIntEnv } from "../utils/env";

describe("readIntEnv", () => {
  it("returns defaultValue silently when unset", () => {
    const warn = jest.fn();
    const val = readIntEnv("POLL_INTERVAL_MS", {
      defaultValue: 6000,
      min: 500,
      max: 1_073_741_823,
      env: {},
      warn,
    });

    expect(val).toBe(6000);
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns valid whole numbers inside bounds without warning", () => {
    const warn = jest.fn();
    expect(
      readIntEnv("POLL_INTERVAL_MS", {
        defaultValue: 6000,
        min: 500,
        max: 1_073_741_823,
        env: { POLL_INTERVAL_MS: "500" },
        warn,
      }),
    ).toBe(500);
    expect(
      readIntEnv("EVENTS_BATCH_SIZE", {
        defaultValue: 10_000,
        min: 1,
        max: 10_000,
        env: { EVENTS_BATCH_SIZE: " 10000 " },
        warn,
      }),
    ).toBe(10_000);
    expect(
      readIntEnv("TOMBSTONE_CHECK_EVERY_CYCLES", {
        defaultValue: 100,
        min: 0,
        env: { TOMBSTONE_CHECK_EVERY_CYCLES: "0" },
        warn,
      }),
    ).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { label: "empty string", raw: "", min: 500, max: 10_000, def: 6000 },
    { label: "whitespace only", raw: "   ", min: 500, max: 10_000, def: 6000 },
    { label: "6s suffix", raw: "6s", min: 500, max: 10_000, def: 6000 },
    { label: "10k suffix", raw: "10k", min: 1, max: 10_000, def: 10_000 },
    { label: "NaN text (fast)", raw: "fast", min: 500, max: 10_000, def: 6000 },
    { label: "NaN text (often)", raw: "often", min: 0, max: 10_000, def: 100 },
    { label: "decimal", raw: "1.5", min: 1, max: 10_000, def: 1 },
    { label: "zero below floor", raw: "0", min: 500, max: 10_000, def: 6000 },
    { label: "below floor", raw: "100", min: 500, max: 10_000, def: 6000 },
    { label: "negative", raw: "-5", min: 0, max: 10_000, def: 100 },
    { label: "above ceiling", raw: "10001", min: 1, max: 10_000, def: 10_000 },
    { label: "unsafe integer", raw: "99999999999999999999", min: 1, max: Number.MAX_SAFE_INTEGER, def: 10_000 },
  ])(
    "falls back to default and logs one warning naming the variable for $label",
    ({ raw, min, max, def }) => {
      const warn = jest.fn();
      const val = readIntEnv("TEST_SETTING", {
        defaultValue: def,
        min,
        max,
        env: { TEST_SETTING: raw },
        warn,
      });

      expect(val).toBe(def);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("TEST_SETTING");
    },
  );
});

describe("indexer numeric env config", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it("falls back to safe defaults and does not run tombstone check every cycle when TOMBSTONE_CHECK_EVERY_CYCLES is invalid", async () => {
    process.env.POLL_INTERVAL_MS = "6s";
    process.env.EVENTS_BATCH_SIZE = "10001";
    process.env.INGEST_WORKERS = "0";
    process.env.TOMBSTONE_CHECK_EVERY_CYCLES = "often";

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tombstoneMock = jest.fn(async () => ({ tombstones: [], inserted: 0 }));

    jest.resetModules();
    jest.doMock("../indexer/tombstones", () => ({
      tombstoneExpiredContracts: tombstoneMock,
    }));

    const indexer = await import("../indexer");

    expect(warnSpy).toHaveBeenCalledTimes(4);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((m) => m.includes("POLL_INTERVAL_MS"))).toBe(true);
    expect(warnings.some((m) => m.includes("EVENTS_BATCH_SIZE"))).toBe(true);
    expect(warnings.some((m) => m.includes("INGEST_WORKERS"))).toBe(true);
    expect(warnings.some((m) => m.includes("TOMBSTONE_CHECK_EVERY_CYCLES"))).toBe(true);

    const loop = {
      network: "testnet",
      allContractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"],
      tombstoneCycleCount: 0,
    } as never;

    // Cycle 1 must NOT run the tombstone check (previously NaN ran every cycle)
    const ranFirst = await indexer.maybeTombstoneExpiredContracts(loop, 5_000_000);
    expect(ranFirst).toBe(false);
    expect(tombstoneMock).not.toHaveBeenCalled();

    // Reaches the default cadence of 100 cycles
    for (let i = 1; i < 99; i++) {
      await indexer.maybeTombstoneExpiredContracts(loop, 5_000_000);
    }
    expect(tombstoneMock).not.toHaveBeenCalled();

    const ranHundredth = await indexer.maybeTombstoneExpiredContracts(loop, 5_000_000);
    expect(ranHundredth).toBe(true);
    expect(tombstoneMock).toHaveBeenCalledTimes(1);
  });

  it("accepts TOMBSTONE_CHECK_EVERY_CYCLES=0 to disable tombstone checks without warning", async () => {
    process.env.TOMBSTONE_CHECK_EVERY_CYCLES = "0";

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const tombstoneMock = jest.fn(async () => ({ tombstones: [], inserted: 0 }));

    jest.resetModules();
    jest.doMock("../indexer/tombstones", () => ({
      tombstoneExpiredContracts: tombstoneMock,
    }));

    const indexer = await import("../indexer");
    expect(warnSpy).not.toHaveBeenCalled();

    const loop = {
      network: "testnet",
      allContractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM"],
      tombstoneCycleCount: 0,
    } as never;

    expect(await indexer.maybeTombstoneExpiredContracts(loop, 5_000_000)).toBe(false);
    expect(tombstoneMock).not.toHaveBeenCalled();
  });
});
