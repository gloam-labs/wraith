/**
 * GraphQL subscription tests — issue #99
 *
 * Spins up a real HTTP + WS server in-process (no Docker) and exercises:
 *  1. contract and network isolation between subscribers
 *  2. unsubscribe, dropped-connection cleanup, and reconnect lifecycle
 *  3. transferAdded and hostFnLogAdded delivery, including network identity
 *  4. slow consumer doesn't crash the server (bounded queue)
 */
import http from "http";
import { WebSocket } from "ws";
import { attachGraphQLSubscriptions, SUBSCRIPTIONS_PATH } from "../subscriptions";
import { emitTransfer, emitHostFnLog, transferEmitter } from "../../events";
import type { TransferEvent, HostFnLogEvent } from "../../events";

jest.mock("../../db", () => ({
  queryAllTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
  queryByTxHash: jest.fn().mockResolvedValue([]),
  querySummary: jest.fn().mockResolvedValue([]),
  queryTransfers: jest.fn().mockResolvedValue({ total: 0, transfers: [], nextCursor: null }),
}));

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
    ...overrides,
  } as TransferEvent;
}

function makeHostFnLog(overrides: Partial<HostFnLogEvent> = {}): HostFnLogEvent {
  return {
    contractId: "CTOKEN",
    functionName: "swap",
    args: ["a", "b"],
    result: { ok: true },
    gasUsed: null,
    ledger: 100,
    ledgerClosedAt: new Date("2025-01-01T00:00:00Z"),
    txHash: "txhash",
    eventId: "hfl-1",
    network: "testnet",
    ...overrides,
  };
}

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer();
  attachGraphQLSubscriptions(server);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `ws://localhost:${port}${SUBSCRIPTIONS_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

// Tracked so afterAll can force-close any socket a failed assertion left
// open — otherwise http.Server#close() hangs waiting for it and blows the
// hook timeout instead of reporting the real test failure.
const openSockets: WebSocket[] = [];

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function subscribeOp(
  ws: WebSocket,
  id: string,
  query: string,
  variables?: Record<string, unknown>
): void {
  ws.send(JSON.stringify({ id, type: "subscribe", payload: { query, variables } }));
}

function collectNext(ws: WebSocket, id: string, n: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const results: Record<string, unknown>[] = [];
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.id !== id) return;
      if (msg.type === "next") {
        results.push(msg.payload.data);
        if (results.length >= n) {
          ws.off("message", handler);
          resolve(results);
        }
      } else if (msg.type === "error") {
        ws.off("message", handler);
        reject(new Error(JSON.stringify(msg.payload)));
      }
    };
    ws.on("message", handler);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for subscription state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function closeSocket(ws: WebSocket, terminate = false): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();

  return new Promise((resolve) => {
    ws.once("close", () => resolve());
    if (terminate) ws.terminate();
    else ws.close();
  });
}

function collectTransferEvents(ws: WebSocket, id: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.id === id && message.type === "next") {
      events.push(message.payload.data.transferAdded);
    }
  });
  return events;
}

describe("GraphQL subscriptions /graphql/subscriptions", () => {
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  const originalNetworks = process.env.NETWORKS;
  const originalStellarNetwork = process.env.STELLAR_NETWORK;

  beforeAll(async () => {
    process.env.NETWORKS = "testnet,mainnet";
    process.env.STELLAR_NETWORK = "testnet";
    const srv = await startServer();
    serverUrl = srv.url;
    closeServer = srv.close;
  });

  afterAll(async () => {
    for (const ws of openSockets.splice(0)) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    await closeServer();
    if (originalNetworks === undefined) delete process.env.NETWORKS;
    else process.env.NETWORKS = originalNetworks;
    if (originalStellarNetwork === undefined) delete process.env.STELLAR_NETWORK;
    else process.env.STELLAR_NETWORK = originalStellarNetwork;
  });

  it("rejects upgrade on an unknown /graphql sub-path with 404", async () => {
    const other = serverUrl.replace(SUBSCRIPTIONS_PATH, "/graphql/nope");
    await expect(connect(other)).rejects.toThrow();
  });

  it("closes a connection that selects an invalid network", async () => {
    const ws = new WebSocket(`${serverUrl}?network=solana`);
    openSockets.push(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: 'Invalid network: "solana". Valid values: testnet, mainnet.',
    });
  });

  it("returns protocol errors for malformed and invalid operations", async () => {
    const ws = await connect(serverUrl);

    let pending = nextMessage(ws);
    ws.send("{");
    await expect(pending).resolves.toMatchObject({
      type: "error",
      payload: [{ message: "Invalid JSON" }],
    });

    pending = nextMessage(ws);
    subscribeOp(ws, "syntax", "subscription {");
    await expect(pending).resolves.toMatchObject({
      id: "syntax",
      type: "error",
    });

    pending = nextMessage(ws);
    subscribeOp(ws, "validation", "subscription { missingField }");
    await expect(pending).resolves.toMatchObject({
      id: "validation",
      type: "error",
      payload: [expect.objectContaining({ message: expect.stringContaining("missingField") })],
    });

    pending = nextMessage(ws);
    subscribeOp(ws, "not-subscription", "query { health { ok } }");
    await expect(pending).resolves.toMatchObject({
      id: "not-subscription",
      type: "error",
    });

    await closeSocket(ws);
  });

  it("isolates subscribers by contract and network", async () => {
    const initialListeners = transferEmitter.listenerCount("transfer:new");
    const testnetSocket = await connect(serverUrl);
    const mainnetSocket = await connect(serverUrl);
    const testnetEvents = collectTransferEvents(testnetSocket, "isolation-testnet");
    const mainnetEvents = collectTransferEvents(mainnetSocket, "isolation-mainnet");

    subscribeOp(
      testnetSocket,
      "isolation-testnet",
      `subscription {
        transferAdded(contractId: "CTESTNET", network: TESTNET) {
          contractId
          eventId
          network
        }
      }`
    );
    subscribeOp(
      mainnetSocket,
      "isolation-mainnet",
      `subscription {
        transferAdded(contractId: "CMAINNET", network: MAINNET) {
          contractId
          eventId
          network
        }
      }`
    );
    await waitFor(
      () => transferEmitter.listenerCount("transfer:new") === initialListeners + 2
    );

    emitTransfer(makeTransfer({ contractId: "CTESTNET", eventId: "wrong-network" }), "mainnet");
    emitTransfer(makeTransfer({ contractId: "CMAINNET", eventId: "wrong-contract" }), "testnet");
    emitTransfer(makeTransfer({ contractId: "COTHER", eventId: "unrelated" }), "testnet");
    emitTransfer(makeTransfer({ contractId: "CTESTNET", eventId: "testnet-match" }), "testnet");
    emitTransfer(makeTransfer({ contractId: "CMAINNET", eventId: "mainnet-match" }), "mainnet");

    await waitFor(() => testnetEvents.length === 1 && mainnetEvents.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(testnetEvents).toEqual([
      { contractId: "CTESTNET", eventId: "testnet-match", network: "TESTNET" },
    ]);
    expect(mainnetEvents).toEqual([
      { contractId: "CMAINNET", eventId: "mainnet-match", network: "MAINNET" },
    ]);

    await Promise.all([closeSocket(testnetSocket), closeSocket(mainnetSocket)]);
    await waitFor(() => transferEmitter.listenerCount("transfer:new") === initialListeners);
  });

  it("includes the defaulted network on delivered transfers", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(
      ws,
      "1",
      "subscription { transferAdded { contractId eventId displayAmount network } }"
    );

    // Give the server a tick to register the subscription's async iterator
    // before emitting, mirroring the existing WS subscription test.
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "1", 1);
    emitTransfer(makeTransfer({ eventId: "ev-a" }), "testnet");

    const [msg] = await pending;
    const transfer = msg.transferAdded as Record<string, unknown>;
    expect(transfer.eventId).toBe("ev-a");
    expect(transfer.displayAmount).toBe("1.0000000");
    expect(transfer.network).toBe("TESTNET");

    await closeSocket(ws);
  });

  it("filters transferAdded by contractId", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(
      ws,
      "2",
      "subscription($contractId: String) { transferAdded(contractId: $contractId) { contractId eventId } }",
      { contractId: "CWANTED" }
    );
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "2", 1);

    emitTransfer(makeTransfer({ contractId: "COTHER", eventId: "ev-skip" }), "testnet");
    emitTransfer(makeTransfer({ contractId: "CWANTED", eventId: "ev-match" }), "testnet");

    const [msg] = await pending;
    expect((msg.transferAdded as Record<string, unknown>).eventId).toBe("ev-match");

    await closeSocket(ws);
  });

  it("streams hostFnLogAdded events", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(
      ws,
      "3",
      "subscription { hostFnLogAdded { contractId functionName eventId network } }"
    );
    await new Promise((r) => setTimeout(r, 20));

    const pending = collectNext(ws, "3", 1);
    emitHostFnLog(makeHostFnLog({ eventId: "hfl-a" }), "testnet");

    const [msg] = await pending;
    expect((msg.hostFnLogAdded as Record<string, unknown>).eventId).toBe("hfl-a");
    expect((msg.hostFnLogAdded as Record<string, unknown>).functionName).toBe("swap");
    expect((msg.hostFnLogAdded as Record<string, unknown>).network).toBe("TESTNET");

    await closeSocket(ws);
  });

  it("stops delivering after the client sends complete", async () => {
    const initialListeners = transferEmitter.listenerCount("transfer:new");
    const ws = await connect(serverUrl);
    subscribeOp(ws, "4", "subscription { transferAdded { eventId } }");
    await waitFor(
      () => transferEmitter.listenerCount("transfer:new") === initialListeners + 1
    );

    let received = 0;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === "4" && msg.type === "next") received++;
    });

    ws.send(JSON.stringify({ id: "4", type: "complete" }));
    await waitFor(() => transferEmitter.listenerCount("transfer:new") === initialListeners);

    emitTransfer(makeTransfer({ eventId: "ev-after-complete" }), "testnet");
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toBe(0);
    await closeSocket(ws);
  });

  it("cleans up a dropped connection and does not double-deliver after reconnect", async () => {
    const initialListeners = transferEmitter.listenerCount("transfer:new");
    const droppedSocket = await connect(serverUrl);
    subscribeOp(droppedSocket, "reconnect", "subscription { transferAdded { eventId } }");
    await waitFor(
      () => transferEmitter.listenerCount("transfer:new") === initialListeners + 1
    );

    await closeSocket(droppedSocket, true);
    await waitFor(() => transferEmitter.listenerCount("transfer:new") === initialListeners);

    const reconnectedSocket = await connect(serverUrl);
    const received = collectTransferEvents(reconnectedSocket, "reconnect");
    subscribeOp(reconnectedSocket, "reconnect", "subscription { transferAdded { eventId } }");
    await waitFor(
      () => transferEmitter.listenerCount("transfer:new") === initialListeners + 1
    );

    emitTransfer(makeTransfer({ eventId: "ev-after-reconnect" }), "testnet");
    await waitFor(() => received.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([{ eventId: "ev-after-reconnect" }]);

    await closeSocket(reconnectedSocket);
    await waitFor(() => transferEmitter.listenerCount("transfer:new") === initialListeners);
  });

  it("backpressure — buffers many rapid transfers without crashing the server", async () => {
    const ws = await connect(serverUrl);
    subscribeOp(ws, "5", "subscription { transferAdded { eventId } }");
    await new Promise((r) => setTimeout(r, 20));

    const COUNT = 50;
    const pending = collectNext(ws, "5", COUNT);

    for (let i = 0; i < COUNT; i++) {
      emitTransfer(makeTransfer({ eventId: `bp-${i}` }), "testnet");
    }

    const msgs = await pending;
    expect(msgs).toHaveLength(COUNT);

    await closeSocket(ws);
  });
});
