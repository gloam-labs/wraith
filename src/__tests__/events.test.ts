/**
 * The in-process event channels and the async iterators GraphQL subscriptions
 * are built on (#453).
 *
 * Everything here runs on microtasks only: no fake or real timers, no sleeps.
 * "Still pending" is checked by letting the microtask queue drain and then
 * looking at whether a promise has settled.
 */
import { EventEmitter } from "events";
import { StrKey } from "@stellar/stellar-sdk";
import {
  emitHostFnLog,
  emitTransfer,
  eventsToAsyncIterator,
  filterAsyncIterator,
  hostFnLogEmitter,
  transferEmitter,
  type HostFnLogEvent,
  type TransferEvent,
} from "../events";
import type { TransferRecord } from "../db";
import type { HostFnRecord } from "../indexer/host-fn-log";
import {
  SUBSCRIPTION_CHANNELS,
  _resetMetrics,
  registry,
  subscriptionEventsDroppedTotal,
  type SubscriptionChannel,
} from "../metrics";

const EVENT = "test:event";

const contract = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const account = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));

/** Let every already-scheduled promise callback run. Microtasks only. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Watch a promise without awaiting it, to assert it is still pending. */
function track<T>(promise: Promise<T>): { settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    }
  );
  return state;
}

/** Current value of subscription_events_dropped_total for one channel. */
async function dropped(channel: string): Promise<number> {
  const { values } = await subscriptionEventsDroppedTotal.get();
  return values.find((v) => v.labels.channel === channel)?.value ?? 0;
}

/** Every exposed sample line of the drop counter. */
async function droppedSeries(): Promise<string[]> {
  return (await registry.metrics())
    .split("\n")
    .filter((line) => line.startsWith("subscription_events_dropped_total{"));
}

const DONE = { value: undefined, done: true } as const;

beforeEach(() => {
  _resetMetrics();
});

