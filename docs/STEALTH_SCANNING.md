# Stealth Payment Announcement Feed & Scanning Privacy

Wraith provides a privacy-preserving stealth payment announcement feed for the [Veil](https://github.com/Miracle656/veil) stealth payment protocol (`#1320`).

Scanning public blockchains for stealth payments is linear in the number of announcements on-chain. Requiring mobile or resource-constrained clients to fetch and parse every ledger block directly over public RPC nodes is neither scalable nor practical (public nodes enforce strict range and rate limits). Wraith indexes stealth announcements emitted by the `stealth-announcer` Soroban contract and serves them through a partitioned feed.

---

## 1. The Anonymity Set Per Query

A naive indexer endpoint that asks *"which announcements are mine?"* completely destroys recipient privacy by learning which payments belong to the user.

Wraith uses **view tags** as the privacy lever:
- A view tag is **1 byte** (8 bits), providing **256 possible buckets** ($0 \le \text{viewTag} \le 255$).
- Assuming uniform pseudo-random distribution across view tags, any single view tag matches approximately **1 in 256 announcements** ($P = \frac{1}{256} \approx 0.39\%$).
- When a client queries for its specific `viewTag`, Wraith returns that bucket of matching announcements alongside a substantial amount of chaff (unrelated payments sharing the same tag).
- **Anonymity ratio:** For every 1 announcement intended for the client, the client pulls approximately **256 candidate announcements** on average ($256:1$ anonymity set).
- **Observer visibility:** An indexer or observer only observes that a client queried for bucket $k \in [0, 255]$ over a ledger range $[\text{fromLedger}, \text{toLedger}]$. The server learns nothing about:
  1. The client's true recipient identity or stealth meta-address.
  2. Which specific announcement among the matching tag bucket belongs to the client.
  3. The one-time destination address where funds were sent.
- The client performs the cryptographic derivation (ECDH over `ephemeralPublicKey` using its local private viewing key) **entirely on device** to identify and claim the payment.

---

## 2. Strict Privacy Guard & Refusal Policy

Wraith enforces an intentional architectural boundary: **the server must not be capable of answering "is this mine" even if asked.**

To prevent accidental client leaks, misconfigurations, or malicious coercion:
- The `/stealth/announcements` endpoint **strictly refuses** any request carrying:
  - Viewing keys (`viewingKey`, `viewing_key`, `viewKey`, `view_key`)
  - Meta-addresses (`metaAddress`, `meta_address`, `stealthAddress`)
  - Spending keys (`spendingKey`, `spending_key`, `spendKey`)
  - Candidate one-time addresses or recipient identifiers (`address`, `recipient`, `receiver`, `candidateAddress`)
- Any request containing these parameters in the query string, headers, or body is rejected immediately with **HTTP 400 Bad Request**:
  ```json
  {
    "error": "Requests containing viewing keys, meta-addresses, candidate addresses, or recipient identifiers are refused to preserve receiver privacy (found query parameter \"viewingKey\").",
    "code": "privacy_violation"
  }
  ```

---

## 3. API Reference

### `GET /stealth/announcements` (alias: `GET /announcements`)

Retrieve stealth payment announcements by ledger range.

#### Query Parameters
| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `fromLedger` | integer | Yes | Start ledger sequence (inclusive), e.g. `1000`. Must be $\ge 0$. |
| `toLedger` | integer | No | End ledger sequence (inclusive). If supplied, must be $\ge \text{fromLedger}$. |
| `viewTag` | integer | No | 1-byte view tag filter ($0$ to $255$). Omit to fetch all announcements in range. |
| `limit` | integer | No | Maximum items to return ($1$ to $200$, default: $50$). |
| `cursor` | string | No | Opaque pagination cursor from a previous response. |
| `network` | string | No | Network selector (`testnet` or `mainnet`). |

#### Response (`200 OK`)
```json
{
  "announcements": [
    {
      "id": 1042,
      "contractId": "CA7BWBV2L67YVIZWJKLYT3RRCTFCZPN6L5SXYQ4YELWP56E34JFNOEP4",
      "ledger": 105230,
      "ledgerClosedAt": "2026-11-23T14:30:00.000Z",
      "txHash": "709c410adf10c63579f0df6eff0aa0d0b4fe542161b32c14bc7bba3c8fa4e18b",
      "eventId": "0000105230-00001",
      "version": 1,
      "viewTag": 42,
      "ephemeralPublicKey": "e7980246fbc5f32d50d1763ae3dd1426b5adb97fbb43bd47ae072161a3ff2c7f",
      "sealedNote": "01020304"
    }
  ],
  "fromLedger": 100000,
  "toLedger": 110000,
  "limit": 50,
  "nextCursor": "MTA0Mg==",
  "hasMore": false
}
```

---

## 4. Ingestion, Checkpoint & Backfill Idempotency

Announcements are ingested from Soroban `announce` contract events:
- **Topics:** `[Symbol("announce"), BytesN<1>(viewTag)]`
- **Data:** `(version: u32, ephemeralPublicKey: BytesN<32>, sealedNote: Bytes)`
- **Deduplication:** Announcements are persisted with `skipDuplicates: true` keyed on `(network, eventId)`.
- **Checkpoint Resilience:** Checkpoints advance atomically with ingested batches. If the indexer restarts mid-range or crashes during a ledger window:
  1. The indexer restarts from the last recorded checkpoint.
  2. Previously processed announcements within the replayed range are deduplicated cleanly without inserting duplicate rows.
  3. All newly indexed announcements are inserted, and the checkpoint advances to the highest processed ledger.
