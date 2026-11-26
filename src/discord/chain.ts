/**
 * What the chain says about a member's two addresses.
 *
 * Every function here answers one question and returns `null` when the
 * question could not be answered. `null` is never "no": the caller keeps a
 * role it cannot re-check rather than taking it away because an RPC node was
 * slow. Only a definite answer changes anything.
 *
 * Reads go straight to Soroban RPC and Horizon rather than to the indexer's
 * tables. Twenty tokens, a signer list and a counter are a handful of reads,
 * and they stay correct whether or not the indexer is watching the contract.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  Account,
  Address,
  Contract,
  Networks,
  rpc as RPC,
  scValToNative,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

import { getRpc } from "../rpc";
import {
  discordNetwork,
  discordRpcUrls,
  horizonUrl,
  namesContractId,
  veiliansContractId,
  walletWasmHashes,
} from "./config";

const SIMULATION_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const HORIZON_TIMEOUT_MS = 10_000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** Veil-ians is a fixed collection of twenty. */
const VEILIANS_COLLECTION_SIZE = 20;
/** `NameState::Active` in the registry contract. */
const NAME_STATE_ACTIVE = 0;

/** One slow endpoint must not use up the whole of a member's wait. */
const RPC_TIMEOUT_MS = 8_000;

const clients = new Map<string, RPC.Server>();

function clientFor(url: string): RPC.Server {
  let client = clients.get(url);
  if (!client) {
    client = new RPC.Server(url, { allowHttp: url.startsWith("http://"), timeout: RPC_TIMEOUT_MS });
    clients.set(url, client);
  }
  return client;
}

/**
 * The endpoints to try, in order. A member linking a wallet waits on these
 * reads, and a single endpoint having a bad moment used to be reported to them
 * as "the network could not be reached" (2026-11-18, a real member, first
 * day). So there is always more than one.
 */
function servers(): RPC.Server[] {
  const list = discordRpcUrls().map(clientFor);
  if (list.length > 0) return list;
  try {
    return [getRpc(discordNetwork())];
  } catch {
    return [];
  }
}

/** The endpoint the current read is using. Set per read by {@link attempt}. */
const activeServer = new AsyncLocalStorage<RPC.Server>();

function rpc(): RPC.Server {
  const server = activeServer.getStore();
  if (!server) throw new Error("no RPC endpoint for this read");
  return server;
}

/**
 * The chain answered, and the answer was a failure: the contract has no such
 * function, or is not there. Asking another endpoint would get the same
 * answer, so this is not retried.
 */
class ChainSaidNo extends Error {}

function passphrase(): string {
  return discordNetwork() === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/** Call a read-only contract function. Throws when the simulation fails. */
async function simulateRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: passphrase(),
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(0)
    .build();
  const response = await rpc().simulateTransaction(tx);
  if (RPC.Api.isSimulationSuccess(response) && response.result) {
    return scValToNative(response.result.retval);
  }
  if (RPC.Api.isSimulationError(response)) throw new ChainSaidNo(`simulation of ${method} failed`);
  throw new Error(`simulation of ${method} gave no result`);
}

/**
 * Run one read, trying each endpoint in turn until one answers. Null only
 * when every endpoint failed, or the chain itself said no.
 */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  for (const server of servers()) {
    try {
      return await activeServer.run(server, read);
    } catch (error) {
      if (error instanceof ChainSaidNo) return null;
      // A timeout or a refused connection. The next endpoint may be fine.
    }
  }
  return null;
}

/** Test-only: forget cached RPC clients. */
export function _resetChainClients(): void {
  clients.clear();
}

export function isContractAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidContract(value);
}

export function isAccountAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

/**
 * Whether this contract runs Veil's wallet code.
 *
 * Compared by code hash, which is exact: a contract that merely behaves like a
 * Veil wallet has a different hash.
 *
 * `"missing"` when the network returns no entry for the address at all. That
 * is not the same as "not a Veil wallet": it is also what a real wallet looks
 * like once it has gone unused long enough for the network to archive it, and
 * calling that wallet "not made by Veil" would be wrong.
 */
export async function isVeilWallet(wallet: string): Promise<boolean | "missing" | null> {
  return attempt<boolean | "missing">(async () => {
    const result = await rpc().getLedgerEntries(new Contract(wallet).getFootprint());
    const entry = result.entries[0];
    if (!entry) return "missing";
    const executable = entry.val.contractData().val().instance().executable();
    if (executable.switch().name !== "contractExecutableWasm") return false;
    return walletWasmHashes().includes(Buffer.from(executable.wasmHash()).toString("hex"));
  });
}

