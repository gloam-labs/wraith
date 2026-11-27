/**
 * Tests for Stellar RPC `getEvents` contract-filter splitting and multi-request
 * merging in `fetchEvents` (#447).
 */
import { rpc as RPC, StrKey } from "@stellar/stellar-sdk";
import {
  _resetRpcClients,
  buildEventFilterBatches,
  fetchEvents,
  MAX_CONTRACT_IDS_PER_FILTER,
  MAX_CONTRACTS_PER_REQUEST,
  MAX_FILTERS_PER_REQUEST,
} from "../rpc";

function makeContractIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = StrKey.encodeContract(Buffer.alloc(32, i));
    if (!StrKey.isValidContract(id)) {
      throw new Error(`Invalid generated contract id at index ${i}`);
    }
    ids.push(id);
  }
  return ids;
}

function makeRpcEvent(id: string, ledger: number, contractId: string) {
  return {
    id,
    type: "contract",
    ledger,
    ledgerClosedAt: "2026-11-26T00:00:00Z",
    contractId: { contractId: () => contractId },
    txHash: `tx_${id}`,
    topic: [] as any[],
    value: {} as any,
  };
}

let getEventsSpy: jest.SpyInstance;

beforeEach(() => {
  _resetRpcClients();
  process.env.STELLAR_NETWORK = "testnet";
  getEventsSpy = jest.spyOn(RPC.Server.prototype, "getEvents");
});

afterEach(() => {
  jest.restoreAllMocks();
  _resetRpcClients();
});

