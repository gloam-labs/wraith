import type { Network } from "../network";

export interface TransferRecord {
  contractId: string;
  eventType: string; // "transfer" | "mint" | "burn" | "clawback"
  fromAddress: string | null;
  toAddress: string | null;
  amount: string; // i128 as decimal string
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventId: string;
  isSac?: boolean; // true when the contract is a Stellar Asset Contract (#136)
}

export type ListPage<T> = {
  rows: T[];
  nextCursor: string | null;
  /** True when the n+1 fetch found a row past this page. */
  hasMore: boolean;
};

export const TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "eventType",
  "fromAddress",
  "toAddress",
  "amount",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "isSac",
  "createdAt",
  "displayAmount",
  "direction",
];

export const NFT_TRANSFER_SELECTABLE_FIELDS = [
  "id",
  "contractId",
  "tokenId",
  "fromAddress",
  "toAddress",
  "ledger",
  "ledgerClosedAt",
  "txHash",
  "eventId",
  "createdAt",
];

export const ACCOUNT_SUMMARY_SELECTABLE_FIELDS = [
  "id",
  "address",
  "contractId",
  "totalSent",
  "totalReceived",
  "net",
  "txCount",
  "lastActivityAt",
  "updatedAt",
  "displayTotalSent",
  "displayTotalReceived",
  "displayNet",
];

export const TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  eventType: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  amount: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

export const NFT_TRANSFER_FIELD_TYPES = {
  id: { type: "number" as const },
  contractId: { type: "string" as const },
  tokenId: { type: "string" as const },
  fromAddress: { type: "string" as const },
  toAddress: { type: "string" as const },
  ledger: { type: "number" as const },
  ledgerClosedAt: { type: "date" as const },
  txHash: { type: "string" as const },
  eventId: { type: "string" as const },
  createdAt: { type: "date" as const },
};

export const ACCOUNT_SUMMARY_FIELD_TYPES = {
  id: { type: "number" as const },
  address: { type: "string" as const },
  contractId: { type: "string" as const },
  totalSent: { type: "string" as const },
  totalReceived: { type: "string" as const },
  net: { type: "string" as const },
  txCount: { type: "number" as const },
  lastActivityAt: { type: "date" as const },
  updatedAt: { type: "date" as const },
};

export type BalanceRow = {
  contractId: string;
  balance: string;
};

export interface BackfillCursorState {
  startLedger: number;
  endLedger: number;
  nextLedger: number;
}

export type TransferQueryParams = {
  network?: Network;
  tokenDecimals?: (contractId: string, network: Network) => number | undefined;
  address: string;
  direction: "incoming" | "outgoing";
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export type SummaryQueryParams = {
  network?: Network;
  address: string;
  contractId?: string;
  fromDate?: Date;
  toDate?: Date;
};

export type SummaryRow = {
  contractId: string;
  totalReceived: string; // NUMERIC cast to TEXT
  totalSent: string;     // NUMERIC cast to TEXT
  txCount: bigint;       // INT8 - node-postgres returns bigint columns as BigInt
};

export type NftTransferQueryParams = {
  network?: Network;
  contractId?: string;
  tokenId?: string;
  address?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export type AccountSummaryQueryParams = {
  network?: Network;
  address: string;
  contractId?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export type AllTransfersQueryParams = {
  network?: Network;
  tokenDecimals?: (contractId: string, network: Network) => number | undefined;
  address: string;
  contractId?: string;
  token?: string;
  filter?: string;
  select?: string[];
  cursor?: string;
  fromLedger?: number;
  toLedger?: number;
  fromDate?: Date;
  toDate?: Date;
  eventTypes?: string[];
  limit?: number;
  offset?: number;
  /** Also run an exact COUNT. Off by default because it is expensive. */
  includeTotal?: boolean;
};

export type PopularAssetsQueryParams = {
  network?: Network;
  fromDate: Date;
  by: string;
  limit: number;
  offset: number;
};

export type PopularAssetRow = {
  contractId: string;
  transferCount: bigint;
  volume: string;
};
