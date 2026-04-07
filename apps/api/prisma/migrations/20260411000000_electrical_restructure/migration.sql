-- =============================================
-- Phase 1: Electrical Platform Restructuring
-- 1. Add electrical-specific LocationType values
-- 2. Add coverChildren to WorkerAssignment
-- 3. Add SupervisorAssignment model
-- 4. Add NOTIFY_ASSIGNED_WORKERS/SUPERVISOR actions
-- =============================================

-- 1. Expand LocationType enum with electrical-specific values
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'HOSTEL';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'SUBSTATION';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'PANEL_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'GENERATOR_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'TRANSFORMER';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'UTILITY_AREA';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'LAB';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'SERVER_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'STAIRCASE';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'TERRACE';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'PARKING';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'CANTEEN';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'AUDITORIUM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'LIBRARY';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'OFFICE';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'STORE_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'PUMP_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'LIFT_ROOM';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'RECEPTION';
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'COMMON_AREA';

-- 2. Add coverChildren to WorkerAssignment
ALTER TABLE "WorkerAssignment" ADD COLUMN IF NOT EXISTS "coverChildren" BOOLEAN NOT NULL DEFAULT true;

-- 3. Create SupervisorAssignment table
CREATE TABLE IF NOT EXISTS "SupervisorAssignment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "coverChildren" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupervisorAssignment_pkey" PRIMARY KEY ("id")
);

-- SupervisorAssignment indexes
CREATE UNIQUE INDEX IF NOT EXISTS "SupervisorAssignment_supervisorId_locationId_key" ON "SupervisorAssignment"("supervisorId", "locationId");
CREATE INDEX IF NOT EXISTS "SupervisorAssignment_orgId_idx" ON "SupervisorAssignment"("orgId");
CREATE INDEX IF NOT EXISTS "SupervisorAssignment_locationId_idx" ON "SupervisorAssignment"("locationId");
CREATE INDEX IF NOT EXISTS "SupervisorAssignment_supervisorId_idx" ON "SupervisorAssignment"("supervisorId");

-- SupervisorAssignment foreign keys
ALTER TABLE "SupervisorAssignment" ADD CONSTRAINT "SupervisorAssignment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupervisorAssignment" ADD CONSTRAINT "SupervisorAssignment_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupervisorAssignment" ADD CONSTRAINT "SupervisorAssignment_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
