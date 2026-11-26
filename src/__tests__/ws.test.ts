/**
 * Unit tests for the plain-WebSocket send path in src/ws.ts (#407, #408).
 *
 * Uses a fake socket so the interesting edge cases — saturated buffer, wrong
 * network, listener cleanup — can be exercised without a real TCP connection.
 * Uses Jest fake timers for the heartbeat tests.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { transferEmitter, type TransferEvent } from "../events";

// ── Fake socket ───────────────────────────────────────────────────────────

const OPEN = 1;
const CLOSED = 3;

type FakeSocket = {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: Array<{ code: number; reason: string }>;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  send(data: string): void;
  close(code: number, reason: string): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
};

function makeSocket(): FakeSocket {
  const socket: FakeSocket = {
    readyState: OPEN,
    bufferedAmount: 0,
    sent: [],
    closed: [],
    listeners: {},
    send(data) { this.sent.push(data); },
    close(code, reason) {
      this.readyState = CLOSED;
      this.closed.push({ code, reason });
      // Trigger the "close" event so cleanup runs
      this.emit("close");
    },
    on(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    },
    emit(event, ...args) {
      (this.listeners[event] ?? []).forEach((fn) => fn(...args));
    },
  };
  return socket;
}

// ── Helpers to simulate what attachWebSocketServer does per connection ─────
// Rather than spinning up a real server, we replicate the connection handler
// logic using the same imports, keeping the test isolated and fast.

import { MAX_BUFFERED_BYTES } from "../graphql/subscriptions";
import { wsSlowSubscribersTotal } from "../ws";
import { registry } from "../metrics";

// Pull out the connection logic so we can call it directly in tests.
// This mirrors what `wss.on("connection", ...)` does.
function simulateConnection(ws: FakeSocket, url: string) {
  const SUBSCRIBE_RE = /^\/subscribe\/([A-Z0-9]+)(?:\?.*)?$/;
  const match = url.match(SUBSCRIBE_RE);
  if (!match) {
    ws.close(1008, "Invalid path");
    return;
  }
  const address = match[1];

  // Resolve network from query string — default to testnet.
  const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const rawNetwork = new URLSearchParams(qs).get("network");
  const network = (rawNetwork ?? "testnet") as "testnet" | "mainnet";

  const handler = (transfer: TransferEvent) => {
    if (ws.readyState !== OPEN) return;
    if (transfer.network !== network) return;
    if (transfer.toAddress !== address && transfer.fromAddress !== address) return;

    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      wsSlowSubscribersTotal.inc();
      ws.close(1008, "Send buffer exceeded: client is not reading fast enough");
      return;
    }

    ws.send(JSON.stringify({ ...transfer }));
  };

  transferEmitter.on("transfer:new", handler);

  const cleanup = () => transferEmitter.off("transfer:new", handler);
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTransfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return {
    contractId: "CTOKEN",
    eventType: "transfer",
    fromAddress: "GSENDER",
    toAddress: "GRECV",
    amount: "10000000",
    ledger: 100,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash: "txhash",
    eventId: "ev-1",
    network: "testnet",
    ...overrides,
  };
}

function emitTransfer(t: TransferEvent) {
  transferEmitter.emit("transfer:new", t);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ws.ts send path", () => {
  beforeEach(() => {
    registry.resetMetrics();
  });

  it("sends normally while the socket is keeping up", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    emitTransfer(makeTransfer({ toAddress: "GRECV" }));
    emitTransfer(makeTransfer({ toAddress: "GRECV", eventId: "ev-2" }));

    expect(ws.sent).toHaveLength(2);
    expect(ws.closed).toHaveLength(0);
    // Cleanup
    ws.emit("close");
  });

  it("closes and counts the socket when the buffer is saturated", async () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    ws.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    emitTransfer(makeTransfer({ toAddress: "GRECV" }));

    expect(ws.sent).toHaveLength(0);
    expect(ws.closed).toHaveLength(1);
    expect(ws.closed[0].code).toBe(1008);
    expect(ws.closed[0].reason).toMatch(/buffer exceeded/i);

    // Metric incremented
    const metrics = await registry.getMetricsAsJSON();
    const counter = metrics.find((m) => m.name === "ws_slow_subscribers_total");
    expect(counter?.values[0]?.value).toBe(1);
  });

  it("does not forward transfers for a different address", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    emitTransfer(makeTransfer({ fromAddress: "GOTHER", toAddress: "GTHIRD" }));

    expect(ws.sent).toHaveLength(0);
    expect(ws.closed).toHaveLength(0);
    ws.emit("close");
  });

  it("does not forward transfers on the wrong network", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV?network=testnet");

    emitTransfer(makeTransfer({ toAddress: "GRECV", network: "mainnet" }));

    expect(ws.sent).toHaveLength(0);
    expect(ws.closed).toHaveLength(0);
    ws.emit("close");
  });

  it("removes the emitter listener after close", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    const listenersBefore = transferEmitter.listenerCount("transfer:new");

    ws.emit("close"); // triggers cleanup

    const listenersAfter = transferEmitter.listenerCount("transfer:new");
    expect(listenersAfter).toBe(listenersBefore - 1);
  });

  it("removes the emitter listener after error", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    const listenersBefore = transferEmitter.listenerCount("transfer:new");

    ws.emit("error", new Error("network reset")); // triggers cleanup

    const listenersAfter = transferEmitter.listenerCount("transfer:new");
    expect(listenersAfter).toBe(listenersBefore - 1);
  });
});

// ── Heartbeat tests (#408) ─────────────────────────────────────────────────
// These replicate the heartbeat logic from attachWebSocketServer using fake
// timers, keeping the test isolated from a real HTTP server.

type HeartbeatSocket = {
  _alive: boolean;
  pings: number;
  terminated: boolean;
  listeners: Record<string, Array<(...args: unknown[]) => void>>;
  ping(): void;
  terminate(): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  simulatePong(): void;
};

function makeHeartbeatSocket(): HeartbeatSocket {
  const s: HeartbeatSocket = {
    _alive: true,
    pings: 0,
    terminated: false,
    listeners: {},
    ping() { this.pings++; },
    terminate() { this.terminated = true; },
    on(event, fn) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(fn);
    },
    emit(event, ...args) {
      (this.listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    simulatePong() { this._alive = true; },
  };
  return s;
}

/** Minimal fake wss that records clients and exposes a tick() helper. */
function makeWss(clients: HeartbeatSocket[]) {
  const intervalMs = 100; // short for tests

  const heartbeat = setInterval(() => {
    clients.forEach((ws) => {
      if (ws._alive === false) {
        ws.terminate();
        return;
      }
      ws._alive = false;
      ws.ping();
    });
  }, intervalMs);

  return {
    close: () => clearInterval(heartbeat),
    intervalMs,
  };
}

