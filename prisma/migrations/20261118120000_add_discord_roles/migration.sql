-- The Veil Discord roles bot (src/discord).
--
-- DiscordMember is the only place a Discord account and a wallet address are
-- written down together, and no route returns it. It holds no balance, no
-- amount and no secret: two public addresses, a GitHub id, and the readings
-- needed to tell how active the wallet is.
CREATE TABLE "wraith"."DiscordMember" (
  "discordUserId" TEXT NOT NULL,
  "network" TEXT NOT NULL DEFAULT 'mainnet',
  "wallet" TEXT,
  "spending" TEXT,
  "linkedAt" TIMESTAMP(3),
  "names" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "githubId" TEXT,
  "githubLogin" TEXT,
  "nonceHistory" JSONB,
  "firstSeenAt" TIMESTAMP(3),
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DiscordMember_pkey" PRIMARY KEY ("discordUserId")
);

-- A wallet, a spending account or a GitHub account belongs to one member.
CREATE UNIQUE INDEX "DiscordMember_wallet_key" ON "wraith"."DiscordMember"("wallet");
CREATE UNIQUE INDEX "DiscordMember_spending_key" ON "wraith"."DiscordMember"("spending");
CREATE UNIQUE INDEX "DiscordMember_githubId_key" ON "wraith"."DiscordMember"("githubId");
CREATE INDEX "DiscordMember_checkedAt_idx" ON "wraith"."DiscordMember"("checkedAt");

-- A short code tying one signing request to the member who asked for it.
CREATE TABLE "wraith"."DiscordLinkCode" (
  "code" TEXT NOT NULL,
  "discordUserId" TEXT NOT NULL,
  "discordUsername" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiscordLinkCode_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "DiscordLinkCode_discordUserId_idx" ON "wraith"."DiscordLinkCode"("discordUserId");
CREATE INDEX "DiscordLinkCode_expiresAt_idx" ON "wraith"."DiscordLinkCode"("expiresAt");

-- A GitHub device-flow request waiting for approval. Never holds a token.
CREATE TABLE "wraith"."DiscordGithubRequest" (
  "discordUserId" TEXT NOT NULL,
  "deviceCode" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DiscordGithubRequest_pkey" PRIMARY KEY ("discordUserId")
);