describe("eventsToAsyncIterator", () => {
  it("delivers values in order when they are read as fast as they are sent", async () => {
    const emitter = new EventEmitter();
    const iter = eventsToAsyncIterator<number>(emitter, EVENT);

    const received: number[] = [];
    for (let i = 0; i < 5; i++) {
      const pending = iter.next();
      emitter.emit(EVENT, i);
      const result = await pending;
      expect(result.done).toBe(false);
      received.push(result.value);
    }

    expect(received).toEqual([0, 1, 2, 3, 4]);
    await iter.return!();
  });

  it("delivers a burst below maxQueue in order once the reader catches up", async () => {
    const emitter = new EventEmitter();
    const iter = eventsToAsyncIterator<number>(emitter, EVENT, { maxQueue: 10 });

    for (let i = 0; i < 10; i++) emitter.emit(EVENT, i);

    const received: number[] = [];
    for (let i = 0; i < 10; i++) received.push((await iter.next()).value);
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await iter.return!();
  });

  it("keeps a waiting next() pending, then resolves it when a value arrives", async () => {
    const emitter = new EventEmitter();
    const iter = eventsToAsyncIterator<string>(emitter, EVENT);

    const pending = iter.next();
    const state = track(pending);
    await settle();
    expect(state.settled).toBe(false);

    emitter.emit(EVENT, "hello");
    await expect(pending).resolves.toEqual({ value: "hello", done: false });
    await iter.return!();
  });

  describe("a reader slower than maxQueue", () => {
    it("drops the oldest, keeps the newest, and counts each drop on its channel only", async () => {
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator<number>(emitter, EVENT, {
        maxQueue: 3,
        channel: "transfer",
      });

      for (let i = 0; i < 8; i++) emitter.emit(EVENT, i);

      // 8 sent into a queue of 3: values 0..4 are gone, 5..7 survive.
      expect(await dropped("transfer")).toBe(5);
      expect(await dropped("hostfnlog")).toBe(0);
      expect(await droppedSeries()).toEqual(['subscription_events_dropped_total{channel="transfer"} 5']);

      expect(await iter.next()).toEqual({ value: 5, done: false });
      expect(await iter.next()).toEqual({ value: 6, done: false });
      expect(await iter.next()).toEqual({ value: 7, done: false });

      // Queue drained: the next pull waits rather than inventing a value.
      const state = track(iter.next());
      await settle();
      expect(state.settled).toBe(false);
      await iter.return!();
    });

    it("drops nothing at exactly maxQueue unread values", async () => {
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator<number>(emitter, EVENT, { maxQueue: 3, channel: "transfer" });

      for (let i = 0; i < 3; i++) emitter.emit(EVENT, i);

      expect(await dropped("transfer")).toBe(0);
      expect(await iter.next()).toEqual({ value: 0, done: false });
      await iter.return!();
    });

    it("defaults maxQueue to 100", async () => {
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator<number>(emitter, EVENT, { channel: "hostfnlog" });

      for (let i = 0; i < 101; i++) emitter.emit(EVENT, i);

      expect(await dropped("hostfnlog")).toBe(1);
      expect(await iter.next()).toEqual({ value: 1, done: false });
      await iter.return!();
    });

    it("does not count values handed straight to a waiting next()", async () => {
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator<number>(emitter, EVENT, { maxQueue: 1, channel: "transfer" });

      for (let i = 0; i < 5; i++) {
        const pending = iter.next();
        emitter.emit(EVENT, i);
        await pending;
      }

      expect(await dropped("transfer")).toBe(0);
      await iter.return!();
    });
  });

  describe("drop counter channel", () => {
    it("falls back to the channel of the two known event names", async () => {
      const transfers = new EventEmitter();
      const logs = new EventEmitter();
      const t = eventsToAsyncIterator(transfers, "transfer:new", { maxQueue: 1 });
      const l = eventsToAsyncIterator(logs, "hostfnlog:new", { maxQueue: 1 });

      for (let i = 0; i < 3; i++) transfers.emit("transfer:new", i);
      for (let i = 0; i < 4; i++) logs.emit("hostfnlog:new", i);

      expect(await dropped("transfer")).toBe(2);
      expect(await dropped("hostfnlog")).toBe(3);
      await t.return!();
      await l.return!();
    });

    it("uses an explicit channel over the event name", async () => {
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator(emitter, "transfer:new", { maxQueue: 1, channel: "hostfnlog" });

      for (let i = 0; i < 3; i++) emitter.emit("transfer:new", i);

      expect(await dropped("hostfnlog")).toBe(2);
      expect(await dropped("transfer")).toBe(0);
      await iter.return!();
    });

    it("still bounds the queue but counts nothing for an unknown event name", async () => {
      // The label may only take the two fixed values, so an event that maps to
      // neither cannot be counted under some third name.
      for (const eventName of [EVENT, "constructor", "toString"]) {
        const emitter = new EventEmitter();
        const iter = eventsToAsyncIterator<number>(emitter, eventName, { maxQueue: 2 });

        for (let i = 0; i < 5; i++) emitter.emit(eventName, i);

        expect(await iter.next()).toEqual({ value: 3, done: false });
        await iter.return!();
      }
      expect(await droppedSeries()).toEqual([]);
    });

    it("never turns an invalid channel string into a label value", async () => {
      const emitter = new EventEmitter();
      const bogus = "wallet" as SubscriptionChannel; // what an untyped caller could pass
      const unknown = eventsToAsyncIterator(emitter, EVENT, { maxQueue: 1, channel: bogus });
      const known = eventsToAsyncIterator(emitter, "transfer:new", { maxQueue: 1, channel: bogus });

      for (let i = 0; i < 3; i++) {
        emitter.emit(EVENT, i);
        emitter.emit("transfer:new", i);
      }

      // The unknown event is not counted; the known one falls back to its own channel.
      expect(await droppedSeries()).toEqual(['subscription_events_dropped_total{channel="transfer"} 2']);
      await unknown.return!();
      await known.return!();
    });

    it("has exactly two possible label values, and exposes no others", async () => {
      expect(SUBSCRIPTION_CHANNELS).toEqual(["transfer", "hostfnlog"]);

      const emitter = new EventEmitter();
      const iters = [
        eventsToAsyncIterator(emitter, "transfer:new", { maxQueue: 0 }),
        eventsToAsyncIterator(emitter, "hostfnlog:new", { maxQueue: 0 }),
        eventsToAsyncIterator(emitter, EVENT, { maxQueue: 0 }),
      ];
      emitter.emit("transfer:new", 1);
      emitter.emit("hostfnlog:new", 1);
      emitter.emit(EVENT, 1);

      const series = await droppedSeries();
      expect(series).toHaveLength(2);
      for (const line of series) {
        expect(line).toMatch(/^subscription_events_dropped_total\{channel="(transfer|hostfnlog)"\} \d+$/);
      }
      for (const iter of iters) await iter.return!();
    });
  });

  describe("return()", () => {
    it("ends a waiting next() and removes its listener", async () => {
      const emitter = new EventEmitter();
      // An unrelated listener, so "back to what it was" is not trivially zero.
      emitter.on(EVENT, () => undefined);
      const before = emitter.listenerCount(EVENT);

      const iter = eventsToAsyncIterator<number>(emitter, EVENT);
      expect(emitter.listenerCount(EVENT)).toBe(before + 1);

      const pending = iter.next();
      await expect(iter.return!()).resolves.toEqual(DONE);
      await expect(pending).resolves.toEqual(DONE);
      expect(emitter.listenerCount(EVENT)).toBe(before);

      // Nothing sent afterwards reaches the closed iterator.
      emitter.emit(EVENT, 1);
      await expect(iter.next()).resolves.toEqual(DONE);
    });

    it("is safe to call twice", async () => {
      const emitter = new EventEmitter();
      const before = emitter.listenerCount(EVENT);
      const iter = eventsToAsyncIterator<number>(emitter, EVENT);

      await iter.return!();
      await expect(iter.return!()).resolves.toEqual(DONE);
      expect(emitter.listenerCount(EVENT)).toBe(before);
    });

    it("runs when a for await loop breaks, releasing the listener", async () => {
      const emitter = new EventEmitter();
      const before = emitter.listenerCount(EVENT);
      const iter = eventsToAsyncIterator<number>(emitter, EVENT);
      emitter.emit(EVENT, 1);
      emitter.emit(EVENT, 2);

      const seen: number[] = [];
      for await (const value of iter) {
        seen.push(value);
        break;
      }

      expect(seen).toEqual([1]);
      expect(emitter.listenerCount(EVENT)).toBe(before);
    });

    it("still hands out values queued before it, then reports done", async () => {
      // Surprising but harmless, so pinned rather than changed: stop() detaches
      // the listener and ends waiting pulls, but keeps what was already queued.
      // A consumer that called return() does not call next() again, and the
      // WebSocket loop in src/graphql/subscriptions.ts breaks out on its own.
      const emitter = new EventEmitter();
      const iter = eventsToAsyncIterator<number>(emitter, EVENT);
      emitter.emit(EVENT, 1);
      emitter.emit(EVENT, 2);

      await iter.return!();

      expect(await iter.next()).toEqual({ value: 1, done: false });
      expect(await iter.next()).toEqual({ value: 2, done: false });
      expect(await iter.next()).toEqual(DONE);
    });
  });

  describe("throw()", () => {
    it("rejects with the error, ends a waiting next(), and removes its listener", async () => {
      const emitter = new EventEmitter();
      emitter.on(EVENT, () => undefined);
      const before = emitter.listenerCount(EVENT);
      const iter = eventsToAsyncIterator<number>(emitter, EVENT);

      const pending = iter.next();
      const err = new Error("subscriber went away");
      await expect(iter.throw!(err)).rejects.toBe(err);
      await expect(pending).resolves.toEqual(DONE);
      expect(emitter.listenerCount(EVENT)).toBe(before);
    });
  });
});

