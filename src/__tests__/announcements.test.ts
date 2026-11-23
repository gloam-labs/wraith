import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import express from "express";
import request from "supertest";
import {
  isAnnouncementEvent,
  parseAnnouncementEvent,
  parseAnnouncementEvents,
  upsertAnnouncements,
  queryAnnouncements,
  STEALTH_ANNOUNCEMENT_VERSION,
  type StealthAnnouncementRecord,
} from "../stealth/announcements";
import { createAnnouncementsRouter } from "../routes/announcements";
import { prisma } from "../db";
import { commitBatch, type BatchMetadata, type BatchPayload } from "../indexer/checkpoint";
import type { RawEvent } from "../rpc";

// ── Test fixtures ─────────────────────────────────────────────────────────────
const CONTRACT_ID = "CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4";
const TX_HASH = "709c410adf10c63579f0df6eff0aa0d0b4fe542161b32c14bc7bba3c8fa4e18b";
const EPHEMERAL_HEX = "e7980246fbc5f32d50d1763ae3dd1426b5adb97fbb43bd47ae072161a3ff2c7f";
const EPHEMERAL_BYTES = Buffer.from(EPHEMERAL_HEX, "hex");
const SEALED_NOTE_BYTES = Buffer.from([1, 2, 3, 4]);

function makeRawAnnouncementEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  const viewTagScVal = nativeToScVal(new Uint8Array([42]), { type: "bytes" });
  const valueScVal = nativeToScVal([
    STEALTH_ANNOUNCEMENT_VERSION,
    new Uint8Array(EPHEMERAL_BYTES),
    new Uint8Array(SEALED_NOTE_BYTES),
  ]);

  return {
    id: "0000000100-00001",
    type: "contract",
    ledger: 100,
    ledgerClosedAt: "2026-01-01T00:00:00.000Z",
    contractId: CONTRACT_ID,
    txHash: TX_HASH,
    topic: [
      nativeToScVal("announce", { type: "symbol" }),
      viewTagScVal,
    ],
    value: valueScVal,
    ...overrides,
  };
}

