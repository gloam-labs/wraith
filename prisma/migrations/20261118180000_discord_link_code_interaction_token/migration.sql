-- Lets the bot change its "tap to link" message into the result once the
-- wallet is proved. Short-lived, and cleared when the code is used.
ALTER TABLE "wraith"."DiscordLinkCode" ADD COLUMN "interactionToken" TEXT;
