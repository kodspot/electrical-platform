-- WP-Q: platform-level QA telemetry for the super-admin Quality page (ADR 0005).
-- Additive only: a new table and its indexes. No existing table is altered.

-- CreateTable
CREATE TABLE "QaRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "commitSha" TEXT,
    "ref" TEXT,
    "event" TEXT,
    "runUrl" TEXT,
    "nodeVersion" TEXT,
    "status" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "cancelled" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "todo" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "details" JSONB,

    CONSTRAINT "QaRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QaRun_createdAt_idx" ON "QaRun"("createdAt");

-- CreateIndex
CREATE INDEX "QaRun_source_createdAt_idx" ON "QaRun"("source", "createdAt");