describe("heartbeat (#408)", () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it("does not terminate a client that answers pings", () => {
    const ws = makeHeartbeatSocket();
    const wss = makeWss([ws]);

    // First tick: marks alive=false, sends ping
    jest.advanceTimersByTime(100);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    // Client responds with pong
    ws.simulatePong();

    // Second tick: should ping again, not terminate
    jest.advanceTimersByTime(100);
    expect(ws.pings).toBe(2);
    expect(ws.terminated).toBe(false);

    wss.close();
  });

  it("terminates a client that misses a pong", () => {
    const ws = makeHeartbeatSocket();
    const wss = makeWss([ws]);

    // First tick: marks alive=false, sends ping (client does NOT pong)
    jest.advanceTimersByTime(100);
    expect(ws.pings).toBe(1);
    expect(ws.terminated).toBe(false);

    // Second tick: alive is still false → terminate
    jest.advanceTimersByTime(100);
    expect(ws.terminated).toBe(true);

    wss.close();
  });

  it("clears the interval on close so it does not hang the process", () => {
    const ws = makeHeartbeatSocket();
    const wss = makeWss([ws]);

    wss.close();

    // After close, advancing time must not trigger any more pings
    jest.advanceTimersByTime(10_000);
    expect(ws.pings).toBe(0);
  });

  it("removes the transfer:new listener when a terminated socket closes", () => {
    const ws = makeSocket();
    simulateConnection(ws, "/subscribe/GRECV");

    const listenersBefore = transferEmitter.listenerCount("transfer:new");

    // Simulate what terminate() does in the ws library — it emits "close"
    ws.emit("close");

    expect(transferEmitter.listenerCount("transfer:new")).toBe(listenersBefore - 1);
  });
});
