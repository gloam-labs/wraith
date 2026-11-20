import { Prisma } from "@prisma/client";
import { resolveNetwork } from "../network";
import { prisma } from "./client";
import type { PopularAssetRow, PopularAssetsQueryParams } from "./types";

export async function queryPopularAssets(params: PopularAssetsQueryParams) {
  const { network, fromDate, by, limit, offset } = params;
  const net = resolveNetwork(network);
  const cap = Math.min(limit, 100);

  const orderClause = by === "volume"
    ? Prisma.sql`SUM(CAST("amount" AS NUMERIC)) DESC`
    : Prisma.sql`COUNT(*) DESC`;

  // Both halves filter on network. Leaving it off the count but not the page
  // (or vice versa) would return a total that disagrees with the rows.
  const countResult = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(DISTINCT "contractId")::INT8 AS "total"
    FROM "wraith"."TokenTransfer"
    WHERE "network" = ${net} AND "ledgerClosedAt" >= ${fromDate}
  `;
  const total = Number(countResult[0]?.total ?? 0);

  const assets = await prisma.$queryRaw<PopularAssetRow[]>`
    SELECT
      "contractId",
      COUNT(*)::INT8 AS "transferCount",
      COALESCE(SUM(CAST("amount" AS NUMERIC)), 0)::TEXT AS "volume"
    FROM "wraith"."TokenTransfer"
    WHERE "network" = ${net} AND "ledgerClosedAt" >= ${fromDate}
    GROUP BY "contractId"
    ORDER BY ${orderClause}
    LIMIT ${cap}
    OFFSET ${offset}
  `;

  return { total, assets };
}
