-- Give the Discord recheck enough state to stop a failing member from
-- occupying every run (#385).
--
-- `lastAttemptAt` records every attempt, not only successes, so the job can
-- order by it and a member whose check threw goes to the back of the queue.
-- `checkedAt` keeps its old meaning: when the facts were last read
-- successfully, which is what "this role is still true" means.
--
-- `failedAttempts` and `absentChecks` are consecutive counters, reset on the
-- opposite outcome. Each buys a longer wait before the next attempt, so a
-- member who keeps failing, or who has left the server, is checked less and
-- less often instead of first every day.
--
-- Additive only: three new columns, all nullable or defaulted, and one index.
-- The service runs `prisma db push` on every start, so this applies itself and
-- nothing existing is dropped, renamed or narrowed.
ALTER TABLE "wraith"."DiscordMember"
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "absentChecks" INTEGER NOT NULL DEFAULT 0;

-- The job selects due members oldest-attempted first; without this every tick
-- is a sequential scan of the whole table.
CREATE INDEX "DiscordMember_lastAttemptAt_idx" ON "wraith"."DiscordMember"("lastAttemptAt");
