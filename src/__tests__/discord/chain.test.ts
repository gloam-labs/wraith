/**
 * Reading the chain through more than one endpoint.
 *
 * On the bot's first day a real member was told "the network could not be
 * reached" because the single endpoint it used had a bad moment. These tests
 * pin that one failing endpoint is no longer the member's problem.
 */
import { Contract } from "@stellar/stellar-sdk";

const WALLET = "CA5TXFITGGMG6HG6FJIHWOTXSZ43EIR4F5UCTAAY5FJWB5FWBG5Z3WPN";
const VEIL_HASH = "b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5";

type Behaviour = "down" | "veil" | "other" | "missing";
const behaviour = new Map<string, Behaviour>();
const calls: string[] = [];

function instanceEntry(hashHex: string) {
  return {
    val: {
      contractData: () => ({
        val: () => ({
          instance: () => ({
            executable: () => ({
              switch: () => ({ name: "contractExecutableWasm" }),
              wasmHash: () => Buffer.from(hashHex, "hex"),
            }),
          }),
        }),
      }),
    },
  };
}

jest.mock("@stellar/stellar-sdk", () => {
  const actual = jest.requireActual("@stellar/stellar-sdk");
  class FakeServer {
    constructor(private readonly url: string) {}
    async getLedgerEntries() {
      calls.push(this.url);
      const mode = behaviour.get(this.url) ?? "down";
      if (mode === "down") throw new Error("timeout");
      if (mode === "missing") return { entries: [] };
      return { entries: [instanceEntry(mode === "veil" ? VEIL_HASH : "00".repeat(32))] };
    }
  }
  return { ...actual, rpc: { ...actual.rpc, Server: FakeServer } };
});

import { _resetChainClients, isVeilWallet } from "../../discord/chain";
import { discordRpcUrls } from "../../discord/config";

const FIRST = "https://first.example";
const PUBLIC = [
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://rpc.lightsail.network/",
  "https://mainnet.sorobanrpc.com",
];

beforeEach(() => {
  behaviour.clear();
  calls.length = 0;
  _resetChainClients();
  process.env.DISCORD_SOROBAN_RPC_URL = FIRST;
  delete process.env.DISCORD_NETWORK;
});

afterAll(() => {
  delete process.env.DISCORD_SOROBAN_RPC_URL;
});

describe("which endpoints are tried", () => {
  it("puts the configured ones first and always adds the public mainnet ones", () => {
    process.env.DISCORD_SOROBAN_RPC_URL = `${FIRST}, https://second.example`;
    expect(discordRpcUrls()).toEqual([FIRST, "https://second.example", ...PUBLIC]);
  });

  it("still has endpoints on mainnet with nothing configured", () => {
    delete process.env.DISCORD_SOROBAN_RPC_URL;
    expect(discordRpcUrls()).toEqual(PUBLIC);
  });

  it("adds no mainnet endpoint when the bot describes testnet", () => {
    process.env.DISCORD_NETWORK = "testnet";
    expect(discordRpcUrls()).toEqual([FIRST]);
  });
});

describe("checking a wallet's code", () => {
  // Sanity: the address used here is a valid contract address.
  it("uses a real contract address", () => {
    expect(() => new Contract(WALLET)).not.toThrow();
  });

  it("answers from the first endpoint when it works", async () => {
    behaviour.set(FIRST, "veil");
    expect(await isVeilWallet(WALLET)).toBe(true);
    expect(calls).toEqual([FIRST]);
  });

  it("moves on to the next endpoint when the first is down", async () => {
    behaviour.set(PUBLIC[0], "veil");
    expect(await isVeilWallet(WALLET)).toBe(true);
    expect(calls).toEqual([FIRST, PUBLIC[0]]);
  });

  it("says it could not check only when every endpoint is down", async () => {
    expect(await isVeilWallet(WALLET)).toBeNull();
    expect(calls).toEqual([FIRST, ...PUBLIC]);
  });

  it("says no for a contract running other code", async () => {
    behaviour.set(FIRST, "other");
    expect(await isVeilWallet(WALLET)).toBe(false);
  });

  it("says missing, not no, when the network has no entry for the address", async () => {
    behaviour.set(FIRST, "missing");
    expect(await isVeilWallet(WALLET)).toBe("missing");
  });
});
