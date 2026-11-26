/**
 * Prometheus metrics for the indexer and the API.
 *
 * Wraith runs as a persistent background service: when the indexer stalls or
 * RPC starts failing, nothing outside the logs says so. These metrics are the
 * machine-readable version of that signal — `GET /metrics` serves them in
 * Prometheus text format for scraping, dashboards, and alerting.
 *
 * Everything registers into a module-local {@link registry} rather than
 * prom-client's global default. A global register is process-wide state shared
 * with any dependency that also uses prom-client, and it cannot be cleared
 * between tests without clobbering theirs.
 *
 * Access to `GET /metrics` is restricted: see {@link metricsAccessGuard} below
 * and the README section on metrics access. Scrapers must present the bearer
 * token configured in METRICS_SCRAPE_TOKEN, and are exempt from rate limiting
 * on that basis. Anyone else receives 401/403.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Network } from "./network";

export const registry = new Registry();

// Standard process/Node metrics (process_cpu_seconds_total, heap sizes, event
// loop lag, …). Cheap, and they answer "is the process itself unhealthy?"
// before any of the counters below can.
collectDefaultMetrics({ register: registry });

/**
 * Scrape-access gate for `GET /metrics`.
 *
 * Decision: the metrics endpoint is operational telemetry (per-rail order
 * outcomes, provider latency, failure counts). It is not public. Only holders
 * of a shared scrape bearer token may read it. The token is read from
 * METRICS_SCRAPE_TOKEN; if that variable is unset the endpoint refuses every
 * request (fail closed) rather than falling back to open access.
 *
 * The same check decides rate-limit exemption: an authorised scraper bypasses
 * the limiter (a scrape endpoint that starts 429ing goes blind exactly when it
 * is needed), while unauthorised requests never reach the handler.
 */