/** The wallet's passkey public keys, each 65 bytes, as lower-case hex. */
export async function walletSigners(wallet: string): Promise<string[] | null> {
  return attempt(async () => {
    const native = await simulateRead(wallet, "get_signers");
    const values = native instanceof Map ? [...native.values()] : Object.values(native as object);
    return values
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => Buffer.from(value).toString("hex"));
  });
}

/** The wallet's nonce: how many passkey-signed actions it has ever made. */
export async function walletNonce(wallet: string): Promise<number | null> {
  return attempt(async () => {
    const nonce = Number(await simulateRead(wallet, "get_nonce"));
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("unreadable nonce");
    return nonce;
  });
}

/** Whether any of these addresses holds a Veil-ian. */
export async function holdsVeilian(addresses: readonly string[]): Promise<boolean | null> {
  if (addresses.length === 0) return false;
  const mine = new Set(addresses);
  const contractId = veiliansContractId();
  return attempt(async () => {
    const sold = await simulateRead(contractId, "sold");
    if (!Array.isArray(sold)) throw new Error("unreadable sold list");
    const ids = sold
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= 1 && id <= VEILIANS_COLLECTION_SIZE);
    // All at once: twenty reads one after another is twenty round trips a
    // member waits through.
    const owners = await Promise.all(
      ids.map((id) => simulateRead(contractId, "owner_of", [nativeToScVal(id, { type: "u32" })])),
    );
    return owners.some((owner) => typeof owner === "string" && mine.has(owner));
  });
}

/**
 * Which of these candidate names are active and point at one of the member's
 * addresses. The registry cannot list a holder's names, so the app sends the
 * names it knows about and each one is put to the registry here.
 */
export async function activeNames(
  candidates: readonly string[],
  addresses: readonly string[],
): Promise<string[] | null> {
  const mine = new Set(addresses);
  const contractId = namesContractId();
  return attempt(async () => {
    const kept: string[] = [];
    for (const name of candidates) {
      const arg = nativeToScVal(name, { type: "string" });
      const [target, state] = await Promise.all([
        simulateRead(contractId, "resolve", [arg]),
        simulateRead(contractId, "state", [arg]),
      ]);
      if (typeof target === "string" && mine.has(target) && Number(state) === NAME_STATE_ACTIVE) {
        kept.push(name);
      }
    }
    return kept;
  });
}

/**
 * Whether any of these addresses owns a name token at all.
 *
 * The fallback when no candidate names are known. Coarser than
 * {@link activeNames}: a name that has run out still counts here until
 * somebody else registers it.
 */
export async function ownsAnyName(addresses: readonly string[]): Promise<boolean | null> {
  if (addresses.length === 0) return false;
  const contractId = namesContractId();
  return attempt(async () => {
    for (const address of addresses) {
      const balance = await simulateRead(contractId, "balance", [new Address(address).toScVal()]);
      if (Number(balance) > 0) return true;
    }
    return false;
  });
}

interface HorizonOperation {
  created_at?: string;
}

async function horizonOperations(account: string, order: "asc" | "desc", limit: number): Promise<HorizonOperation[] | "missing"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);
  try {
    const url = `${horizonUrl()}/accounts/${account}/operations?order=${order}&limit=${limit}`;
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) return "missing";
    if (!response.ok) throw new Error(`horizon ${response.status}`);
    const body = (await response.json()) as { _embedded?: { records?: unknown } };
    const records = body?._embedded?.records;
    return Array.isArray(records) ? (records as HorizonOperation[]) : [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How many operations the spending account made in the last thirty days,
 * counted up to 200. The spending account is the source of every transaction
 * a Veil wallet sends, so this is the wallet's activity too.
 */
export async function recentOperationCount(account: string, now = Date.now()): Promise<number | null> {
  return attempt(async () => {
    const records = await horizonOperations(account, "desc", 200);
    if (records === "missing") return 0;
    const since = now - THIRTY_DAYS_MS;
    return records.filter((record) => {
      const at = Date.parse(record.created_at ?? "");
      return Number.isFinite(at) && at >= since;
    }).length;
  });
}

/** When the spending account first did anything. Null when unknown or unused. */
export async function firstOperationAt(account: string): Promise<Date | null> {
  const records = await attempt(() => horizonOperations(account, "asc", 1));
  if (!records || records === "missing" || records.length === 0) return null;
  const at = Date.parse(records[0].created_at ?? "");
  return Number.isFinite(at) ? new Date(at) : null;
}
