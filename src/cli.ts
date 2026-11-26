#!/usr/bin/env node
import "dotenv/config";
import { runBackfill } from "./ingest/backfill";
import { parseNetwork, type Network } from "./network";

export const USAGE = `Usage:
  ts-node src/cli.ts backfill --from <ledger> --to <ledger> [options]

Options:
  --from <num>            Start ledger (inclusive, required)
  --to <num>              End ledger (exclusive, required)
  --network <net>         Target network: testnet | mainnet (default: STELLAR_NETWORK)
  --contracts <id,id>     Comma-separated contract IDs override
  --chunk-size <num>      Ledgers per chunk (default: 64)
  --concurrency <num>     Parallel chunks (default: 4)
  --force                 Ignore existing cursor and restart

Environment:
  STELLAR_NETWORK              Default network: testnet | mainnet
  SOROBAN_RPC_URL_TESTNET      Testnet Soroban RPC endpoint
  SOROBAN_RPC_URL_MAINNET      Mainnet Soroban RPC endpoint
  SOROBAN_RPC_URL              Fallback RPC endpoint for STELLAR_NETWORK
  SAC_CONTRACT_IDS_TESTNET     Testnet watched SAC contract IDs
  SAC_CONTRACT_IDS_MAINNET     Mainnet watched SAC contract IDs
  SAC_CONTRACT_IDS             Shared watched SAC contract IDs
  NFT_CONTRACT_IDS_TESTNET     Testnet watched NFT contract IDs
  NFT_CONTRACT_IDS_MAINNET     Mainnet watched NFT contract IDs
  NFT_CONTRACT_IDS             Shared watched NFT contract IDs
  EVENTS_BATCH_SIZE            Max events per RPC call (default: 10000)
`;

export function parseArgs(argv: string[]): Record<string, string | number | boolean> {
  const args: Record<string, string | number | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val !== undefined && !val.startsWith("--")) {
        const num = Number(val);
        args[key] = Number.isFinite(num) ? num : val;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function resolveCliBackfillFlags(
  args: Record<string, string | number | boolean>,
): { network?: Network; contracts?: string[] } {
  let network: Network | undefined;
  if (args.network !== undefined) {
    const parsed = args.network === true ? null : parseNetwork(String(args.network));
    if (parsed === null) {
      const shown = args.network === true ? "(missing value)" : JSON.stringify(String(args.network));
      throw new Error(`--network must be "testnet" or "mainnet" (got ${shown}).`);
    }
    network = parsed;
  }

  let contracts: string[] | undefined;
  if (args.contracts !== undefined) {
    if (args.contracts === true) {
      throw new Error("--contracts requires a comma-separated list of contract IDs.");
    }
    contracts = String(args.contracts)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return { network, contracts };
}

async function cmdBackfill(
  fromLedger: number,
  toLedger: number,
  chunkSize: number | undefined,
  concurrency: number | undefined,
  force: boolean,
  network: Network | undefined,
  contracts: string[] | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (fromLedger >= toLedger) {
    console.error("ERROR: --from must be less than --to.\n");
    process.exit(1);
  }

  await runBackfill({
    fromLedger,
    toLedger,
    chunkSize,
    concurrency,
    signal,
    force,
    network,
    contracts,
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "backfill": {
      const stop = new AbortController();
      process.on("SIGINT", () => { console.log("\n[cli] SIGINT received — draining…"); stop.abort(); });
      process.on("SIGTERM", () => { console.log("\n[cli] SIGTERM received — draining…"); stop.abort(); });

      const args = parseArgs(rest);
      const fromLedger = args.from as number | undefined;
      const toLedger = args.to as number | undefined;

      if (fromLedger === undefined || toLedger === undefined) {
        console.error("ERROR: --from and --to are required.\n");
        console.error(USAGE);
        process.exit(1);
      }

      let network: Network | undefined;
      let contracts: string[] | undefined;
      try {
        ({ network, contracts } = resolveCliBackfillFlags(args));
      } catch (err) {
        console.error(`ERROR: ${(err as Error).message}\n`);
        console.error(USAGE);
        process.exit(1);
      }

      await cmdBackfill(
        fromLedger,
        toLedger,
        (args["chunk-size"] as number) || undefined,
        (args.concurrency as number) || undefined,
        args.force === true,
        network,
        contracts,
        stop.signal,
      );
      break;
    }
    default:
      console.error(`Unknown command: ${cmd ?? "(none)"}\n`);
      console.error(USAGE);
      process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cli] Fatal error:", message);
    process.exit(1);
  });
}
