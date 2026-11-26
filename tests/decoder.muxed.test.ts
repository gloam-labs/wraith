import { Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";

import { parseEvent, parseEvents } from "../src/decoder";
import { registry } from "../src/metrics";
import type { RawEvent } from "../src/rpc";

/**
 * CAP-84 muxed contracts (#351).
 *
 * From protocol 30 a SAC transfer may address a muxed contract: a contract id
 * plus a uint64 customer id. Before this, `Address.fromScVal` threw on the arm,
 * `parseEvents` counted the event as malformed, and a real on-chain payment
 * disappeared from the index — visible only to the person whose money it was.
 *
 * These tests build the ScVal from XDR rather than mocking `Address`, because
 * the failure being guarded against is precisely the decoder not understanding
 * a real encoded address.
 */

const TOKEN_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SENDER = Keypair.random().publicKey();

/** A CAP-84 muxed contract ScVal: contract id + customer id. */
function muxedContractScVal(contractId: string, id: bigint): xdr.ScVal {
  return xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeMuxedContract(
      new xdr.MuxedContract({
        id,
        contractId: new xdr.ContractId(StrKey.decodeContract(contractId)),
      }),
    ),
  );
}

function accountScVal(address: string): xdr.ScVal {
  return nativeToScVal(address, { type: "address" });
}

function transferEvent(to: xdr.ScVal, from: xdr.ScVal = accountScVal(SENDER)): RawEvent {
  return {
    id: "0000000000000123-00001",
    type: "contract",
    ledger: 123,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    contractId: TOKEN_CONTRACT,
    txHash: "muxed-transfer-tx",
    topic: [xdr.ScVal.scvSymbol("transfer"), from, to],
    value: nativeToScVal(10_000_000n, { type: "i128" }),
  };
}

/** The `malformed` sample of `events_skipped_total`, read from the registry. */
async function malformedSkips(): Promise<number> {
  const scrape = await registry.metrics();
  const line = /^events_skipped_total\{reason="malformed"\} (\d+)$/m.exec(scrape);
  return line ? Number(line[1]) : 0;
}

describe("decoder: CAP-84 muxed contract addresses", () => {
  it("indexes a transfer to a muxed contract, keeping the base address and the id", () => {
    // The id is deliberately past 2^53: a JS number would round it, and two
    // customers would become one.
    const id = 18_446_744_073_709_551_615n;
    const record = parseEvent(transferEvent(muxedContractScVal(TOKEN_CONTRACT, id)));

    expect(record).not.toBeNull();
    expect(record!.eventType).toBe("transfer");
    expect(record!.fromAddress).toBe(SENDER);
    expect(record!.fromMuxedId).toBeNull();
    expect(record!.toAddress).toBe(TOKEN_CONTRACT);
    expect(record!.toMuxedId).toBe("18446744073709551615");
    // A string, not a number: the exact id survives.
    expect(typeof record!.toMuxedId).toBe("string");
    expect(BigInt(record!.toMuxedId!)).toBe(id);
    expect(record!.amount).toBe("10000000");
  });

  it("keeps a muxed contract as the sender too", () => {
    const record = parseEvent(
      transferEvent(accountScVal(SENDER), muxedContractScVal(TOKEN_CONTRACT, 7n)),
    );

    expect(record).not.toBeNull();
    expect(record!.fromAddress).toBe(TOKEN_CONTRACT);
    expect(record!.fromMuxedId).toBe("7");
    expect(record!.toAddress).toBe(SENDER);
    expect(record!.toMuxedId).toBeNull();
  });

  it("does not count a muxed-contract transfer as skipped", async () => {
    const before = await malformedSkips();
    const records = parseEvents([transferEvent(muxedContractScVal(TOKEN_CONTRACT, 42n))]);

    expect(records).toHaveLength(1);
    expect(await malformedSkips()).toBe(before);
  });

  it("still skips a genuinely undecodable address", async () => {
    // topic[2] is an i32, not an address: no `Address.fromScVal` can rescue it.
    const before = await malformedSkips();
    const records = parseEvents([transferEvent(xdr.ScVal.scvI32(1))]);

    expect(records).toHaveLength(0);
    expect(await malformedSkips()).toBe(before + 1);
  });

  it("leaves a plain C-address transfer without a muxed id", () => {
    const record = parseEvent(transferEvent(accountScVal(SENDER)));

    expect(record).not.toBeNull();
    expect(record!.toAddress).toBe(SENDER);
    expect(record!.toMuxedId).toBeNull();
  });
});
