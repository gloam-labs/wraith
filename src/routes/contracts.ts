import { Router, Request, Response, NextFunction } from "express";
import { queryHostFnLogs } from "../indexer/host-fn-log";
import { queryNftTransfers, getNftOwner, getNftMetadata } from "../db";
import { parseOr400 } from "../openapi/validation";
import {
  hostFnQuerySchema,
  nftTransfersQuerySchema,
  nftOwnerParamsSchema,
} from "../openapi/schemas";
import { requestNetwork } from "../middleware/network";

/**
 * Contracts and NFT router.
 *
 * Endpoints:
 *   GET /host-fn/:contractId               — Raw host-function invocation logs
 *   GET /nfts/transfers                    — CAP-46 NFT transfer events
 *   GET /nfts/owners/:contract/:token_id   — Current owner & metadata of an NFT
 */
export function createContractsRouter(): Router {
  const router = Router();

  // ─── GET /host-fn/:contractId ────────────────────────────────────────────
  router.get(
    "/host-fn/:contractId",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(hostFnQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { contractId, functionName, limit, offset } = parsed;

        const { total, logs } = await queryHostFnLogs({
          network: requestNetwork(req),
          contractId,
          functionName,
          limit,
          offset,
        });

        res.json({
          contractId,
          total,
          limit,
          offset,
          logs: logs.map((log) => ({
            ...log,
            gasUsed: log.gasUsed === null ? null : log.gasUsed.toString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /nfts/transfers ─────────────────────────────────────────────────
  router.get(
    "/nfts/transfers",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(nftTransfersQuerySchema, req.query, res);
        if (!parsed) return;
        const { contract, token_id, address, fromLedger, toLedger, limit, offset, cursor, $filter, $select } = parsed as {
          contract?: string;
          token_id?: string;
          address?: string;
          fromLedger?: number;
          toLedger?: number;
          limit: number;
          offset: number;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const result = await queryNftTransfers({
          network: requestNetwork(req),
          contractId: contract,
          tokenId: token_id,
          address,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          limit,
          offset,
          includeTotal: (parsed as { includeTotal?: boolean }).includeTotal,
        });

        res.json({ ...result, limit, offset });
      } catch (err) {
        next(err);
      }
    }
  );

  // ─── GET /nfts/owners/:contract/:token_id ────────────────────────────────
  router.get(
    "/nfts/owners/:contract/:token_id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(nftOwnerParamsSchema, req.params, res);
        if (!parsed) return;
        const { contract, token_id } = parsed;

        const network = requestNetwork(req);
        const [owner, metadata] = await Promise.all([
          getNftOwner(contract, token_id, network),
          getNftMetadata(contract, token_id, network),
        ]);

        if (owner === null) {
          res.status(404).json({
            error: "Token not found. No transfers indexed for this contract/token_id.",
          });
          return;
        }

        res.json({
          contract,
          token_id,
          owner,
          metadata: metadata
            ? { name: metadata.name, tokenUri: metadata.tokenUri }
            : null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
