import express from "express";
import request from "supertest";
import {
  validateSchema,
  validateResponseAgainstSpec,
  assertResponseMatchesSpec,
  installOpenApiValidator,
  uninstallOpenApiValidator,
} from "../openapi/responseValidator";

describe("OpenAPI Response Validator (Contract Testing)", () => {
  describe("validateSchema", () => {
    it("reports an extra field when the object has a property not in the schema", () => {
      const schema = {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      };

      const errors = validateSchema(schema, { id: "123", extraField: "oops" }, "");
      expect(errors).toContain("response has an extra field extraField");
    });

    it("reports a missing required field", () => {
      const schema = {
        type: "object",
        properties: {
          id: { type: "string" },
          amount: { type: "number" },
        },
        required: ["id", "amount"],
      };

      const errors = validateSchema(schema, { id: "123" }, "");
      expect(errors).toContain("response is missing required field amount");
    });

    it("reports a type mismatch naming the field, expected type, and actual type", () => {
      const schema = {
        type: "object",
        properties: {
          rate: { type: "number" },
        },
        required: ["rate"],
      };

      const errors = validateSchema(schema, { rate: "1655" }, "");
      expect(errors).toContain("response field rate expected number, got string");
    });

    it("reports an integer mismatch when a float is given", () => {
      const schema = {
        type: "object",
        properties: {
          count: { type: "integer" },
        },
      };

      const errors = validateSchema(schema, { count: 3.14 }, "");
      expect(errors).toContain("response field count expected integer, got floating-point number");
    });

    it("reports an enum mismatch naming the field, expected values, and actual value", () => {
      const schema = {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "completed"] },
        },
      };

      const errors = validateSchema(schema, { status: "unknown_status" }, "");
      expect(errors).toContain('response field status expected one of [pending, completed], got "unknown_status"');
    });

    it("reports nested object extra and missing fields with path", () => {
      const schema = {
        type: "object",
        properties: {
          order: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            required: ["id"],
          },
        },
      };

      const extraErrors = validateSchema(schema, { order: { id: "1", rogue: true } }, "");
      expect(extraErrors).toContain("response.order has an extra field rogue");

      const missingErrors = validateSchema(schema, { order: {} }, "");
      expect(missingErrors).toContain("response.order is missing required field id");
    });

    it("reports non-nullable null field", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", nullable: false },
        },
      };

      const errors = validateSchema(schema, { name: null }, "");
      expect(errors).toContain("response field name is null, but schema is not nullable");
    });

    it("allows null when nullable is true", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", nullable: true },
        },
      };

      const errors = validateSchema(schema, { name: null }, "");
      expect(errors).toHaveLength(0);
    });

    it("allows extra properties when additionalProperties is true", () => {
      const schema = {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        additionalProperties: true,
      };

      const errors = validateSchema(schema, { id: "1", extra: "allowed" }, "");
      expect(errors).toHaveLength(0);
    });
  });

  describe("validateResponseAgainstSpec against app spec", () => {
    it("validates valid response for GET /offramp/availability", () => {
      const result = validateResponseAgainstSpec("GET", "/offramp/availability", 200, {
        available: true,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.matchedPath).toBe("/offramp/availability");
    });

    it("fails when an undocumented extra field is present in GET /offramp/availability", () => {
      const result = validateResponseAgainstSpec("GET", "/offramp/availability", 200, {
        available: true,
        extraParam: "unexpected",
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("response has an extra field extraParam");
    });

    it("fails when required field is missing in GET /offramp/availability", () => {
      const result = validateResponseAgainstSpec("GET", "/offramp/availability", 200, {});

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("response is missing required field available");
    });

    it("fails when status code is not documented in spec", () => {
      const result = validateResponseAgainstSpec("GET", "/offramp/availability", 418, {
        teapot: true,
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Response status 418 is not documented/);
    });

    it("matches parameterized route /transfers/incoming/{address}", () => {
      const result = validateResponseAgainstSpec(
        "GET",
        "/transfers/incoming/GBUO4RL4RTGRFSUDUMRFMC75EWYCRTX5OE3PBIXJVDCZULOXQ2TKDR4Z",
        200,
        {
          transfers: [],
          hasMore: false,
          limit: 20,
          offset: 0,
        },
      );

      expect(result.valid).toBe(true);
      expect(result.matchedPath).toBe("/transfers/incoming/{address}");
    });

    it("prioritizes exact literal matches over parameterized routes (/webhooks/linq vs /webhooks/{id})", () => {
      const result = validateResponseAgainstSpec("POST", "/webhooks/linq", 200, {
        ok: true,
      });

      expect(result.valid).toBe(true);
      expect(result.matchedPath).toBe("/webhooks/linq");
    });
  });

  describe("supertest integration (auto-validation across tests without rewriting them)", () => {
    afterEach(() => {
      uninstallOpenApiValidator();
    });

    it("automatically fails supertest requests when handler response has an extra field", async () => {
      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.json({ available: true, driftField: "should_fail" });
      });

      installOpenApiValidator();

      await expect(request(app).get("/offramp/availability")).rejects.toThrow(
        /OpenAPI contract violation for GET \/offramp\/availability \(200\): response has an extra field driftField/,
      );
    });

    it("automatically fails supertest requests when handler response is missing a required field", async () => {
      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.json({});
      });

      installOpenApiValidator();

      await expect(request(app).get("/offramp/availability")).rejects.toThrow(
        /OpenAPI contract violation for GET \/offramp\/availability \(200\): response is missing required field available/,
      );
    });

    it("automatically fails supertest requests when handler response has a type divergence", async () => {
      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.json({ available: "yes" }); // string instead of boolean
      });

      installOpenApiValidator();

      await expect(request(app).get("/offramp/availability")).rejects.toThrow(
        /OpenAPI contract violation for GET \/offramp\/availability \(200\): response field available expected boolean, got string/,
      );
    });

    it("automatically fails supertest requests when handler sends an undocumented status code", async () => {
      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.status(418).json({ teapot: true });
      });

      installOpenApiValidator();

      await expect(request(app).get("/offramp/availability")).rejects.toThrow(
        /Response status 418 is not documented in OpenAPI spec for GET \/offramp\/availability/,
      );
    });

    it("assertResponseMatchesSpec throws an error naming the field on drift and passes when matching", () => {
      expect(() => {
        assertResponseMatchesSpec("GET", "/offramp/availability", 200, {
          available: true,
          unwanted: 123,
        });
      }).toThrow(/OpenAPI contract violation for GET \/offramp\/availability: response has an extra field unwanted/);

      expect(() => {
        assertResponseMatchesSpec("GET", "/offramp/availability", 200, {
          available: true,
        });
      }).not.toThrow();
    });

    it("automatically passes supertest requests when response matches spec", async () => {
      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.json({ available: true });
      });

      installOpenApiValidator();

      const res = await request(app).get("/offramp/availability");
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
    });

    it("uninstall restores original supertest behavior", async () => {
      installOpenApiValidator();
      uninstallOpenApiValidator();

      const app = express();
      app.get("/offramp/availability", (_req, res) => {
        res.json({ available: true, extraField: true });
      });

      // Does not throw because validator was uninstalled
      const res = await request(app).get("/offramp/availability");
      expect(res.status).toBe(200);
      expect(res.body.extraField).toBe(true);
    });
  });
});