describe("fetchEvents — Stellar RPC filter & batch limits (#447)", () => {
  it("exports the Stellar RPC getEvents limits as named constants", () => {
    expect(MAX_CONTRACT_IDS_PER_FILTER).toBe(5);
    expect(MAX_FILTERS_PER_REQUEST).toBe(5);
    expect(MAX_CONTRACTS_PER_REQUEST).toBe(25);
  });

  it("sends a single unfiltered contract request when contractIds is empty", async () => {
    getEventsSpy.mockResolvedValueOnce({
      events: [],
      latestLedger: 1_000,
    });

    const result = await fetchEvents(900, [], 10_000, "testnet");

    expect(result).toEqual({ events: [], latestLedger: 1_000 });
    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    const req = getEventsSpy.mock.calls[0][0];
    expect(req).toEqual({
      startLedger: 900,
      limit: 10_000,
      filters: [{ type: "contract" }],
    });
    expect("contractIds" in req.filters[0]).toBe(false);
  });

  it("sends 1 request with 1 filter for 1 contract id", async () => {
    const ids = makeContractIds(1);
    getEventsSpy.mockResolvedValueOnce({
      events: [makeRpcEvent("0000000100-0000000001", 100, ids[0])],
      latestLedger: 105,
    });

    const result = await fetchEvents(100, ids, 5_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    expect(getEventsSpy.mock.calls[0][0]).toEqual({
      startLedger: 100,
      limit: 5_000,
      filters: [{ type: "contract", contractIds: ids }],
    });
    expect(result.latestLedger).toBe(105);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].contractId).toBe(ids[0]);
  });

  it("sends 1 request with 1 filter of 5 ids for 5 contracts", async () => {
    const ids = makeContractIds(5);
    getEventsSpy.mockResolvedValueOnce({
      events: [makeRpcEvent("0000000100-0000000001", 100, ids[4])],
      latestLedger: 110,
    });

    const result = await fetchEvents(100, ids, 10_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    const req = getEventsSpy.mock.calls[0][0];
    expect(req.filters).toHaveLength(1);
    expect(req.filters[0].contractIds).toEqual(ids);
    expect(result.latestLedger).toBe(110);
    expect(result.events).toHaveLength(1);
  });

  // This test fails on main, which sent all 6 IDs in one filter and got rejected by Stellar RPC.
  it("splits 6 contract ids into 2 filters of 5 and 1 within a single request", async () => {
    const ids = makeContractIds(6);
    getEventsSpy.mockResolvedValueOnce({
      events: [
        makeRpcEvent("0000000100-0000000001", 100, ids[0]),
        makeRpcEvent("0000000101-0000000001", 101, ids[5]),
      ],
      latestLedger: 120,
    });

    const result = await fetchEvents(100, ids, 10_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    const req = getEventsSpy.mock.calls[0][0];
    expect(req.filters).toHaveLength(2);
    expect(req.filters[0]).toEqual({ type: "contract", contractIds: ids.slice(0, 5) });
    expect(req.filters[1]).toEqual({ type: "contract", contractIds: ids.slice(5, 6) });
    for (const f of req.filters) {
      expect(f.contractIds.length).toBeLessThanOrEqual(MAX_CONTRACT_IDS_PER_FILTER);
    }
    expect(result.latestLedger).toBe(120);
    expect(result.events.map((e) => e.id)).toEqual([
      "0000000100-0000000001",
      "0000000101-0000000001",
    ]);
  });

  it("fits 25 contract ids into 1 request with 5 filters of 5 ids each", async () => {
    const ids = makeContractIds(25);
    getEventsSpy.mockResolvedValueOnce({
      events: [makeRpcEvent("0000000200-0000000001", 200, ids[24])],
      latestLedger: 250,
    });

    const result = await fetchEvents(200, ids, 10_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(1);
    const req = getEventsSpy.mock.calls[0][0];
    expect(req.filters).toHaveLength(5);
    expect(req.filters.map((f: any) => f.contractIds.length)).toEqual([5, 5, 5, 5, 5]);
    expect(req.filters.flatMap((f: any) => f.contractIds)).toEqual(ids);
    expect(result.latestLedger).toBe(250);
    expect(result.events).toHaveLength(1);
  });

  it("splits 26 contract ids into 2 requests (25 + 1) and merges events in stable event-id order", async () => {
    const ids = makeContractIds(26);
    getEventsSpy
      .mockResolvedValueOnce({
        events: [
          makeRpcEvent("0000000302-0000000002", 302, ids[0]),
          makeRpcEvent("0000000305-0000000001", 305, ids[24]),
        ],
        latestLedger: 350,
      })
      .mockResolvedValueOnce({
        events: [
          makeRpcEvent("0000000301-0000000001", 301, ids[25]),
          makeRpcEvent("0000000302-0000000001", 302, ids[25]),
        ],
        latestLedger: 350,
      });

    const result = await fetchEvents(300, ids, 10_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(2);
    const req1 = getEventsSpy.mock.calls[0][0];
    const req2 = getEventsSpy.mock.calls[1][0];
    expect(req1.startLedger).toBe(300);
    expect(req2.startLedger).toBe(300);
    expect(req1.filters).toHaveLength(5);
    expect(req1.filters.map((f: any) => f.contractIds.length)).toEqual([5, 5, 5, 5, 5]);
    expect(req2.filters).toHaveLength(1);
    expect(req2.filters[0]).toEqual({ type: "contract", contractIds: ids.slice(25, 26) });

    expect(result.latestLedger).toBe(350);
    expect(result.events.map((e) => e.id)).toEqual([
      "0000000301-0000000001",
      "0000000302-0000000001",
      "0000000302-0000000002",
      "0000000305-0000000001",
    ]);
  });

  it("splits 60 contract ids into 3 requests (25 + 25 + 10), enforces all caps, and returns the lowest latestLedger", async () => {
    const ids = makeContractIds(60);
    // Request 2 stops earlier (412) than requests 1 (500) and 3 (505);
    // the merged latestLedger must be 412 so batch 2's tail is not skipped.
    getEventsSpy
      .mockResolvedValueOnce({
        events: [
          makeRpcEvent("0000000403-0000000001", 403, ids[3]),
          makeRpcEvent("0000000410-0000000002", 410, ids[20]),
        ],
        latestLedger: 500,
      })
      .mockResolvedValueOnce({
        events: [
          makeRpcEvent("0000000401-0000000001", 401, ids[30]),
          makeRpcEvent("0000000410-0000000001", 410, ids[49]),
        ],
        latestLedger: 412,
      })
      .mockResolvedValueOnce({
        events: [
          makeRpcEvent("0000000402-0000000001", 402, ids[55]),
        ],
        latestLedger: 505,
      });

    const result = await fetchEvents(400, ids, 10_000, "testnet");

    expect(getEventsSpy).toHaveBeenCalledTimes(3);
    const reqs = getEventsSpy.mock.calls.map((c) => c[0]);
    expect(reqs.map((r) => r.filters.length)).toEqual([5, 5, 2]);

    const seenIds: string[] = [];
    for (const req of reqs) {
      expect(req.startLedger).toBe(400);
      expect(req.limit).toBe(10_000);
      expect(req.filters.length).toBeLessThanOrEqual(MAX_FILTERS_PER_REQUEST);
      for (const filter of req.filters) {
        expect(filter.type).toBe("contract");
        expect(filter.contractIds.length).toBeLessThanOrEqual(MAX_CONTRACT_IDS_PER_FILTER);
        seenIds.push(...filter.contractIds);
      }
    }
    expect(seenIds).toEqual(ids);

    // Merged events are strictly ordered by event id across all 3 requests.
    expect(result.events.map((e) => e.id)).toEqual([
      "0000000401-0000000001",
      "0000000402-0000000001",
      "0000000403-0000000001",
      "0000000410-0000000001",
      "0000000410-0000000002",
    ]);
    // Lowest latestLedger wins so batch 2's ledgers 413..505 are re-queried next poll.
    expect(result.latestLedger).toBe(412);
  });

  it("buildEventFilterBatches preserves exact partition counts for boundary sizes", () => {
    for (const [count, expectedBatches] of [
      [0, [0]],
      [1, [1]],
      [5, [5]],
      [6, [5, 1]],
      [25, [5, 5, 5, 5, 5]],
    ] as const) {
      const batches = buildEventFilterBatches(makeContractIds(count));
      expect(batches).toHaveLength(1);
      if (count === 0) {
        expect(batches[0]).toEqual([{ type: "contract" }]);
      } else {
        expect(batches[0].map((f) => f.contractIds?.length)).toEqual(expectedBatches);
      }
    }
    expect(buildEventFilterBatches(makeContractIds(26)).map((b) => b.length)).toEqual([5, 1]);
    expect(buildEventFilterBatches(makeContractIds(60)).map((b) => b.length)).toEqual([5, 5, 2]);
  });
});
