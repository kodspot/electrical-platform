-- Strip Housekeeping: Drop cleaning tables, enums, columns; rename CleaningRecordStatus → InspectionStatus
-- This migration removes all housekeeping/cleaning-specific schema objects

-- 1. Drop junction table for CleaningRecord ↔ Worker
DROP TABLE IF EXISTS "_CleaningRecordToWorker" CASCADE;

-- 2. Drop CleaningImage (depends on CleaningRecord)
DROP TABLE IF EXISTS "CleaningImage" CASCADE;

-- 3. Drop CleaningRecord
DROP TABLE IF EXISTS "CleaningRecord" CASCADE;

-- 4. Drop CleaningSchedule
DROP TABLE IF EXISTS "CleaningSchedule" CASCADE;

-- 5. Drop CleaningFrequency enum
DROP TYPE IF EXISTS "CleaningFrequency";

-- 6. Remove allowDuplicateCleaning column from Organization
ALTER TABLE "Organization" DROP COLUMN IF EXISTS "allowDuplicateCleaning";

-- 7. Rename CleaningRecordStatus enum → InspectionStatus (if it exists)
-- The ElectricalInspection.status column already uses this enum (same values: SUBMITTED, FLAGGED)
-- On a fresh DB this enum may not exist — the schema creates InspectionStatus directly
DO $$ BEGIN
  ALTER TYPE "CleaningRecordStatus" RENAME TO "InspectionStatus";
EXCEPTION WHEN undefined_object THEN
  -- Enum doesn't exist (fresh database) — nothing to rename
  NULL;
END $$;

-- 8. Update default enabledModules from hk to ele where still set to old default
UPDATE "Organization" SET "enabledModules" = ARRAY['ele']
WHERE "enabledModules" = ARRAY['hk'];

-- 9. Update ticket module from hk to ele where applicable
UPDATE "Ticket" SET "module" = 'ele' WHERE "module" = 'hk';
