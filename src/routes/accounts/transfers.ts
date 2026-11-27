import { Router, Request, Response, NextFunction } from "express";
import { queryAllTransfers } from "../../db";
import { parseOr400 } from "../../openapi/validation";
import { transferQuerySchema } from "../../openapi/schemas";
import { requestNetwork } from "../../middleware/network";
import { getCachedTokenDecimals } from "../../tokenCache";
import { toDisplayAmount } from "../../amount";

const withDisplay = <T extends { amount: string; contractId?: string }>(
  transfer: T,
  network: ReturnType<typeof requestNetwork>,
) => ({
  ...transfer,
  displayAmount: toDisplayAmount(
    transfer.amount,
    transfer.contractId ? getCachedTokenDecimals(transfer.contractId, network) : undefined,
  ),
});
export function createAccountsTransfersRouter(): Router {
  const router = Router({ mergeParams: true });

  router.get(
    "/",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = parseOr400(transferQuerySchema, { ...req.params, ...req.query }, res);
        if (!parsed) return;
        const { address, contractId, fromLedger, toLedger, fromDate, toDate, eventType, limit, offset, token, cursor, $filter, $select } = parsed as {
          address: string;
          contractId?: string;
          fromLedger?: number;
          toLedger?: number;
          fromDate?: Date;
          toDate?: Date;
          eventType?: string[];
          limit: number;
          offset: number;
          token?: string;
          cursor?: string;
          $filter?: string;
          $select?: string[];
        };

        const network = requestNetwork(req);
        const result = await queryAllTransfers({
          network,
          tokenDecimals: getCachedTokenDecimals,
          address,
          contractId,
          token,
          filter: $filter,
          select: $select as string[] | undefined,
          cursor,
          fromLedger,
          toLedger,
          fromDate,
          toDate,
          eventTypes: eventType as string[] | undefined,
          limit,
          offset,
          includeTotal: (parsed as { includeTotal?: boolean }).includeTotal,
        });

        res.json({
          ...result,
          transfers: result.transfers.map((transfer) => {
            if (transfer && typeof (transfer as { amount?: unknown }).amount === "string") {
              return withDisplay(transfer as { amount: string; contractId?: string }, network);
            }
            return transfer;
          }),
          limit,
          offset,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
}