describe("filterAsyncIterator", () => {
  const isEven = (n: number) => n % 2 === 0;

  it("passes only matching values, in order", async () => {
    const emitter = new EventEmitter();
    const iter = filterAsyncIterator(eventsToAsyncIterator<number>(emitter, EVENT), isEven);

    for (let i = 1; i <= 6; i++) emitter.emit(EVENT, i);

    expect(await iter.next()).toEqual({ value: 2, done: false });
    expect(await iter.next()).toEqual({ value: 4, done: false });
    expect(await iter.next()).toEqual({ value: 6, done: false });
    await iter.return!();
  });

  it("keeps next() pending while nothing matches, and return() still ends it", async () => {
    // Expected: next() loops until a value passes, so on a stream where nothing
    // matches it waits. What matters is that return() can always end the wait.
    const emitter = new EventEmitter();
    const before = emitter.listenerCount(EVENT);
    const iter = filterAsyncIterator(eventsToAsyncIterator<number>(emitter, EVENT), isEven);

    const pending = iter.next();
    const state = track(pending);
    emitter.emit(EVENT, 1);
    emitter.emit(EVENT, 3);
    await settle();
    expect(state.settled).toBe(false);

    await expect(iter.return!()).resolves.toEqual(DONE);
    await expect(pending).resolves.toEqual(DONE);
    expect(emitter.listenerCount(EVENT)).toBe(before);
  });

  it("forwards return() to the inner iterator", async () => {
    const emitter = new EventEmitter();
    const before = emitter.listenerCount(EVENT);
    const inner = eventsToAsyncIterator<number>(emitter, EVENT);
    const iter = filterAsyncIterator(inner, isEven);

    await expect(iter.return!()).resolves.toEqual(DONE);
    expect(emitter.listenerCount(EVENT)).toBe(before);
    await expect(inner.next()).resolves.toEqual(DONE);
  });

  it("forwards throw() to the inner iterator", async () => {
    const emitter = new EventEmitter();
    const before = emitter.listenerCount(EVENT);
    const iter = filterAsyncIterator(eventsToAsyncIterator<number>(emitter, EVENT), isEven);

    const err = new Error("boom");
    await expect(iter.throw!(err)).rejects.toBe(err);
    expect(emitter.listenerCount(EVENT)).toBe(before);
  });

  it("ends cleanly around an inner iterator that has no return() or throw()", async () => {
    const inner: AsyncIterableIterator<number> = {
      next: () => Promise.resolve(DONE as IteratorResult<number>),
      [Symbol.asyncIterator]() {
        return inner;
      },
    };
    const iter = filterAsyncIterator(inner, isEven);

    await expect(iter.return!()).resolves.toEqual(DONE);
    const err = new Error("boom");
    await expect(iter.throw!(err)).rejects.toBe(err);
  });

  it("counts drops before filtering", async () => {
    // Pinned: the queue sits inside eventsToAsyncIterator, before the filter.
    // A slow subscriber's queue fills with every event on the channel, so the
    // count includes events its filter would have discarded anyway.
    const emitter = new EventEmitter();
    const iter = filterAsyncIterator(
      eventsToAsyncIterator<number>(emitter, EVENT, { maxQueue: 2, channel: "transfer" }),
      isEven
    );

    for (let i = 1; i <= 5; i++) emitter.emit(EVENT, i); // queue keeps 4, 5

    expect(await dropped("transfer")).toBe(3);
    expect(await iter.next()).toEqual({ value: 4, done: false });
    await iter.return!();
  });
});

