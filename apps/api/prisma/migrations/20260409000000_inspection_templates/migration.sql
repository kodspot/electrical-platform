-- CreateTable: InspectionTemplate
CREATE TABLE "InspectionTemplate" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "locationTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InspectionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable: InspectionTemplateItem
CREATE TABLE "InspectionTemplateItem" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "checkKey" TEXT NOT NULL,
    "responseType" TEXT NOT NULL DEFAULT 'STATUS',
    "unit" TEXT,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InspectionTemplateItem_pkey" PRIMARY KEY ("id")
);

-- Add templateId to ElectricalInspection (nullable for backward compat)
ALTER TABLE "ElectricalInspection" ADD COLUMN "templateId" TEXT;

-- Add templateItemId and reading to ElectricalInspectionItem
ALTER TABLE "ElectricalInspectionItem" ADD COLUMN "templateItemId" TEXT;
ALTER TABLE "ElectricalInspectionItem" ADD COLUMN "reading" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "InspectionTemplate_orgId_isActive_idx" ON "InspectionTemplate"("orgId", "isActive");
CREATE INDEX "InspectionTemplate_orgId_isDefault_idx" ON "InspectionTemplate"("orgId", "isDefault");
CREATE INDEX "InspectionTemplateItem_templateId_idx" ON "InspectionTemplateItem"("templateId");
CREATE INDEX "ElectricalInspection_templateId_idx" ON "ElectricalInspection"("templateId");
CREATE INDEX "ElectricalInspectionItem_templateItemId_idx" ON "ElectricalInspectionItem"("templateItemId");

-- AddForeignKey
ALTER TABLE "InspectionTemplate" ADD CONSTRAINT "InspectionTemplate_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InspectionTemplateItem" ADD CONSTRAINT "InspectionTemplateItem_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "InspectionTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ElectricalInspection" ADD CONSTRAINT "ElectricalInspection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "InspectionTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ElectricalInspectionItem" ADD CONSTRAINT "ElectricalInspectionItem_templateItemId_fkey" FOREIGN KEY ("templateItemId") REFERENCES "InspectionTemplateItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
