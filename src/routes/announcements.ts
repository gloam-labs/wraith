import { Router, Request, Response, NextFunction } from "express";
import { parseOr400 } from "../openapi/validation";
import { announcementsQuerySchema } from "../openapi/schemas";
import { requestNetwork } from "../middleware/network";
import { privacyGuardMiddleware } from "../middleware/privacyGuard";
import { queryAnnouncements } from "../stealth/announcements";

export function createAnnouncementsRouter(): Router {
  const router = Router();

  router.use(privacyGuardMiddleware);

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseOr400(announcementsQuerySchema, req.query, res);
      if (!parsed) return;

      const network = requestNetwork(req);

      const page = await queryAnnouncements({
        network,
        fromLedger: parsed.fromLedger,
        toLedger: parsed.toLedger,
        viewTag: parsed.viewTag,
        limit: parsed.limit,
        cursor: parsed.cursor,
      });

      res.json({
        announcements: page.announcements.map((a) => ({
          ...a,
          ledgerClosedAt: a.ledgerClosedAt.toISOString(),
        })),
        fromLedger: page.fromLedger,
        ...(page.toLedger !== undefined ? { toLedger: page.toLedger } : {}),
        limit: page.limit,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