export function metricsScrapeTokenFromEnv(): string | undefined {
  const token = process.env.METRICS_SCRAPE_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

function bearerTokenOf(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

/** True when the request carries the configured scrape bearer token. */
export function isAuthorisedScraper(req: Request, expected = metricsScrapeTokenFromEnv()): boolean {
  if (!expected) return false;
  const presented = bearerTokenOf(req);
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express middleware guarding `GET /metrics`.
 *
 * 503 when no scrape token is configured (the endpoint is disabled, not open);
 * 401 when no credentials are presented; 403 when the presented token is wrong.
 */
export function metricsAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const expected = metricsScrapeTokenFromEnv();
  if (!expected) {
    res.status(503).json({ error: "metrics endpoint is not configured" });
    return;
  }
  if (!bearerTokenOf(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
    res.status(401).json({ error: "authentication required" });
    return;
  }
  if (!isAuthorisedScraper(req, expected)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
}

/**
 * HTTP request count by method, route pattern, and status code.
 *
 * The route label uses the Express route pattern (e.g. /transfers/incoming/:address),
 * never the raw path — addresses and other dynamic values must not become label values.
 * /metrics is excluded from its own counters.
 */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests by method, route pattern, and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

/**
 * Histogram buckets for request and provider latency, in seconds.
 *
 * The naira rails budget 35 seconds for a whole provider operation
 * (`TOTAL_BUDGET_MS` in src/linq/http.ts), retries and waits included. Buckets
 * therefore run past that to 40s: a call that spends its entire budget must
 * land in a finite bucket, not only `+Inf`, or the slow tail — exactly the
 * requests this metric exists for — is invisible.
 *
 * Shared by {@link httpRequestDurationSeconds} and
 * {@link providerRequestDurationSeconds} so a dashboard can overlay them
 * directly: same unit, same boundaries.
 */
export const LATENCY_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 20, 25, 30, 35, 40,
];

/**
 * HTTP request latency by method and route pattern.
 *
 * The route label uses the Express route pattern, never the raw path.
 * /metrics is excluded from its own histogram.
 */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by method and route pattern",
  labelNames: ["method", "route"] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
});

/**
 * Total payment-provider calls by endpoint path and outcome.
 *
 * Every naira operation is an HTTP call to Linq through src/linq/http.ts.
 * This counter is incremented inside `linqCall` so no rail can forget to do it.
 *
 * Labels are bounded:
 *  - `endpoint`: the normalized endpoint path (e.g. "/b2b/offramp", "/b2b/status")
 *  - `outcome`: one of "success", "4xx", "5xx", "429", or "timeout"
 */
export const providerCallsTotal = new Counter({
  name: "provider_calls_total",
  help: "Total payment-provider calls by endpoint path and outcome",
  labelNames: ["endpoint", "outcome"] as const,
  registers: [registry],
});

/**
 * Time spent inside a payment-provider call, separately from the request.
 *
 * `http_request_duration_seconds` says a request took twelve seconds; this
 * says how many of them were Linq. Same unit and bucket boundaries, so a
 * dashboard can compare the two directly — and, per route, the difference is
 * the time wraith spent itself:
 *
 *   sum by (route) (rate(http_request_duration_seconds_sum[5m]))
 *     - sum by (operation) (rate(provider_request_duration_seconds_sum[5m]))
 *
 * Labels are a fixed vocabulary: `provider` is "linq", `operation` is a
 * `LinqOperation` constant from src/linq/http.ts ("offramp_order",
 * "bill_pay", …) and `outcome` is success/error/timeout. Never a path, an order id, a customer
 * reference or a provider message — an unbounded label makes /metrics grow
 * until it cannot be scraped, exactly when failures are piling up.
 */
export const providerRequestDurationSeconds = new Histogram({
  name: "provider_request_duration_seconds",
  help: "Time spent inside payment-provider calls, by provider, operation and outcome",
  labelNames: ["provider", "operation", "outcome"] as const,
  buckets: LATENCY_BUCKETS_SECONDS,
  registers: [registry],
});

/**
 * A provider 429, by operation and how far it got.
 *
 * All Veil users share one Linq key, and it is rate limited. The retry in
 * src/linq/http.ts has always recognised a 429 and waited, but a 429 left no
 * trace of its own: `provider_request_duration_seconds` folds it into the
 * generic `outcome="error"` pile, so "approaching the shared key's ceiling"
 * was indistinguishable from "the provider is flaky" — and nobody knew how
 * often it happened. The ceiling is the kind of thing that degrades slowly and
 * then fails everyone at once, so its 429s are counted here, separately from
 * every other failure.
 *
 * `disposition` is the difference between a warning and an incident:
 *
 *  - `absorbed` — our rate-limit retry waited and the call went on. Nobody
 *    heard about it; a rising rate is the early warning that the shared key is
 *    nearing its limit.
 *  - `surfaced` — no retry was taken (or none was left) and the 429 reached
 *    the caller. Every one of these is a person who was told the service is
 *    busy.
 *
 * Labels are bounded by construction: `provider` is "linq", `operation` is a
 * `LinqOperation` constant (the finite endpoint vocabulary), and `disposition`
 * is one of two words. Never an order id, a customer reference, an amount or
 * a URL — an unbounded label makes /metrics grow until it cannot be scraped.
 */
export const providerRateLimitTotal = new Counter({
  name: "provider_rate_limit_total",
  help: "Provider 429 responses, by provider, operation, and whether our retry absorbed them or the caller saw them",
  labelNames: ["provider", "operation", "disposition"] as const,
  registers: [registry],
});

/**
 * The wait a provider 429 asked us to take, in seconds.
 *
 * Recorded only when the provider sends `Retry-After` — a 429 without one is
 * not counted here. The value is what the provider asked for, not what we
 * slept: our own wait is capped (`MAX_RETRY_DELAY_MS` in src/linq/http.ts) but
 * the ask is not, and the gap between the two is how far over its own limit
 * the provider knows itself to be. A thirty-second ask is not a blip.
 *
 * Labelled by provider and operation only. The wait is the datum, and a
 * histogram keeps it out of the label set.
 */
export const providerRateLimitWaitSeconds = new Histogram({
  name: "provider_rate_limit_wait_seconds",
  help: "Waits providers asked for on a 429, in seconds, by provider and operation",
  labelNames: ["provider", "operation"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

/**
 * Ledgers the indexer has advanced through, per network.
 *
 * The rate of this is the alert that matters: a flat
 * `rate(ledgers_indexed_total[5m])` on a network whose loop is supposed to be
 * running means the indexer has stalled, whether or not the process is alive.
 */
export const ledgersIndexedTotal = new Counter({
  name: "ledgers_indexed_total",
  help: "Ledgers advanced through by the indexer, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Rows written by the indexer, split by record type.
 *
 * `type` separates fungible transfers, NFT transfers, liquidity-pool share
 * records, and host-function log rows.  Each comes off a distinct parse path
 * and one can break while the others keep working.  `host_fn` is the table
 * that grew to 1 776 MB and filled disk (#445); its write rate is what an
 * operator most needs to monitor.
 *
 * Argument for including `lp` and `host_fn` here rather than in a second
 * counter: the counter name "transfers" is admittedly a loose fit for log
 * rows, but adding a second counter for two values costs readers an extra
 * query just to get "total rows written".  A `type` label with four fixed
 * values is cheaper than a second metric, and the help text names all four.
 */
export const transfersStoredTotal = new Counter({
  name: "transfers_stored_total",
  help: "Rows persisted by the indexer, per network and record type (fungible, nft, lp, host_fn)",
  labelNames: ["network", "type"] as const,
  registers: [registry],
});

/**
 * Failed RPC attempts, counted per attempt rather than per call.
 *
 * `withRetry` hides transient failures from callers by design, so counting only
 * calls that exhausted their retries would report zero right up until the
 * moment the indexer falls over. Counting attempts surfaces a degrading
 * endpoint while it is still succeeding.
 */
export const rpcErrorsTotal = new Counter({
  name: "rpc_errors_total",
  help: "Failed RPC attempts (each retry counts separately)",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * Ledgers the indexer gave up on, per network.
 *
 * A skip is the one failure the indexer cannot recover from: the ledger's events
 * are never written and the cursor has already advanced past it, so the gap is
 * permanent. It only happens for a genuine XDR decode failure, which means any
 * non-zero value deserves a look, and a `rate()` over it says whether the gap is
 * still growing.
 *
 * Labelled by network only. The ledger number would be the interesting value and
 * is deliberately absent: one series per skipped ledger is unbounded cardinality,
 * and the counter answers the same question without it.
 */
export const ledgersSkippedTotal = new Counter({
  name: "ledgers_skipped_total",
  help: "Ledgers skipped by the indexer after an XDR decode failure, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Events dropped by the decoder, by network and reason.
 *
 * `reason` distinguishes the three drop sites:
 *  - `malformed`  — a fungible token event whose XDR decoded but produced an
 *    invalid structure (bad topic count, non-address topic, etc.)
 *  - `nft_parse`  — an NFT event that `parseNftTransferEvent` returned null for
 *  - `host_fn`    — a host-function log event that `parseHostFnEvent` threw on
 *
 * `unrecognised` events (non-token events filtered out by `parseEvents` before
 * any decode attempt) are still counted but carry no network label because they
 * are routine background noise, not errors.  Every other kind carries `network`
 * so a rising malformed count can be pinned to a chain in a mixed testnet +
 * mainnet process.
 */
export const eventsSkippedTotal = new Counter({
  name: "events_skipped_total",
  help: "Events dropped during ingest, by network and reason",
  labelNames: ["network", "reason"] as const,
  registers: [registry],
});

/**
 * The live-subscription channels, as a finite label set (#453).
 *
 * One per in-process emitter in src/events.ts: `transfer` for new transfers,
 * `hostfnlog` for new host-function logs. Nothing else may become a value of
 * the `channel` label.
 */
export const SUBSCRIPTION_CHANNELS = ["transfer", "hostfnlog"] as const;
export type SubscriptionChannel = (typeof SUBSCRIPTION_CHANNELS)[number];

/** True when `value` is one of {@link SUBSCRIPTION_CHANNELS}. */
export function isSubscriptionChannel(value: unknown): value is SubscriptionChannel {
  return typeof value === "string" && (SUBSCRIPTION_CHANNELS as readonly string[]).includes(value);
}

/**
 * Events a live GraphQL subscriber never received because it read too slowly.
 *
 * Each subscription holds at most `maxQueue` unread events (see
 * `eventsToAsyncIterator` in src/events.ts); past that the oldest is dropped,
 * so a stalled client cannot grow server memory. Dropping is deliberate, but it
 * used to be silent: the subscriber was not told and neither was the operator,
 * and a client that believed it had seen every transfer had not. Any increase
 * means some subscriber's stream has a gap.
 *
 * The queue sits before the subscription's own filter (network, contractId),
 * so a drop is counted per event the subscriber was sent, whether or not its
 * filter would have kept it.
 *
 * Labelled by `channel` only, from {@link SUBSCRIPTION_CHANNELS}. Never a
 * subscription id, a contract id, an address or a URL: one series per
 * subscriber is unbounded cardinality. Messages dropped on a saturated
 * WebSocket are a separate mechanism (#407) and are not counted here.
 */
export const subscriptionEventsDroppedTotal = new Counter({
  name: "subscription_events_dropped_total",
  help: "Events dropped from a live subscriber's queue because it read too slowly, by channel",
  labelNames: ["channel"] as const,
  registers: [registry],
});

/**
 * Record one event dropped from a subscriber's queue.
 *
 * Re-checks the channel at runtime so a cast or an untyped caller can never
 * add a third label value.
 */
export function recordSubscriptionEventDropped(channel: SubscriptionChannel): void {
  if (!isSubscriptionChannel(channel)) return;
  subscriptionEventsDroppedTotal.inc({ channel });
}

/** The money-moving rails, as a finite label set. */
export type OrderRail = "offramp" | "onramp" | "bills";

/** Terminal endings the provider uses, normalised to one word each. */
export type OrderTerminalStatus =
  | "completed"
  | "settled"
  | "disbursed"
  | "failed"
  | "expired"
  | "cancelled"
  | "refunded"
  | "reversed"
  | "timeout";

/**
 * Segments that mean the order is still moving, whatever ending-word appears
 * beside them. Checked before the endings below because those are substring
 * matches: "refund_pending" contains "refund".
 */
const STILL_MOVING_SEGMENTS = [
  "pending",
  "processing",
  "awaiting",
  "queued",
  "initiated",
  "progress",
  "not",
];

/**
 * Map any provider or webhook status to a bounded terminal status, or null.
 *
 * Statuses arrive from several places and are not one vocabulary: a webhook
 * says `order.completed`, a poll may say `settled`, and the provider can
 * expire, cancel, refund or reverse an order. The metric label must be drawn
 * from a finite set, so every spelling of an ending maps to one of the words
 * below. Anything still in flight, or an ending nobody has taught us yet,
 * returns null and is not counted as terminal.
 */
export function terminalStatusOf(status: string | null | undefined): OrderTerminalStatus | null {
  if (!status) return null;
  const s = status.toLowerCase();

  // Reading a pending status as an ending does more than inflate the counter:
  // the caller only records a transition when the previous status was not
  // terminal, so once "refund_pending" counts as refunded, the actual refund is
  // never counted at all.
  const segments = s.split(/[^a-z]+/).filter(Boolean);
  if (segments.some((segment) => STILL_MOVING_SEGMENTS.includes(segment))) return null;

  if (s.includes("completed")) return "completed";
  if (s.includes("settled")) return "settled";
  if (s.includes("disbursed")) return "disbursed";
  if (s.includes("failed")) return "failed";
  if (s.includes("expire")) return "expired";
  if (s.includes("cancel")) return "cancelled";
  if (s.includes("refund")) return "refunded";
  if (s.includes("revers")) return "reversed";
  if (s.includes("timeout")) return "timeout";
  return null;
}

/**
 * Orders created successfully, by rail.
 *
 * Counted only after the provider has returned an order (and, on the offramp,
 * after our row is written), so a retry that replays an existing order does
 * not inflate the number.
 */
export const ordersCreatedTotal = new Counter({
  name: "orders_created_total",
  help: "Orders created successfully, by rail",
  labelNames: ["rail"] as const,
  registers: [registry],
});

/**
 * Orders that reached a terminal state, by rail and terminal status.
 *
 * A transition counter, not a poll counter: callers record it only when an
 * order moves from a non-terminal status to a terminal one, so a wallet polling
 * a finished order and a redelivered webhook do not count it twice.
 */
export const ordersTerminalTotal = new Counter({
  name: "orders_terminal_total",
  help: "Orders that reached a terminal state, by rail and terminal status",
  labelNames: ["rail", "status"] as const,
  registers: [registry],
});

/** Record one successfully created order. */
export function recordOrderCreated(rail: OrderRail): void {
  ordersCreatedTotal.inc({ rail });
}

/** Record one non-terminal → terminal transition. */
export function recordOrderTerminal(rail: OrderRail, status: string): void {
  const terminal = terminalStatusOf(status);
  if (!terminal) return;
  ordersTerminalTotal.inc({ rail, status: terminal });
}

/**
 * Money-affecting failures: failed orders, rejected payouts, and webhook
 * events reconciliation gave up on.
 *
 * The machine-readable counterpart to the `MoneyFailure` table: the row
 * answers "what broke" to a human, this answers "is it still happening" to a
 * scrape. Labels are bounded by construction — `rail` from
 * MONEY_FAILURE_RAILS, `kind` from MONEY_FAILURE_KINDS, `network` from the
 * configured chains — and never an order id, a customer reference, an amount
 * or a provider message: an unbounded label makes /metrics grow until it
 * cannot be scraped, which is worst exactly when failures are piling up.
 */
export const moneyFailuresTotal = new Counter({
  name: "money_failures_total",
  help:
    "Money-affecting failures recorded (failed orders, rejected payouts, reconciliation give-ups)",
  labelNames: ["network", "rail", "kind"] as const,
  registers: [registry],
});

/**
 * The highest ledger the indexer has committed, per network.
 *
 * A gauge, not a counter: it is a position, and comparing it against the chain
 * tip is how lag is measured.
 */
export const lastIndexedLedger = new Gauge({
  name: "last_indexed_ledger",
  help: "Highest ledger sequence committed by the indexer, per network",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Wall-clock duration of instrumented database operations.
 *
 * Buckets run from 5ms to 10s: below 5ms nothing here is worth alerting on,
 * and past 10s the request has already failed for whatever is waiting on it.
 */
export const dbQueryDurationSeconds = new Histogram({
  name: "db_query_duration_seconds",
  help: "Duration of database operations, by operation name",
  labelNames: ["operation"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/**
 * Time `fn` into {@link dbQueryDurationSeconds} under `operation`.
 *
 * Failures are timed too — a query that takes eight seconds and then throws is
 * exactly the one worth seeing, and dropping it would make the histogram
 * describe only the healthy path.
 */
export async function observeDbQuery<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const end = dbQueryDurationSeconds.startTimer({ operation });
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * Total database read operations, labelled by target ("primary" or "replica").
 */
export const dbReadsTotal = new Counter({
  name: "db_reads_total",
  help: "Total database read operations by target",
  labelNames: ["target"] as const,
  registers: [registry],
});

/**
 * Total database read fallbacks from a replica to the primary following a connection error.
 */
export const dbReadFallbacksTotal = new Counter({
  name: "db_read_fallbacks_total",
  help: "Total database read fallbacks from replica to primary",
  registers: [registry],
});

// Pre-initialize label combinations so they appear in scrape output even before first read
dbReadsTotal.labels("primary").inc(0);
dbReadsTotal.labels("replica").inc(0);

/** Record a read query directed to primary or replica. */
export function recordDbRead(target: "primary" | "replica"): void {
  dbReadsTotal.inc({ target });
}

/** Record a read query fallback from replica to primary after connection failure. */
export function recordDbFallback(): void {
  dbReadFallbacksTotal.inc();
}

/** Record one failed RPC attempt. `outcome` distinguishes a retry from a give-up. */
export function recordRpcError(outcome: "retry" | "exhausted"): void {
  rpcErrorsTotal.inc({ outcome });
}

/**
 * Record one ledger abandoned after a genuine XDR decode failure.
 *
 * Called only where a ledger is actually given up on, never for the bisection
 * that looks for it — a bisection is a search, and counting it would inflate the
 * count by the depth of the search.
 */
export function recordSkippedLedger(network: Network): void {
  ledgersSkippedTotal.inc({ network });
}

/**
 * Fee quotes whose fee exceeded `VEIL_FEE_ALARM_PERCENT` of the amount priced.
 *
 * The fee is policy — percent, floor and cap — so a misconfiguration
 * overcharges every user at once, and until now the only way to notice was
 * reading the treasury's history on a block explorer. Alert on any increase.
 * Labelled by asset and network only: never an amount, never an address.
 */
export const feeQuoteAlarmsTotal = new Counter({
  name: "veil_fee_quote_alarms_total",
  help: "Fee quotes whose fee exceeded VEIL_FEE_ALARM_PERCENT of the amount priced",
  labelNames: ["network", "asset"] as const,
  registers: [registry],
});

/**
 * Fee quotes that could not be written to the ledger.
 *
 * The quote itself still succeeds — the user is mid-payment — so a failed
 * write is otherwise silent, and a ledger with gaps reports totals that are
 * quietly too low. Alert on any increase.
 */
export const feeQuoteRecordFailuresTotal = new Counter({
  name: "veil_fee_quote_record_failures_total",
  help: "Fee quotes that could not be written to the fee ledger",
  labelNames: ["network"] as const,
  registers: [registry],
});

/**
 * Discord role checks, by outcome.
 *
 * The bot re-checks every linked member so a role stops counting when the thing
 * behind it is gone. That work was previously visible only as two log lines, so
 * "the check is running" and "the check is drowning" looked the same.
 *
 * `outcome` is one of three words:
 *
 *  - `checked` — the member was checked and the result was applied.
 *  - `failed` — the check threw (Discord answered with an error, a role could
 *    not be removed, the chain timed out). The member's roles are left alone and
 *    their next check is pushed further out.
 *  - `skipped` — the member was due but the batch had no room for them. A
 *    sustained non-zero rate here is why "a day" takes longer than a day.
 *
 * Never a Discord user id: that would be one series per member.
 */
export const discordMemberChecksTotal = new Counter({
  name: "discord_member_checks_total",
  help: "Discord member role checks, by outcome",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/**
 * How long the oldest member has been waiting for a Discord role check.
 *
 * A gauge, not a counter: it is a backlog, and what matters is whether it keeps
 * growing past the recheck interval. Anything near `DISCORD_RECHECK_INTERVAL_MS`
 * means the bot is not keeping up with the members it has.
 */
export const discordOldestUncheckedAgeSeconds = new Gauge({
  name: "discord_oldest_unchecked_age_seconds",
  help: "Age in seconds of the oldest member due for a Discord role check",
  registers: [registry],
});

/** Record Discord role checks under a fixed outcome word. */
export function recordDiscordChecks(outcome: "checked" | "failed" | "skipped", count = 1): void {
  // Zero is recorded on purpose: prom-client only exports a labelled counter
  // once that label combination has been touched, and a dashboard needs the
  // series to exist at zero to show "no failures" rather than "no data".
  discordMemberChecksTotal.inc({ outcome }, count);
}

/** Set the age of the oldest member still waiting for a check. */
export function setDiscordOldestUncheckedAge(seconds: number): void {
  discordOldestUncheckedAgeSeconds.set(Math.max(0, seconds));
}

/** Serialize the registry in Prometheus text exposition format. */
export function renderMetrics(): Promise<string> {
  return registry.metrics();
}

/** The content type Prometheus expects on a scrape response. */
export const metricsContentType = registry.contentType;

/** Test-only: clears every recorded sample without unregistering the metrics. */
export function _resetMetrics(): void {
  registry.resetMetrics();
}
