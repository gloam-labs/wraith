import { EventEmitter } from "events";
import type { TransferRecord } from "./db";
import type { HostFnRecord } from "./indexer/host-fn-log";
import type { Network } from "./network";
import {
  isSubscriptionChannel,
  recordSubscriptionEventDropped,
  type SubscriptionChannel,
} from "./metrics";

// Singleton emitter for real-time transfer notifications.
// setMaxListeners(0) removes the default 10-listener cap — one listener per
// active WebSocket subscriber is expected.
export const transferEmitter = new EventEmitter();
transferEmitter.setMaxListeners(0);

/**
 * A transfer as broadcast to live subscribers.
 *
 * Carries the network it was indexed on (#163). `TransferRecord` does not have
 * the column — the indexer adds it at write time — but a subscriber filtering
 * by network has nothing else to filter on, and a process indexing both chains
 * would otherwise push mainnet transfers to a testnet subscriber.
 */
export type TransferEvent = TransferRecord & { network: Network };

export function emitTransfer(transfer: TransferRecord, network: Network): void {
  transferEmitter.emit("transfer:new", { ...transfer, network });
}

// Singleton emitter for real-time host-fn log notifications (GraphQL
// subscriptions, #99). Mirrors transferEmitter above.
export const hostFnLogEmitter = new EventEmitter();
hostFnLogEmitter.setMaxListeners(0);

export type HostFnLogEvent = HostFnRecord & { network: Network };

export function emitHostFnLog(log: HostFnRecord, network: Network): void {
  hostFnLogEmitter.emit("hostfnlog:new", { ...log, network });
}

/**
 * The drop-counter channel for each event this module emits. Used only when a
 * caller does not name a channel itself. A Map, not an object literal, so an
 * event name such as "constructor" cannot resolve to an inherited property.
 */
const CHANNEL_BY_EVENT_NAME: ReadonlyMap<string, SubscriptionChannel> = new Map([
  ["transfer:new", "transfer"],
  ["hostfnlog:new", "hostfnlog"],
]);

export interface EventsToAsyncIteratorOptions {
  /** Most unread events held for this subscriber before the oldest is dropped. Default 100. */
  maxQueue?: number;
  /**
   * Label for `subscription_events_dropped_total`. When omitted (or not one of
   * SUBSCRIPTION_CHANNELS), it falls back to the channel of `eventName` if that
   * is one of the two events above; otherwise drops still happen but are not
   * counted, because the label may only take the fixed values.
   */
  channel?: SubscriptionChannel;
}

/**
 * Turn an EventEmitter channel into a pull-based AsyncIterableIterator, the
 * shape GraphQL subscription resolvers require.
 *
 * Bounds memory for a slow consumer: once more than `maxQueue` events have
 * piled up waiting to be pulled, the oldest queued event is dropped so a
 * stalled subscriber can never grow the queue unboundedly. Every drop is
 * counted in `subscription_events_dropped_total{channel}` (#453).
 */
export function eventsToAsyncIterator<T>(
  emitter: EventEmitter,
  eventName: string,
  options: EventsToAsyncIteratorOptions = {}
): AsyncIterableIterator<T> {
  const maxQueue = options.maxQueue ?? 100;
  const channel: SubscriptionChannel | undefined = isSubscriptionChannel(options.channel)
    ? options.channel
    : CHANNEL_BY_EVENT_NAME.get(eventName);

  const pullQueue: Array<(result: IteratorResult<T>) => void> = [];
  const pushQueue: T[] = [];
  let listening = true;

  const pushValue = (value: T) => {
    if (pullQueue.length > 0) {
      const resolve = pullQueue.shift()!;
      resolve({ value, done: false });
      return;
    }

    pushQueue.push(value);
    if (pushQueue.length > maxQueue) {
      pushQueue.shift();
      if (channel) recordSubscriptionEventDropped(channel);
    }
  };

  emitter.on(eventName, pushValue);

  const stop = () => {
    if (!listening) return;
    listening = false;
    emitter.off(eventName, pushValue);
    while (pullQueue.length > 0) {
      pullQueue.shift()!({ value: undefined as unknown as T, done: true });
    }
  };

  const iterator: AsyncIterableIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      // Values already queued are still handed out after return() or throw():
      // stop() detaches the listener and ends waiting pulls, but does not
      // discard what was received before it. Only once the queue is empty does
      // next() report done. A consumer that called return() normally stops
      // pulling, and the WebSocket loop in src/graphql/subscriptions.ts breaks
      // out once its subscription is gone; src/__tests__/events.test.ts pins it.
      if (pushQueue.length > 0) {
        return Promise.resolve({ value: pushQueue.shift()!, done: false });
      }
      if (!listening) {
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      }
      return new Promise((resolve) => pullQueue.push(resolve));
    },
    return(): Promise<IteratorResult<T>> {
      stop();
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    throw(err): Promise<IteratorResult<T>> {
      stop();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return iterator;
}

/**
 * Wrap an async iterator so only values matching `predicate` are yielded,
 * used to apply subscription arguments (e.g. contractId) without adding a
 * dedicated listener per filter combination.
 *
 * `next()` keeps pulling until a value matches, so on a stream where nothing
 * matches it does not resolve until the inner iterator ends. That is expected:
 * return() (or throw()) is forwarded to the inner iterator, which ends the
 * waiting pull with `done`.
 */
export function filterAsyncIterator<T>(
  iterator: AsyncIterableIterator<T>,
  predicate: (value: T) => boolean
): AsyncIterableIterator<T> {
  const filtered: AsyncIterableIterator<T> = {
    async next(): Promise<IteratorResult<T>> {
      while (true) {
        const result = await iterator.next();
        if (result.done || predicate(result.value)) {
          return result;
        }
      }
    },
    return(value?: unknown): Promise<IteratorResult<T>> {
      return iterator.return
        ? (iterator.return(value) as Promise<IteratorResult<T>>)
        : Promise.resolve({ value: undefined as unknown as T, done: true });
    },
    throw(err): Promise<IteratorResult<T>> {
      return iterator.throw
        ? iterator.throw(err)
        : Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return filtered;
    },
  };

  return filtered;
}
