-- Complaint categories with optional hostel-level scope
-- Backward-compatible addition: no existing ticket data is modified.

CREATE TABLE IF NOT EXISTS "ComplaintCategory" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "module" TEXT NOT NULL DEFAULT 'ele',
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "hostelLocationId" TEXT,
  "createdById" TEXT,
  "updatedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ComplaintCategory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ComplaintCategory"
  ADD CONSTRAINT "ComplaintCategory_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ComplaintCategory"
  ADD CONSTRAINT "ComplaintCategory_hostelLocationId_fkey"
  FOREIGN KEY ("hostelLocationId") REFERENCES "Location"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "ComplaintCategory_orgId_module_isActive_sortOrder_idx"
  ON "ComplaintCategory"("orgId", "module", "isActive", "sortOrder");

CREATE INDEX IF NOT EXISTS "ComplaintCategory_orgId_hostelLocationId_idx"
  ON "ComplaintCategory"("orgId", "hostelLocationId");

CREATE INDEX IF NOT EXISTS "ComplaintCategory_orgId_module_key_idx"
  ON "ComplaintCategory"("orgId", "module", "key");
