# Changelog

All notable changes to Wraith are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- CI pipeline (`.github/workflows/ci.yml`) running Prisma generate, typecheck, and build on every PR
- Contributor documentation, issue templates, PR template
- This changelog
- `x-request-id` — every response now carries one, and every log line written while handling that request carries the same id. A caller's own id is honoured if it is printable ASCII of 128 characters or fewer; anything else is replaced with a fresh one. `X-Request-Id` is in the CORS `Access-Control-Expose-Headers` list on the surfaces that send CORS headers, and the `correlationId` a 500 returns is the request's id rather than a second, unrelated one.
- `docs/client-coverage.md` — one table of every route group the API serves against the three clients, with each gap marked **open** (and the issue that closes it) or **deliberate** (and why). Each client's README carries the same table narrowed to itself, so nobody finds out after installing that the client they picked cannot reach the rails.
- `CORS_ALLOWED_ORIGINS` — the comma-separated list of browser origins allowed to call the surfaces that are not public. A new client is an environment change, not a change to the source.
- Discord roles bot: `discord_member_checks_total{outcome}` (checked, failed, skipped) and the `discord_oldest_unchecked_age_seconds` gauge, so "the recheck is running" and "the recheck is drowning" stop looking the same.
- Discord roles bot: `DISCORD_RECHECK_TICK_MS`, `DISCORD_ABSENT_CHECKS_BEFORE_BACKOFF`, `DISCORD_ABSENT_RECHECK_INTERVAL_MS` and `DISCORD_MAX_FAILURE_BACKOFF_MS`.

### Changed
- **Provider order statuses are read by whole word, and a still-moving word always wins** (#418). `isFailureStatus`, `statusForClients`/`billStatusForClients` and `terminalStatusOf` now share one classifier (`src/linq/providerStatus.ts`). A `refund_pending`, `refund_processing`, `cancel_requested`, `reversal_pending` or `awaiting_refund` order no longer writes a `MoneyFailure` row or reaches wallet apps as finished; it is sent exactly as the provider wrote it. A status no rule knows is passed through unchanged and counted nowhere. Every real ending returns exactly what it did before, pinned by a table test.
- **`GET /accounts/{address}/summary` says what it answers, and the spec describes it.** Two changes a client can see:
  - `displayNet` is now a plain signed decimal (`"-0.0000500"`). It used to be `"-0.0000500 (negative)"` — a number with a word glued onto the end, which every client had to strip before formatting and which no other display field in the API does.
  - `fromDate` and `toDate` are refused with `400`. They were accepted and ignored: the route reads a materialised rollup of one all-time row per asset, so there was no window to filter and a caller who asked for a month was given everything. `GET /summary/{address}` is the route that takes a window, and it is unchanged.
  - The OpenAPI document for this path described `/summary/{address}`'s response (`window`, `tokens`) — fields this route never sends. It now describes the body actually returned (`address`, `assets[]`), the route's unreachable second registration is gone, and `openapi.json`, `docs/openapi.json` and `clients/react-query/src/schema.d.ts` are regenerated from it.
- **Discord's 429 is treated as an answer, not a failure.** Every Discord REST call now waits what the rate limit asked for (capped at 5 seconds) and retries twice, inside the call's existing 10-second budget; a wait above the cap fails immediately instead of blocking. A repeatable call — reading a member, adding or removing a role, listing roles, replacing the command set, editing a reply — is also retried once after a 5xx or a network error; creating a role is not, because a retry of a half-applied create would leave two roles with one name. `ensureRoles` shares one in-flight lookup, so two members syncing at once cannot create the same role twice. `discord_rate_limited_total{kind=…}` counts the 429s.
- **The Discord role recheck now runs from the data, not from process uptime.** It fires once at start and then on a short tick, and picks members whose own last attempt is older than `DISCORD_RECHECK_INTERVAL_MS`. A deploy a day can no longer mean the check never runs, and a restart no longer postpones everybody by a day.
  - A member whose check throws is recorded and moved to the back of the queue, with the wait doubling per consecutive failure up to `DISCORD_MAX_FAILURE_BACKOFF_MS`. Previously a failing member kept the old `checkedAt` and was picked first every day; two hundred such members starved everybody else.
  - A member who has left the server is checked weekly after `DISCORD_ABSENT_CHECKS_BEFORE_BACKOFF` consecutive misses. Their row is kept: they may come back.
  - A failed check still changes no roles; `decideRoles` and `planChanges` are untouched.
  - **Schema (additive).** `DiscordMember` gains `lastAttemptAt` (nullable), `failedAttempts` and `absentChecks` (`INT NOT NULL DEFAULT 0`), plus an index on `lastAttemptAt`. Nothing is dropped, renamed or narrowed, so the start-up `db push` applies it and the service still starts on an older database.
- **CORS is decided per surface instead of one global `Access-Control-Allow-Origin: *`.** The public read API, GraphQL, the fee quote and the offramp quotes stay open to every origin; the offramp orders, the naira rails, webhook subscription management, `/metrics` and any write nobody has classified yet are restricted to `CORS_ALLOWED_ORIGINS`. A request from any other origin is refused with `403` and the code `origin_not_allowed`, before the route runs.
  - **Breaking for browser clients.** A deployment with no `CORS_ALLOWED_ORIGINS` set lets no browser origin call those surfaces; add your web wallet's origin to it. Requests with no `Origin` header are unaffected, so the mobile app, server-to-server callers and `curl` keep working as they did.
  - `POST /webhooks/linq` is the payout provider's callback: it gets no CORS headers, and it is never refused by the origin policy, so a payment rail cannot stop working because the list changed.

## [1.1.0] — PR #6

### Added
- Combined transfers endpoint: `GET /transfers/address/:address?direction=incoming|outgoing|both`
- `displayAmount` (human-readable) in transfer responses
- `fromDate` / `toDate` query filters
- `eventType` query filter
- `GET /summary/:address` aggregated transfer summary

## [1.0.0] — Initial release

### Added
- Express REST API with `/transfers/incoming/:address` and `/transfers/outgoing/:address`
- Soroban event indexer using `fetchEventsSafe` with bisection to handle Protocol 22 XDR decode errors
- SEP-41 / CAP-67 token transfer decoding
- Prisma schema for events and transfers
- Dockerfile + docker-compose
- Deployed on Render at https://wraith-0jo1.onrender.com

[Unreleased]: https://github.com/Miracle656/wraith/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Miracle656/wraith/releases/tag/v1.1.0
[1.0.0]: https://github.com/Miracle656/wraith/releases/tag/v1.0.0