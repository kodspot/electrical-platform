-- CreateEnum: AssetStatus
CREATE TYPE "AssetStatus" AS ENUM ('OPERATIONAL', 'UNDER_MAINTENANCE', 'FAULTY', 'DECOMMISSIONED');

-- CreateEnum: AssetCondition
CREATE TYPE "AssetCondition" AS ENUM ('NEW', 'GOOD', 'FAIR', 'POOR', 'CRITICAL');

-- CreateEnum: AssetEventType
CREATE TYPE "AssetEventType" AS ENUM ('INSTALLED', 'INSPECTED', 'MAINTAINED', 'REPAIRED', 'RELOCATED', 'DECOMMISSIONED', 'RECOMMISSIONED', 'NOTE');

-- CreateEnum: FailureSeverity
CREATE TYPE "FailureSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum: FailureStatus
CREATE TYPE "FailureStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable: Asset
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "assetCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "serialNo" TEXT,
    "ratedCapacity" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "condition" "AssetCondition" NOT NULL DEFAULT 'GOOD',
    "installDate" DATE,
    "warrantyExpiry" DATE,
    "lastMaintenanceAt" TIMESTAMP(3),
    "nextMaintenanceDue" DATE,
    "maintenanceCycleDays" INTEGER,
    "purchaseCost" DOUBLE PRECISION,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AssetEvent
CREATE TABLE "AssetEvent" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "loggedById" TEXT NOT NULL,
    "type" "AssetEventType" NOT NULL,
    "summary" TEXT NOT NULL,
    "details" TEXT,
    "cost" DOUBLE PRECISION,
    "imageUrl" TEXT,
    "statusBefore" "AssetStatus",
    "statusAfter" "AssetStatus",
    "conditionBefore" "AssetCondition",
    "conditionAfter" "AssetCondition",
    "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AssetFailure
CREATE TABLE "AssetFailure" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "loggedById" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cause" TEXT,
    "severity" "FailureSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "FailureStatus" NOT NULL DEFAULT 'OPEN',
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolution" TEXT,
    "resolutionCost" DOUBLE PRECISION,
    "downtime" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssetFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AssetImage
CREATE TABLE "AssetImage" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AssetFailureImage
CREATE TABLE "AssetFailureImage" (
    "id" TEXT NOT NULL,
    "failureId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "type" TEXT NOT NULL DEFAULT 'REPORT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetFailureImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_orgId_assetCode_key" ON "Asset"("orgId", "assetCode");
CREATE INDEX "Asset_orgId_status_idx" ON "Asset"("orgId", "status");
CREATE INDEX "Asset_orgId_category_idx" ON "Asset"("orgId", "category");
CREATE INDEX "Asset_orgId_locationId_idx" ON "Asset"("orgId", "locationId");
CREATE INDEX "Asset_orgId_isActive_idx" ON "Asset"("orgId", "isActive");
CREATE INDEX "Asset_orgId_nextMaintenanceDue_idx" ON "Asset"("orgId", "nextMaintenanceDue");

CREATE INDEX "AssetEvent_assetId_eventDate_idx" ON "AssetEvent"("assetId", "eventDate");
CREATE INDEX "AssetEvent_orgId_eventDate_idx" ON "AssetEvent"("orgId", "eventDate");
CREATE INDEX "AssetEvent_orgId_type_idx" ON "AssetEvent"("orgId", "type");

CREATE INDEX "AssetFailure_assetId_status_idx" ON "AssetFailure"("assetId", "status");
CREATE INDEX "AssetFailure_orgId_status_idx" ON "AssetFailure"("orgId", "status");
CREATE INDEX "AssetFailure_orgId_severity_idx" ON "AssetFailure"("orgId", "severity");
CREATE INDEX "AssetFailure_orgId_failedAt_idx" ON "AssetFailure"("orgId", "failedAt");

CREATE INDEX "AssetImage_assetId_idx" ON "AssetImage"("assetId");
CREATE INDEX "AssetFailureImage_failureId_idx" ON "AssetFailureImage"("failureId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetEvent" ADD CONSTRAINT "AssetEvent_loggedById_fkey" FOREIGN KEY ("loggedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssetFailure" ADD CONSTRAINT "AssetFailure_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetFailure" ADD CONSTRAINT "AssetFailure_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetFailure" ADD CONSTRAINT "AssetFailure_loggedById_fkey" FOREIGN KEY ("loggedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssetFailure" ADD CONSTRAINT "AssetFailure_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AssetImage" ADD CONSTRAINT "AssetImage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetFailureImage" ADD CONSTRAINT "AssetFailureImage_failureId_fkey" FOREIGN KEY ("failureId") REFERENCES "AssetFailure"("id") ON DELETE CASCADE ON UPDATE CASCADE;
