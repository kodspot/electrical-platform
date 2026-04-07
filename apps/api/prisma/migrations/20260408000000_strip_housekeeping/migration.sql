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

-- 7. Rename CleaningRecordStatus enum → InspectionStatus
-- The ElectricalInspection.status column already uses this enum (same values: SUBMITTED, FLAGGED)
ALTER TYPE "CleaningRecordStatus" RENAME TO "InspectionStatus";

-- 8. Update default enabledModules from hk to ele where still set to old default
UPDATE "Organization" SET "enabledModules" = '["ele"]'::jsonb
WHERE "enabledModules" = '["hk"]'::jsonb;

-- 9. Update ticket module from hk to ele where applicable
UPDATE "Ticket" SET "module" = 'ele' WHERE "module" = 'hk';
