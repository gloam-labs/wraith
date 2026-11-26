import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "http";
import { transferEmitter, TransferEvent } from "./events";
import { toDisplayAmount } from "./amount";
import { getCachedTokenDecimals } from "./tokenCache";
import { currentNetwork, enabledNetworks, isNetwork, NETWORKS, type Network } from "./network";
import { MAX_BUFFERED_BYTES } from "./graphql/subscriptions";
import { Counter } from "prom-client";
import { registry } from "./metrics";

/**
 * Count of plain-WS subscribers terminated because their send buffer exceeded
 * MAX_BUFFERED_BYTES.  No address label — subscriber addresses must not become
 * label values (unbounded cardinality).
 */
export const wsSlowSubscribersTotal = new Counter({
  name: "ws_slow_subscribers_total",
  help: "Plain-WS subscribers terminated for exceeding the send-buffer limit",
  registers: [registry],
});

/**
 * Default ping interval for the WebSocket heartbeat (30 seconds).
 * Override with WS_HEARTBEAT_INTERVAL_MS.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

function heartbeatIntervalMs(): number {
  const raw = process.env.WS_HEARTBEAT_INTERVAL_MS;
  if (!raw) return DEFAULT_HEARTBEAT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HEARTBEAT_INTERVAL_MS;
}

// Matches /subscribe/<Stellar address>, ignoring any query string (#163).
const SUBSCRIBE_RE = /^\/subscribe\/([A-Z0-9]+)(?:\?.*)?$/;

/**
 * Resolve `?network=` on the upgrade URL.
 *
 * Returns the selected network, or a rejection reason to close the socket
 * with. A subscriber cannot be told "your filter was invalid" after the fact —
 * they would just sit on a silent socket — so an unusable selector closes the
 * connection with a message instead of quietly defaulting.
 */
export function resolveSocketNetwork(url: string): { network: Network } | { error: string } {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const raw = new URLSearchParams(query).get("network");
  if (raw === null || raw.trim() === "") return { network: currentNetwork() };

  const normalised = raw.trim().toLowerCase();
  if (!isNetwork(normalised)) {
    return { error: `Invalid network: "${raw}". Valid values: ${NETWORKS.join(", ")}.` };
  }

  const enabled = enabledNetworks();
  if (!enabled.includes(normalised)) {
    return {
      error: `Network "${normalised}" is not enabled on this deployment. Enabled networks: ${enabled.join(", ")}.`,
    };
  }

  return { network: normalised };
}

type WsPayload = TransferEvent & { displayAmount: string };

function buildPayload(t: TransferEvent): WsPayload {
  return {
    ...t,
    displayAmount: toDisplayAmount(
      t.amount,
      getCachedTokenDecimals(t.contractId, t.network),
    ),
  };
}

/** Handle returned by {@link attachWebSocketServer} to allow graceful shutdown. */
export interface WebSocketServerHandle {
  /** Stop the heartbeat interval so tests and shutdown do not hang. */
  close(): void;
}

/**
 * Attach a WebSocket server to an existing HTTP server.
 *
 * Clients connect to:  ws://host/subscribe/:address
 *
 * The server pushes a JSON-serialised transfer payload whenever a new
 * transfer is indexed where `address` matches either sender or recipient.
 * Each handler is bound to the specific socket and removed on close/error
 * so there are no dangling listeners.
 *
 * Returns a {@link WebSocketServerHandle} whose `close()` stops the heartbeat
 * interval — call it on server shutdown to prevent the process from hanging.
 *
 * **Backpressure** (#407): before each send, `ws.bufferedAmount` is checked
 * against MAX_BUFFERED_BYTES.  A subscriber whose buffer is full is closed with
 * code 1008 and counted in `ws_slow_subscribers_total`.  Closing is the honest
 * choice for a payments feed: a client that silently misses a transfer is worse
 * off than one that reconnects and re-reads history over REST.
 *
 * **Heartbeat** (#408): every WS_HEARTBEAT_INTERVAL_MS (default 30 s) the
 * server pings every connected socket.  A socket that has not answered the
 * previous ping with a pong is terminated and its emitter listener is removed.
 * This catches half-open TCP connections (phone loses signal, laptop sleeps)
 * that never send a close frame.
 */
export function attachWebSocketServer(server: Server): WebSocketServerHandle {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = req.url ?? "";
    // GraphQL subscriptions own /graphql/* upgrades — leave those to
    // attachGraphQLSubscriptions() rather than 404'ing them here.
    if (url.startsWith("/graphql/")) return;
    if (!SUBSCRIBE_RE.test(url)) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket & { _alive?: boolean }, req: IncomingMessage) => {
    const match = (req.url ?? "").match(SUBSCRIBE_RE);
    // Guaranteed by the upgrade guard, but required to satisfy TS
    if (!match) {
      ws.close(1008, "Invalid path");
      return;
    }
    const address = match[1];

    const selection = resolveSocketNetwork(req.url ?? "");
    if ("error" in selection) {
      // 1008 = policy violation, the closest close code for a bad parameter.
      ws.close(1008, selection.error);
      return;
    }
    const network = selection.network;

    // Mark this socket as alive; the heartbeat clears it and waits for a pong.
    ws._alive = true;
    ws.on("pong", () => { ws._alive = true; });

    const handler = (transfer: TransferEvent) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // A process indexing both chains emits both onto the same emitter, so a
      // subscriber that asked for one must not be handed the other.
      if (transfer.network !== network) return;
      if (transfer.toAddress !== address && transfer.fromAddress !== address) return;

      // A subscriber that stops reading grows ws.bufferedAmount without bound.
      // Closing with 1008 is the honest choice for a payments feed: a client
      // that silently misses a transfer is worse off than one that reconnects
      // and re-reads history over REST.  The GraphQL subscription path uses a
      // drop-and-notice strategy because GraphQL has a richer wire protocol to
      // carry that notice; here the only channel is the transfer stream itself,
      // and inserting gap notices inline would corrupt any consumer that
      // expects only TransferEvent objects.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        wsSlowSubscribersTotal.inc();
        ws.close(1008, "Send buffer exceeded: client is not reading fast enough");
        return;
      }

      ws.send(JSON.stringify(buildPayload(transfer)));
    };

    transferEmitter.on("transfer:new", handler);

    const cleanup = () => transferEmitter.off("transfer:new", handler);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  // ── Heartbeat interval ────────────────────────────────────────────────────
  // Ping every connected socket.  Any socket that did not answer the previous
  // ping is terminated, which removes its emitter listener via the "close"
  // handler registered above.  This catches half-open TCP connections that
  // never send a close frame (phone drops signal, laptop sleeps).
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as WebSocket & { _alive?: boolean };
      if (socket._alive === false) {
        // No pong since the last ping — the connection is dead.
        socket.terminate();
        return;
      }
      socket._alive = false;
      socket.ping();
    });
  }, heartbeatIntervalMs());

  // `setInterval` holds a ref by default; `unref()` lets the Node process exit
  // even if the interval is still pending, which matters during tests.
  if (heartbeat.unref) heartbeat.unref();

  return {
    close() {
      clearInterval(heartbeat);
    },
  };
}
