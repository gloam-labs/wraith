import { usdPerCoin, __clearCoinPriceCache } from "../../linq/coinPrice";

/**
 * Pricing a coin in dollars, and refusing to when it cannot be done.
 *
 * This module exists because both naira screens priced XLM as though one XLM
 * were one dollar — ₦1,000 bought 0.6 XLM instead of 3.6, and ₦500 of airtime
 * was paid for with 6 cents. So the tests that matter most here are the ones
 * asserting it throws: a wrong price that looks plausible is the failure this
 * code is for, and a fallback value would reintroduce it.
 */
describe("usdPerCoin", () => {
  const realFetch = global.fetch;

  const book = (bid: string, ask: string) => ({
    ok: true,
    json: async () => ({ bids: [{ price: bid }], asks: [{ price: ask }] }),
  });

  beforeEach(() => {
    __clearCoinPriceCache();
    global.fetch = jest.fn();
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("prices USDC as a dollar without asking anyone", async () => {
    await expect(usdPerCoin("usdc")).resolves.toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("prices XLM at the mid of the book", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(book("0.1968071", "0.1970800"));
    await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.19694355, 8);
  });

  it("caches, so a burst of users is not a burst at Horizon", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(book("0.20", "0.21"));
    await usdPerCoin("xlm");
    await usdPerCoin("xlm");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty book", { bids: [], asks: [] }],
    ["one side missing", { bids: [{ price: "0.2" }], asks: [] }],
    ["a crossed book", { bids: [{ price: "0.3" }], asks: [{ price: "0.2" }] }],
    ["a non-numeric price", { bids: [{ price: "oops" }], asks: [{ price: "0.2" }] }],
    ["a zero price", { bids: [{ price: "0" }], asks: [{ price: "0" }] }],
    ["an absurd price", { bids: [{ price: "500" }], asks: [{ price: "501" }] }],
  ])("refuses rather than guessing on %s", async (_label, payload) => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => payload });
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("refuses when Horizon errors", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("refuses when Horizon is unreachable", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));
    await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
  });

  it("does not cache a failure", async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("blip"));
    await expect(usdPerCoin("xlm")).rejects.toThrow();
    (global.fetch as jest.Mock).mockResolvedValue(book("0.19", "0.20"));
    await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.195, 6);
  });

  describe("a refusal is not cached: the next call tries Horizon again", () => {
    // First call refuses, second call (a good book) succeeds, and fetch ran
    // twice — the failure left nothing behind for the next call to reuse.
    const expectRefusalThenRetry = async (firstResponse: unknown) => {
      const fetchMock = global.fetch as jest.Mock;
      fetchMock.mockResolvedValueOnce(firstResponse);
      await expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
      fetchMock.mockResolvedValue(book("0.19", "0.20"));
      await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.195, 6);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    };

    const badBook = (payload: unknown) => ({ ok: true, json: async () => payload });

    it("refuses an empty book and retries", async () => {
      await expectRefusalThenRetry(badBook({ bids: [], asks: [] }));
    });

    it("refuses a crossed book and retries", async () => {
      await expectRefusalThenRetry(
        badBook({ bids: [{ price: "0.30" }], asks: [{ price: "0.20" }] }),
      );
    });

    it("refuses a non-numeric price and retries", async () => {
      await expectRefusalThenRetry(
        badBook({ bids: [{ price: "oops" }], asks: [{ price: "0.20" }] }),
      );
    });

    it("refuses a mid below the minimum and retries", async () => {
      await expectRefusalThenRetry(
        badBook({ bids: [{ price: "0.0005" }], asks: [{ price: "0.0005" }] }),
      );
    });

    it("refuses a mid above the maximum and retries", async () => {
      await expectRefusalThenRetry(
        badBook({ bids: [{ price: "101" }], asks: [{ price: "102" }] }),
      );
    });

    it("refuses a non-JSON response and retries", async () => {
      await expectRefusalThenRetry({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token in JSON");
        },
      });
    });

    it("aborts the request after 8s and retries", async () => {
      jest.useFakeTimers();
      try {
        let signal: AbortSignal | undefined;
        (global.fetch as jest.Mock).mockImplementation(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              signal = init?.signal;
              signal?.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
              );
            }),
        );
        const refusal = expect(usdPerCoin("xlm")).rejects.toThrow(/price XLM/i);
        await jest.advanceTimersByTimeAsync(8_000);
        await refusal;
        expect(signal?.aborted).toBe(true);
      } finally {
        jest.useRealTimers();
      }

      // The timed-out failure is not cached either.
      (global.fetch as jest.Mock).mockResolvedValue(book("0.19", "0.20"));
      await expect(usdPerCoin("xlm")).resolves.toBeCloseTo(0.195, 6);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  it("fetches again once the 15s cache window has passed", async () => {
    const now = jest.spyOn(Date, "now");
    try {
      let t = 1_000_000;
      now.mockImplementation(() => t);
      (global.fetch as jest.Mock).mockResolvedValue(book("0.20", "0.21"));
      await usdPerCoin("xlm");
      await usdPerCoin("xlm");
      expect(global.fetch).toHaveBeenCalledTimes(1);
      t += 15_001;
      await usdPerCoin("xlm");
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  // The band edges in coinPrice.ts are MIN_XLM_USD = 0.001 and
  // MAX_XLM_USD = 100, and the guards reject only strictly outside them.
  it.each([
    ["the minimum", "0.001", "0.001", 0.001],
    ["the maximum", "100", "100", 100],
  ])("accepts a mid at exactly %s", async (_label, bid, ask, expected) => {
    (global.fetch as jest.Mock).mockResolvedValue(book(bid, ask));
    await expect(usdPerCoin("xlm")).resolves.toBe(expected);
  });
});
