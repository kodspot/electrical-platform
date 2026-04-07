-- AlterTable: Add AI governance fields to Organization
ALTER TABLE "Organization" ADD COLUMN "aiApiKeyLastUsedAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN "aiMonthlyTokenLimit" INTEGER DEFAULT 100000;
ALTER TABLE "Organization" ADD COLUMN "aiTotalTokensUsed" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: AiUsageLog for tracking all AI requests
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "prompt" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "totalTokens" INTEGER,
    "latencyMs" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "keySource" TEXT NOT NULL DEFAULT 'org',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsageLog_orgId_createdAt_idx" ON "AiUsageLog"("orgId", "createdAt");
CREATE INDEX "AiUsageLog_orgId_action_idx" ON "AiUsageLog"("orgId", "action");
CREATE INDEX "AiUsageLog_userId_createdAt_idx" ON "AiUsageLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiUsageLog" ADD CONSTRAINT "AiUsageLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
