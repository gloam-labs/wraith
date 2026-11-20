import { Prisma } from "@prisma/client";
import type { NftTransferRecord, NftMetadataPayload } from "../ingester/nft";
import { decodeCursor, parseODataFilter, parseODataSelect } from "../lib/odata";
import { resolveNetwork, type Network } from "../network";
import { observeDbQuery } from "../metrics";
import { when } from "../prismaWhen";
import { prisma, buildListPage, selectRows, totalField } from "./client";
import {
  type NftTransferQueryParams,
  NFT_TRANSFER_SELECTABLE_FIELDS,
  NFT_TRANSFER_FIELD_TYPES,
} from "./types";

export async function upsertNftTransfers(
  records: NftTransferRecord[],
  network?: Network
): Promise<number> {
  if (records.length === 0) return 0;
  const net = resolveNetwork(network);
  const result = await observeDbQuery("upsertNftTransfers", () =>
    prisma.nftTransfer.createMany({
      data: records.map((r) => ({ ...r, network: net })),
      skipDuplicates: true,
    })
  );
  return result.count;
}

export async function getNftMetadata(
  contractId: string,
  tokenId: string,
  network?: Network
): Promise<{ name: string | null; tokenUri: string | null } | null> {
  return prisma.nftMetadata.findUnique({
    where: {
      network_contractId_tokenId: { network: resolveNetwork(network), contractId, tokenId },
    },
    select: { name: true, tokenUri: true },
  });
}

export async function upsertNftMetadata(
  contractId: string,
  tokenId: string,
  data: NftMetadataPayload,
  network?: Network
): Promise<void> {
  const net = resolveNetwork(network);
  await prisma.nftMetadata.upsert({
    where: { network_contractId_tokenId: { network: net, contractId, tokenId } },
    create: {
      network: net,
      contractId,
      tokenId,
      name: data.name ?? null,
      tokenUri: data.tokenUri ?? null,
    },
    update: { name: data.name ?? null, tokenUri: data.tokenUri ?? null, fetchedAt: new Date() },
  });
}

export async function queryNftTransfers(params: NftTransferQueryParams) {
  const {
    network,
    contractId,
    tokenId,
    address,
    filter,
    select,
    cursor,
    fromLedger,
    toLedger,
    limit = 50,
    offset = 0,
    includeTotal = false,
  } = params;

  const baseWhere: Prisma.NftTransferWhereInput = {
    network: resolveNetwork(network),
    ...when<Prisma.NftTransferWhereInput>(Boolean(contractId), { contractId }),
    ...when<Prisma.NftTransferWhereInput>(Boolean(tokenId), { tokenId }),
    ...when<Prisma.NftTransferWhereInput>(Boolean(address), {
      OR: [{ fromAddress: address }, { toAddress: address }],
    }),
    ...when<Prisma.NftTransferWhereInput>(Boolean(fromLedger || toLedger), {
      ledger: {
        ...when<Prisma.IntFilter>(Boolean(fromLedger), { gte: fromLedger }),
        ...when<Prisma.IntFilter>(Boolean(toLedger), { lte: toLedger }),
      },
    }),
  };

  const odataWhere = parseODataFilter(filter, NFT_TRANSFER_FIELD_TYPES);
  const where: Prisma.NftTransferWhereInput = odataWhere
    ? { AND: [baseWhere, odataWhere as Prisma.NftTransferWhereInput] }
    : baseWhere;

  const requestedSelect = parseODataSelect(select?.join(","), NFT_TRANSFER_SELECTABLE_FIELDS);
  const prismaSelect = requestedSelect
    ? {
        id: true,
        contractId: requestedSelect.includes("contractId"),
        tokenId: requestedSelect.includes("tokenId"),
        fromAddress: requestedSelect.includes("fromAddress"),
        toAddress: requestedSelect.includes("toAddress"),
        ledger: requestedSelect.includes("ledger"),
        ledgerClosedAt: requestedSelect.includes("ledgerClosedAt"),
        txHash: requestedSelect.includes("txHash"),
        eventId: requestedSelect.includes("eventId"),
        createdAt: requestedSelect.includes("createdAt"),
      }
    : undefined;

  const cap = Math.min(limit, 200);
  const cursorId = decodeCursor(cursor);
  const rowsQuery = prisma.nftTransfer.findMany({
    where,
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    take: cap + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : { skip: offset }),
    ...(prismaSelect ? { select: prismaSelect } : {}),
  });
  const [total, transfers] = includeTotal
    ? await prisma.$transaction([prisma.nftTransfer.count({ where }), rowsQuery])
    : ([undefined, await rowsQuery] as const);

  const page = buildListPage(transfers as Array<{ id: number }>, cap);

  return {
    ...totalField(total),
    hasMore: page.hasMore,
    transfers: selectRows(page.rows as Array<Record<string, unknown>>, requestedSelect),
    nextCursor: page.nextCursor,
  };
}

/**
 * Return the current owner of a token: the toAddress of its most recent transfer.
 */
export async function getNftOwner(
  contractId: string,
  tokenId: string,
  network?: Network
): Promise<string | null> {
  const latest = await prisma.nftTransfer.findFirst({
    where: { network: resolveNetwork(network), contractId, tokenId, toAddress: { not: null } },
    orderBy: [{ ledger: "desc" }, { id: "desc" }],
    select: { toAddress: true },
  });
  return latest?.toAddress ?? null;
}
