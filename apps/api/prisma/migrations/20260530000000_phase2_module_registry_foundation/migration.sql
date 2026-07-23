-- Phase 2: Module Registry Foundation

CREATE TABLE IF NOT EXISTS "ModuleDefinition" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isCore" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModuleDefinition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ModuleDefinition_code_key" ON "ModuleDefinition"("code");
CREATE INDEX IF NOT EXISTS "ModuleDefinition_isActive_sortOrder_idx" ON "ModuleDefinition"("isActive", "sortOrder");

CREATE TABLE IF NOT EXISTS "ModuleDependency" (
  "id" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "dependsOnModuleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModuleDependency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ModuleDependency_moduleId_dependsOnModuleId_key"
  ON "ModuleDependency"("moduleId", "dependsOnModuleId");
CREATE INDEX IF NOT EXISTS "ModuleDependency_dependsOnModuleId_idx"
  ON "ModuleDependency"("dependsOnModuleId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ModuleDependency_moduleId_fkey'
  ) THEN
    ALTER TABLE "ModuleDependency"
      ADD CONSTRAINT "ModuleDependency_moduleId_fkey"
      FOREIGN KEY ("moduleId") REFERENCES "ModuleDefinition"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'ModuleDependency_dependsOnModuleId_fkey'
  ) THEN
    ALTER TABLE "ModuleDependency"
      ADD CONSTRAINT "ModuleDependency_dependsOnModuleId_fkey"
      FOREIGN KEY ("dependsOnModuleId") REFERENCES "ModuleDefinition"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "OrgModuleActivation" (
  "id" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "moduleId" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activatedById" TEXT,
  "deactivatedAt" TIMESTAMP(3),
  "deactivatedById" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrgModuleActivation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrgModuleActivation_orgId_moduleId_key"
  ON "OrgModuleActivation"("orgId", "moduleId");
CREATE INDEX IF NOT EXISTS "OrgModuleActivation_orgId_isActive_idx"
  ON "OrgModuleActivation"("orgId", "isActive");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'OrgModuleActivation_orgId_fkey'
  ) THEN
    ALTER TABLE "OrgModuleActivation"
      ADD CONSTRAINT "OrgModuleActivation_orgId_fkey"
      FOREIGN KEY ("orgId") REFERENCES "Organization"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'OrgModuleActivation_moduleId_fkey'
  ) THEN
    ALTER TABLE "OrgModuleActivation"
      ADD CONSTRAINT "OrgModuleActivation_moduleId_fkey"
      FOREIGN KEY ("moduleId") REFERENCES "ModuleDefinition"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Seed default module definitions (id values are deterministic for easy upserts)
INSERT INTO "ModuleDefinition" ("id", "code", "name", "isCore", "isActive", "sortOrder") VALUES
  ('mod-ele', 'ele', 'Electrical', true, true, 10),
  ('mod-civil', 'civil', 'Civil', false, true, 20),
  ('mod-asset', 'asset', 'Asset Management', false, true, 30),
  ('mod-complaints', 'complaints', 'Complaints', false, true, 40)
ON CONFLICT ("code") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "isCore" = EXCLUDED."isCore",
  "isActive" = true,
  "sortOrder" = EXCLUDED."sortOrder",
  "updatedAt" = CURRENT_TIMESTAMP;

-- Seed default dependencies
INSERT INTO "ModuleDependency" ("id", "moduleId", "dependsOnModuleId")
SELECT
  'dep-' || d."moduleCode" || '-' || d."dependsOnCode",
  m."id",
  dm."id"
FROM (
  VALUES
    ('civil', 'ele'),
    ('asset', 'ele'),
    ('complaints', 'ele')
) AS d("moduleCode", "dependsOnCode")
JOIN "ModuleDefinition" m ON m."code" = d."moduleCode"
JOIN "ModuleDefinition" dm ON dm."code" = d."dependsOnCode"
ON CONFLICT ("moduleId", "dependsOnModuleId") DO NOTHING;

-- Backfill activation rows from Organization.enabledModules
INSERT INTO "OrgModuleActivation" (
  "id", "orgId", "moduleId", "isActive", "activatedAt", "createdAt", "updatedAt"
)
SELECT
  'oma-' || o."id" || '-' || md."code",
  o."id",
  md."id",
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Organization" o
CROSS JOIN LATERAL unnest(o."enabledModules") AS em("code")
JOIN "ModuleDefinition" md ON md."code" = em."code"
ON CONFLICT ("orgId", "moduleId") DO UPDATE
SET
  "isActive" = true,
  "deactivatedAt" = NULL,
  "deactivatedById" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;
