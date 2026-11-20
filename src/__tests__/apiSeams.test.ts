import express from "express";
import request from "supertest";
import { createApp } from "../api";
import { assertPreBodyParserOrder, mountRawBodyRoutes } from "../api/routes";
import { setupBodyAndAppMiddleware } from "../api/middleware";
import { computeSignature } from "../linq/webhook";

jest.mock("../linq/offrampOrders", () => ({
  reconcileOfframpOrder: jest.fn().mockResolvedValue(true),
}));
jest.mock("../linq/ngnOrders", () => ({
  reconcileNgnOrder: jest.fn().mockResolvedValue(true),
}));
jest.mock("../linq/moneyFailures", () => ({
  recordMoneyFailure: jest.fn().mockResolvedValue(undefined),
}));

describe("API structure and load-bearing invariants (#313)", () => {
  it("initializes createApp with valid pre-body parser order", () => {
    expect(() => createApp()).not.toThrow();
  });

  it("assertPreBodyParserOrder throws if express.json() is mounted before /webhooks/linq", () => {
    const app = express();
    // Mount express.json() first (violating order)
    setupBodyAndAppMiddleware(app);
    const rawRouters = mountRawBodyRoutes(app);

    expect(() => assertPreBodyParserOrder(app, rawRouters)).toThrow(
      /Security invariant violated: \/webhooks\/linq .* must be mounted before express\.json\(\)/
    );
  });

  it("assertPreBodyParserOrder throws if express.json() is mounted before /discord/interactions", () => {
    const app = express();
    const linqRouter = express.Router();
    const discordRouter = express.Router();

    app.use("/webhooks/linq", linqRouter);
    app.use(express.json());
    app.use("/discord/interactions", discordRouter);

    expect(() =>
      assertPreBodyParserOrder(app, { linqRouter, discordRouter })
    ).toThrow(
      /Security invariant violated: \/discord\/interactions .* must be mounted before express\.json\(\)/
    );
  });

  it("preserves raw body for HMAC verification on /webhooks/linq through createApp", async () => {
    const secret = "test-linq-secret-key-123456";
    process.env.LINQ_WEBHOOK_SECRET = secret;

    try {
      const app = createApp();
      const payload = JSON.stringify({
        event: "order.completed",
        orderId: "order-123",
      });

      const signature = computeSignature(payload, secret);

      // Valid signature should pass verification (even if orderId is not found, status will not be 401)
      const res = await request(app)
        .post("/webhooks/linq")
        .set("Content-Type", "application/json")
        .set("x-linq-signature", signature)
        .send(payload);

      expect(res.status).not.toBe(401);

      // Invalid signature should return 401
      const badRes = await request(app)
        .post("/webhooks/linq")
        .set("Content-Type", "application/json")
        .set("x-linq-signature", "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb")
        .send(payload);

      expect(badRes.status).toBe(401);
      expect(badRes.body).toEqual({ error: "Invalid signature" });
    } finally {
      delete process.env.LINQ_WEBHOOK_SECRET;
    }
  });

  it("preserves /metrics exemption from stale-read middleware and rate limiter", async () => {
    const app = createApp();
    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["x-data-stale"]).toBeUndefined();
    expect(res.headers["content-type"]).toContain("text/plain");
  });
});