describe("emitTransfer and emitHostFnLog", () => {
  it("emitTransfer sends the transfer with its network on transferEmitter", async () => {
    const before = transferEmitter.listenerCount("transfer:new");
    const iter = eventsToAsyncIterator<TransferEvent>(transferEmitter, "transfer:new", {
      channel: "transfer",
    });

    const transfer: TransferRecord = {
      contractId: contract(1),
      eventType: "transfer",
      fromAddress: account(2),
      toAddress: account(3),
      amount: "1250000",
      ledger: 500_123,
      ledgerClosedAt: new Date("2026-01-02T03:04:05.000Z"),
      txHash: "ab".repeat(32),
      eventId: "0002147994714263552-0000000001",
    };
    expect(StrKey.isValidContract(transfer.contractId)).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(transfer.fromAddress!)).toBe(true);

    emitTransfer(transfer, "mainnet");

    expect(await iter.next()).toEqual({ value: { ...transfer, network: "mainnet" }, done: false });
    // The caller's record is copied, not tagged in place.
    expect(transfer).not.toHaveProperty("network");

    await iter.return!();
    expect(transferEmitter.listenerCount("transfer:new")).toBe(before);
  });

  it("emitHostFnLog sends the log with its network on hostFnLogEmitter", async () => {
    const before = hostFnLogEmitter.listenerCount("hostfnlog:new");
    const iter = eventsToAsyncIterator<HostFnLogEvent>(hostFnLogEmitter, "hostfnlog:new", {
      channel: "hostfnlog",
    });

    const log: HostFnRecord = {
      contractId: contract(4),
      functionName: "swap",
      args: [1, "two"],
      result: { ok: true },
      gasUsed: BigInt(42_000),
      ledger: 500_124,
      ledgerClosedAt: new Date("2026-01-02T03:04:10.000Z"),
      txHash: "cd".repeat(32),
      eventId: "0002147999009230848-0000000000",
    };
    expect(StrKey.isValidContract(log.contractId)).toBe(true);

    emitHostFnLog(log, "testnet");

    expect(await iter.next()).toEqual({ value: { ...log, network: "testnet" }, done: false });
    expect(log).not.toHaveProperty("network");

    await iter.return!();
    expect(hostFnLogEmitter.listenerCount("hostfnlog:new")).toBe(before);
  });
});
