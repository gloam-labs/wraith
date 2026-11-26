import request from "supertest";
import express, { Request, Response } from "express";
import { jsonApiMiddleware } from "../middleware/jsonapi";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(jsonApiMiddleware);
  return app;
}

const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const CONTRACT_A = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

describe("JSON:API middleware", () => {
  it("passes through for non-JSON:API Accept header", async () => {
    const app = makeApp();
    app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

    const res = await request(app).get("/test").set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("transforms transfer array responses to JSON:API format", async () => {
    const app = makeApp();
    app.get("/transfers/address/:address", (_req: Request, res: Response) => res.json({
      total: 2,
      transfers: [
        { eventId: "evt-1", contractId: CONTRACT_A, amount: "10000000000", ledger: 123 },
        { eventId: "evt-2", contractId: CONTRACT_A, amount: "20000000000", ledger: 124 },
      ],
    }));

    const res = await request(app).get(`/transfers/address/${ALICE}`).set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      id: "evt-1",
      type: "transfer",
      attributes: { contractId: CONTRACT_A, amount: "10000000000", ledger: 123 },
    });
    expect(res.body.meta.total).toBe(2);
  });

  it("transforms summary/token responses to JSON:API format", async () => {
    const app = makeApp();
    app.get("/summary/:address", (_req: Request, res: Response) => res.json({
      address: ALICE,
      window: { fromDate: null, toDate: null },
      tokens: [
        { contractId: CONTRACT_A, totalReceived: "500", totalSent: "100", txCount: 5 },
        { contractId: CONTRACT_A, totalReceived: "300", totalSent: "50", txCount: 3 },
      ],
    }));

    const res = await request(app).get(`/summary/${ALICE}`).set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({
      id: CONTRACT_A,
      type: "token-summary",
      attributes: { contractId: CONTRACT_A, totalReceived: "500", totalSent: "100", txCount: 5 },
    });
    expect(res.body.meta.address).toBe(ALICE);
  });

  it("transforms popular assets responses to JSON:API format", async () => {
    const app = makeApp();
    app.get("/assets/popular", (_req: Request, res: Response) => res.json({
      window: "24h",
      by: "volume",
      limit: 10,
      offset: 0,
      total: 1,
      assets: [
        { contractId: "C1", transferCount: 100n as unknown as number, volume: "50000000000" },
      ],
    }));

    const res = await request(app).get("/assets/popular").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: "C1",
      type: "popular-asset",
      attributes: { contractId: "C1", transferCount: "100", volume: "50000000000" },
    });
    expect(res.body.meta.total).toBe(1);
  });

  it("transforms NFT transfers to JSON:API format", async () => {
    const app = makeApp();
    app.get("/nfts/transfers", (_req: Request, res: Response) => res.json({
      transfers: [
        { eventId: "nft-1", contractId: "C1", tokenId: "1", ledger: 123 },
      ],
    }));

    const res = await request(app).get("/nfts/transfers").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: "nft-1",
      type: "nft-transfer",
    });
  });

  it("transforms NFT owner responses to JSON:API format", async () => {
    const app = makeApp();
    app.get("/nfts/owners/:contract/:token_id", (_req: Request, res: Response) => res.json({
      contract: CONTRACT_A,
      token_id: "1",
      owner: ALICE,
      metadata: null,
    }));

    const res = await request(app).get(`/nfts/owners/${CONTRACT_A}/1`).set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data).toMatchObject({
      id: `${CONTRACT_A}-1`,
      type: "nft-owner",
      attributes: { contract: CONTRACT_A, token_id: "1", owner: ALICE },
    });
    expect(res.body.meta.contract).toBe(CONTRACT_A);
  });

  it("returns null data for NFT owner when no owner exists", async () => {
    const app = makeApp();
    app.get("/nfts/owners/:contract/:token_id", (_req: Request, res: Response) => res.json({ contract: "C1", token_id: "999" }));

    const res = await request(app).get("/nfts/owners/C1/999").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it("transforms simple responses to JSON:API format", async () => {
    const app = makeApp();
    app.get("/status", (_req: Request, res: Response) => res.json({ ok: true, lastIndexedLedger: 12345, latestLedger: 12346 }));

    const res = await request(app).get("/status").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.data.type).toBe("status");
    expect(res.body.data.attributes).toMatchObject({ ok: true, lastIndexedLedger: 12345, latestLedger: 12346 });
  });

  it("converts errors to JSON:API error format", async () => {
    const app = makeApp();
    app.get("/error", (_req: Request, res: Response) => {
      res.status(404);
      res.json({ error: "Not found" });
    });

    const res = await request(app).get("/error").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/vnd.api+json");
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].title).toBe("Error");
    expect(res.body.errors[0].detail).toBe("Not found");
    expect(res.body.errors[0].status).toBe("404");
  });

  it("does not transform POST requests", async () => {
    const app = makeApp();
    app.post("/test", (_req: Request, res: Response) => res.json({ created: true }));

    const res = await request(app).post("/test").set("Accept", "application/vnd.api+json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: true });
  });
});