import http from "node:http";
import type { AddressInfo } from "node:net";
import { getRpc, resolveRpcTimeout, DEFAULT_RPC_TIMEOUT_MS, _resetRpcClients, withRetry } from "../rpc";
import { registry, _resetMetrics } from "../metrics";

describe("RPC timeout configuration (#370)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetRpcClients();
    _resetMetrics();
  });

  afterAll(() => {
    process.env = originalEnv;
    _resetRpcClients();
    _resetMetrics();
  });

  describe("resolveRpcTimeout", () => {
    it("returns default 15000ms when RPC_TIMEOUT_MS is unset", () => {
      delete process.env.RPC_TIMEOUT_MS;
      expect(resolveRpcTimeout()).toBe(15_000);
      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
    });

    it("returns default 15000ms when RPC_TIMEOUT_MS is empty string", () => {
      process.env.RPC_TIMEOUT_MS = "";
      expect(resolveRpcTimeout()).toBe(15_000);
    });

    it("parses valid positive integer timeout", () => {
      process.env.RPC_TIMEOUT_MS = "8000";
      expect(resolveRpcTimeout()).toBe(8000);

      process.env.RPC_TIMEOUT_MS = " 30000 ";
      expect(resolveRpcTimeout()).toBe(30_000);
    });

    it("falls back to default with a warning for zero", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      process.env.RPC_TIMEOUT_MS = "0";

      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Invalid RPC_TIMEOUT_MS="0": must be a positive whole number/)
      );
      warnSpy.mockRestore();
    });

    it("falls back to default with a warning for negative numbers", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      process.env.RPC_TIMEOUT_MS = "-5000";

      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Invalid RPC_TIMEOUT_MS="-5000": must be a positive whole number/)
      );
      warnSpy.mockRestore();
    });

    it("falls back to default with a warning for decimals", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      process.env.RPC_TIMEOUT_MS = "1500.5";

      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Invalid RPC_TIMEOUT_MS="1500.5": must be a positive whole number/)
      );
      warnSpy.mockRestore();
    });

    it("falls back to default with a warning for non-numeric values", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      process.env.RPC_TIMEOUT_MS = "fast";

      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Invalid RPC_TIMEOUT_MS="fast": must be a positive whole number/)
      );
      warnSpy.mockRestore();
    });

    it("emits only one warning across multiple invocations for invalid values", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();
      process.env.RPC_TIMEOUT_MS = "invalid";

      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(resolveRpcTimeout()).toBe(DEFAULT_RPC_TIMEOUT_MS);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe("getRpc client construction", () => {
    it("builds client with default timeout", () => {
      delete process.env.RPC_TIMEOUT_MS;
      const client = getRpc("testnet");
      expect((client as any).timeout).toBe(15_000);
      expect((client as any).httpClient?.defaults?.timeout).toBe(15_000);
    });

    it("builds client with configured RPC_TIMEOUT_MS", () => {
      process.env.RPC_TIMEOUT_MS = "5000";
      const client = getRpc("testnet");
      expect((client as any).timeout).toBe(5000);
      expect((client as any).httpClient?.defaults?.timeout).toBe(5000);
    });
  });

  describe("hanging RPC call timeout and withRetry behavior", () => {
    let server: http.Server;
    let serverUrl: string;

    beforeAll((done) => {
      // Create an HTTP server that accepts connections but never answers
      server = http.createServer((_req, _res) => {
        // Intentionally keep connection open without response
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as AddressInfo;
        serverUrl = `http://127.0.0.1:${addr.port}`;
        done();
      });
    });

    afterAll((done) => {
      server.close(done);
    });

    it("rejects an unresponsive RPC call after timeout and retries via withRetry", async () => {
      process.env.SOROBAN_RPC_URL_TESTNET = serverUrl;
      process.env.RPC_TIMEOUT_MS = "100"; // fast 100ms timeout for test

      const client = getRpc("testnet");
      const warnSpy = jest.spyOn(console, "warn").mockImplementation();

      const startTime = Date.now();
      await expect(
        withRetry(() => client.getLatestLedger(), 2, 20)
      ).rejects.toThrow(/timeout of 100ms exceeded|ECONNABORTED/i);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(180);

      const metricsText = await registry.metrics();
      expect(metricsText).toMatch(/rpc_errors_total\{outcome="retry"\}\s+1/);
      expect(metricsText).toMatch(/rpc_errors_total\{outcome="exhausted"\}\s+1/);

      warnSpy.mockRestore();
    });
  });
});
