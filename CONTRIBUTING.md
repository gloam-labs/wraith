# Contributing to Wraith

Wraith is a Soroban incoming token transfer indexer and API for Stellar, with optional modules for GraphQL, NFTs, LP-share tracking, Discord role sync, and naira rails. Contributions are welcome — bug fixes, tests, decoder improvements, API endpoints, client SDK updates, and docs.

## Ways to contribute

- **Good first issues** — [`good first issue`](https://github.com/gloam-labs/wraith/labels/good%20first%20issue)
- **Bug reports** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Feature requests** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)

## Repository layout

```
wraith/
├── src/
│   ├── index.ts          # Service entry point (env validation, schema push, server + indexer startup)
│   ├── api.ts            # Express app, middleware order, and core REST endpoints
│   ├── api/              # Feature routers (accounts, candles, fees, ngn, offramp, ops, webhooks)
│   ├── routes/           # Modular read, export, and search routes
│   ├── indexer.ts        # Per-network polling loop and startup planner
│   ├── indexer/          # Event batching, parallel sharding, host-fn logs, LP shares, tombstones, sources
│   ├── decoder.ts        # SEP-41 / CAP-67 XDR event decoding
│   ├── rpc.ts            # Soroban RPC client and bisection fallback
│   ├── db.ts             # Prisma client and query helpers
│   ├── openapi/          # Zod schemas and OpenAPI generator (`build.ts`)
│   ├── graphql/          # Apollo GraphQL server and subscriptions
│   ├── discord/          # Optional Discord roles bot
│   ├── linq/             # Naira rails provider client
│   ├── middleware/       # CORS, JSON:API content negotiation, network selector, OPA
│   ├── utils/            # Shared helpers (env parsing, errors, body-error redaction)
│   └── __tests__/        # Jest unit and route test suites
├── tests/                # Property/fuzz tests plus `integration/` (Vitest) and `chaos/`
├── prisma/
│   └── schema.prisma     # Database schema (`wraith` Postgres schema)
├── clients/
│   ├── go/               # Go SDK (`wraith-go`)
│   ├── python/           # Python SDK (`wraith-py`)
│   └── react-query/      # React Query SDK (`@wraith/react-query`)
├── openapi.json          # Generated OpenAPI 3.0 spec (mirrored to `docs/openapi.json`)
├── .env.example          # Complete environment contract
└── docker-compose.yml    # Local Postgres, optional Redis (`cache` profile), and wraith service
```

## Development setup

### Prerequisites

- **Node.js 20+**
- **Docker** (for local PostgreSQL via `docker-compose.yml`)

### Clone, configure, and run

```bash
git clone https://github.com/gloam-labs/wraith.git
cd wraith
npm ci
npx prisma generate
cp .env.example .env
docker compose up -d db
npm run db:push
npm run dev
```

The API listens on `http://localhost:3000` (controlled by `PORT`).

Optional: seed deterministic local data before starting or querying:

```bash
npm run db:seed
```

### Key environment variables

`.env.example` documents every runtime variable and comes pre-configured for local testnet development:

- `DATABASE_URL` / `DIRECT_DATABASE_URL` — PostgreSQL connection strings (both required at startup; pre-filled for the `db` service in `docker-compose.yml`).
- `STELLAR_NETWORK` — `testnet` or `mainnet` (defaults to `testnet`).
- `SOROBAN_RPC_URL_TESTNET` / `SOROBAN_RPC_URL_MAINNET` — per-network Soroban RPC endpoints (testnet defaults to `https://soroban-testnet.stellar.org`; mainnet has no free public endpoint). Legacy `SOROBAN_RPC_URL` / `STELLAR_RPC_URL` are also accepted for single-network deployments.
- `NETWORKS` — optional comma-separated networks to run in one process (e.g. `testnet,mainnet`).
- `START_LEDGER` — optional ledger to start indexing from (leave blank to resume from database state or start near the tip).

See [README.md](README.md#environment-variables) and [.env.example](.env.example) for the full list.

## Rules

- **Do not weaken tests.** This backend carries live money. If a test fails, either the code is wrong or the test describes old behaviour — explain which in your PR.
- **Body parsing and middleware order.** Signature-verified webhook routes (`/webhooks/linq` and `/discord/interactions`) read the raw request body and must stay mounted **before** `express.json()` in `src/api.ts`.
- **Keep generated OpenAPI files in sync.** Three generated files come from one source (`src/openapi/`): `openapi.json`, `docs/openapi.json`, and `clients/react-query/src/schema.d.ts`. CI compares them byte for byte. Any new or changed route must be added to the spec and all three files regenerated.
- **Personal data.** A NIN (Nigerian national ID number) is never stored, never logged, never placed in a test fixture, and never used in an example. The same applies to phone numbers, meter numbers, and bank details — always use values that are plainly fake. Never log a raw database error, connection string, or RPC URL (some RPC URLs contain API keys in the path).
- **Money rules.** Never use floating point for amounts. Match provider statuses exactly, never by substring (for example, `refund_pending` contains `refund`). Keep `GET /ngn/onramp/rate` open because installed mobile apps call it; only order creation is gated.
- **Addresses and IDs.** Never shorten or invent a Stellar `G…` address, `C…` contract ID, or hash in code, tests, or docs. Copy full real values or validate with `StrKey.isValidContract` / `StrKey.isValidEd25519PublicKey`.
- **Environment variables and Docker Compose.** Every key in `.env.example` must also be declared in `docker-compose.yml` (enforced by `src/__tests__/dockerCompose.test.ts` and `src/__tests__/envValidation.test.ts`).
- **Additive database schema changes.** The service runs `prisma db push` on startup. Any change to `prisma/schema.prisma` must be additive (new tables or nullable/defaulted columns — never drop, rename, or narrow columns in place).
- **Never stop the whole service for an optional dependency.** Startup may only fail for the database (`src/validateEnv.ts`). A missing network RPC, Redis, the Discord bot, or the naira provider degrades only that feature.

## Testing

The repository has more than a hundred Jest suites under `src/__tests__/` and `tests/`, plus Docker-backed integration tests under `tests/integration/`:

```bash
# Unit and route suites (runs jest --runInBand with coverage thresholds)
npm test

# Equivalent explicit command
npx jest --runInBand
```

Integration tests run against `docker-compose.test.yml` using Vitest:

```bash
docker compose -f docker-compose.test.yml up -d --build
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

### Client SDK tests

Each client in `clients/` has its own toolchain and CI check:

- **Go (`clients/go`)**:
  ```bash
  cd clients/go
  gofmt -l .
  go vet ./...
  go test ./...
  ```
- **Python (`clients/python`)**:
  ```bash
  cd clients/python
  pip install -e ".[dev]"
  pytest
  ```
- **React Query (`clients/react-query`)**:
  ```bash
  cd clients/react-query
  npm install
  npm run generate   # when openapi.json changed
  npm run typecheck
  npm test           # vitest run
  npm run build
  ```

## Commit conventions

- Use conventional prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- Keep PRs focused and link the related issue (for example, `Closes #123`).

## Before opening a PR

Run these checks from the repository root:

```bash
npx prisma generate
npm run typecheck
npx tsc --noEmit
npm run build
npx jest --runInBand
```

If you added or changed any API route or schema, also regenerate the OpenAPI spec and React Query client types, then verify the client workspace:

```bash
npm run docs:openapi
cd clients/react-query
npm install
npm run generate
npm run typecheck
npm test
npm run build
```

## Questions

Open an [issue](https://github.com/gloam-labs/wraith/issues) on `gloam-labs/wraith`.