describe("Stealth Announcements (#1320)", () => {
  describe("Event Detection & Decoding", () => {
    it("recognises a valid announcement event", () => {
      const raw = makeRawAnnouncementEvent();
      expect(isAnnouncementEvent(raw)).toBe(true);

      const parsed = parseAnnouncementEvent(raw);
      expect(parsed).not.toBeNull();
      expect(parsed?.contractId).toBe(CONTRACT_ID);
      expect(parsed?.ledger).toBe(100);
      expect(parsed?.txHash).toBe(TX_HASH);
      expect(parsed?.eventId).toBe("0000000100-00001");
      expect(parsed?.version).toBe(1);
      expect(parsed?.viewTag).toBe(42);
      expect(parsed?.ephemeralPublicKey).toBe(EPHEMERAL_HEX);
      expect(parsed?.sealedNote).toBe("01020304");
    });

    it("returns null for non-announcement event topic symbol", () => {
      const raw = makeRawAnnouncementEvent({
        topic: [
          nativeToScVal("transfer", { type: "symbol" }),
          nativeToScVal(new Uint8Array([42]), { type: "bytes" }),
        ],
      });
      expect(isAnnouncementEvent(raw)).toBe(false);
      expect(parseAnnouncementEvent(raw)).toBeNull();
    });

    it("returns null if topics count is not exactly 2", () => {
      const raw = makeRawAnnouncementEvent({
        topic: [nativeToScVal("announce", { type: "symbol" })],
      });
      expect(isAnnouncementEvent(raw)).toBe(false);
      expect(parseAnnouncementEvent(raw)).toBeNull();
    });

    it("returns null for invalid viewTag out of 0..255 range", () => {
      const raw = makeRawAnnouncementEvent({
        topic: [
          nativeToScVal("announce", { type: "symbol" }),
          nativeToScVal(new Uint8Array([1, 2]), { type: "bytes" }), // 2 bytes instead of 1
        ],
      });
      expect(isAnnouncementEvent(raw)).toBe(false);
      expect(parseAnnouncementEvent(raw)).toBeNull();
    });

    it("returns null if ephemeral key is not 32 bytes", () => {
      const raw = makeRawAnnouncementEvent({
        value: nativeToScVal([
          STEALTH_ANNOUNCEMENT_VERSION,
          new Uint8Array([1, 2, 3]), // 3 bytes instead of 32
          new Uint8Array(SEALED_NOTE_BYTES),
        ]),
      });
      expect(parseAnnouncementEvent(raw)).toBeNull();
    });

    it("parses multiple events and skips non-announcements", () => {
      const e1 = makeRawAnnouncementEvent({ id: "e1" });
      const nonAnnounce = makeRawAnnouncementEvent({
        id: "e2",
        topic: [nativeToScVal("other", { type: "symbol" }), nativeToScVal(1, { type: "u32" })],
      });
      const e3 = makeRawAnnouncementEvent({
        id: "e3",
        topic: [
          nativeToScVal("announce", { type: "symbol" }),
          nativeToScVal(new Uint8Array([99]), { type: "bytes" }),
        ],
      });

      const parsed = parseAnnouncementEvents([e1, nonAnnounce, e3]);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].eventId).toBe("e1");
      expect(parsed[0].viewTag).toBe(42);
      expect(parsed[1].eventId).toBe("e3");
      expect(parsed[1].viewTag).toBe(99);
    });
  });

  describe("API Endpoint & Privacy Guard", () => {
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use("/stealth/announcements", createAnnouncementsRouter());
    });

    it("rejects requests containing viewingKey query parameter", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&viewingKey=some_secret_viewing_key");

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringMatching(/Requests containing viewing keys.*are refused/),
        code: "privacy_violation",
      });
    });

    it("rejects requests containing viewing_key query parameter", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&viewing_key=secret");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("privacy_violation");
    });

    it("rejects requests containing metaAddress or stealthAddress query parameter", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&metaAddress=st:some_meta_address");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("privacy_violation");
    });

    it("rejects requests containing spendingKey query parameter", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&spendingKey=secret");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("privacy_violation");
    });

    it("rejects requests containing candidate address or recipient identifier", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&address=GABC123");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("privacy_violation");
    });

    it("rejects requests containing privacy-violating headers", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100")
        .set("X-Viewing-Key", "secret-view-key");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("privacy_violation");
    });

    it("rejects requests with missing or negative fromLedger", async () => {
      const res1 = await request(app).get("/stealth/announcements");
      expect(res1.status).toBe(400);

      const res2 = await request(app).get("/stealth/announcements?fromLedger=-5");
      expect(res2.status).toBe(400);
    });

    it("rejects requests where toLedger < fromLedger", async () => {
      const res = await request(app)
        .get("/stealth/announcements?fromLedger=500&toLedger=400");
      expect(res.status).toBe(400);
    });

    it("rejects requests with invalid viewTag (< 0 or > 255)", async () => {
      const res1 = await request(app)
        .get("/stealth/announcements?fromLedger=100&viewTag=256");
      expect(res1.status).toBe(400);

      const res2 = await request(app)
        .get("/stealth/announcements?fromLedger=100&viewTag=-1");
      expect(res2.status).toBe(400);
    });

    it("serves announcements when parameters are valid and privacy safe", async () => {
      jest.spyOn(prisma.stealthAnnouncement, "findMany").mockResolvedValueOnce([
        {
          id: 1,
          network: "testnet",
          contractId: CONTRACT_ID,
          ledger: 105,
          ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
          txHash: TX_HASH,
          eventId: "0000000105-00001",
          version: 1,
          viewTag: 42,
          ephemeralPublicKey: EPHEMERAL_HEX,
          sealedNote: "01020304",
          createdAt: new Date(),
        },
      ]);

      const res = await request(app)
        .get("/stealth/announcements?fromLedger=100&toLedger=200&viewTag=42");

      expect(res.status).toBe(200);
      expect(res.body.announcements).toHaveLength(1);
      expect(res.body.fromLedger).toBe(100);
      expect(res.body.toLedger).toBe(200);
      expect(res.body.announcements[0].viewTag).toBe(42);
      expect(res.body.announcements[0].ephemeralPublicKey).toBe(EPHEMERAL_HEX);
    });
  });

  describe("Checkpoint & Backfill Idempotency on Restart", () => {
    it("deduplicates announcements and records checkpoint atomically", async () => {
      const mockCreateMany = jest.fn().mockResolvedValue({ count: 1 });
      const mockCheckpointUpsert = jest.fn().mockResolvedValue({});

      const txMock = {
        tokenTransfer: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
        nftTransfer: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
        hostFnLog: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
        stealthAnnouncement: { createMany: mockCreateMany },
        indexerCheckpoint: { upsert: mockCheckpointUpsert },
      };

      jest.spyOn(prisma, "$transaction").mockImplementationOnce(async (cb: any) => {
        return cb(txMock);
      });

      const announcement: StealthAnnouncementRecord = {
        contractId: CONTRACT_ID,
        ledger: 150,
        ledgerClosedAt: new Date(),
        txHash: TX_HASH,
        eventId: "evt-ann-1",
        version: 1,
        viewTag: 77,
        ephemeralPublicKey: EPHEMERAL_HEX,
        sealedNote: "deadbeef",
      };

      const meta: BatchMetadata = {
        batchId: "testnet:100-200",
        fromLedger: 100,
        toLedger: 200,
      };

      const payload: BatchPayload = {
        transfers: [],
        nftTransfers: [],
        hostFnLogs: [],
        announcements: [announcement],
      };

      const res = await commitBatch(meta, payload, "testnet");
      expect(res.announcements).toBe(1);
      expect(mockCreateMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ eventId: "evt-ann-1", viewTag: 77, network: "testnet" })],
        skipDuplicates: true,
      });
      expect(mockCheckpointUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { network_batchId: { network: "testnet", batchId: "testnet:100-200" } },
        }),
      );
    });
  });
});
