-- CreateTable: ElectricalInspection
CREATE TABLE "ElectricalInspection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "shift" "Shift" NOT NULL DEFAULT 'GENERAL',
    "notes" TEXT,
    "status" "CleaningRecordStatus" NOT NULL DEFAULT 'SUBMITTED',
    "expectedShift" "Shift",
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "lateReason" TEXT,
    "flagReason" TEXT,
    "faultyCount" INTEGER NOT NULL DEFAULT 0,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ElectricalInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ElectricalInspectionItem
CREATE TABLE "ElectricalInspectionItem" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "checkType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "remarks" TEXT,

    CONSTRAINT "ElectricalInspectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ElectricalImage
CREATE TABLE "ElectricalImage" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ElectricalImage_pkey" PRIMARY KEY ("id")
);

-- Implicit many-to-many: ElectricalInspection <-> Worker
CREATE TABLE "_ElectricalInspectionToWorker" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_ElectricalInspectionToWorker_AB_pkey" PRIMARY KEY ("A","B")
);

-- Indexes
CREATE INDEX "ElectricalInspection_orgId_inspectedAt_idx" ON "ElectricalInspection"("orgId", "inspectedAt");
CREATE INDEX "ElectricalInspection_orgId_locationId_idx" ON "ElectricalInspection"("orgId", "locationId");
CREATE INDEX "ElectricalInspection_supervisorId_inspectedAt_idx" ON "ElectricalInspection"("supervisorId", "inspectedAt");
CREATE INDEX "ElectricalInspection_orgId_status_idx" ON "ElectricalInspection"("orgId", "status");
CREATE INDEX "ElectricalInspectionItem_inspectionId_idx" ON "ElectricalInspectionItem"("inspectionId");
CREATE INDEX "ElectricalImage_inspectionId_idx" ON "ElectricalImage"("inspectionId");
CREATE INDEX "_ElectricalInspectionToWorker_B_index" ON "_ElectricalInspectionToWorker"("B");

-- Foreign Keys
ALTER TABLE "ElectricalInspection" ADD CONSTRAINT "ElectricalInspection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ElectricalInspection" ADD CONSTRAINT "ElectricalInspection_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ElectricalInspection" ADD CONSTRAINT "ElectricalInspection_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ElectricalInspectionItem" ADD CONSTRAINT "ElectricalInspectionItem_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "ElectricalInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ElectricalImage" ADD CONSTRAINT "ElectricalImage_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "ElectricalInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_ElectricalInspectionToWorker" ADD CONSTRAINT "_ElectricalInspectionToWorker_A_fkey" FOREIGN KEY ("A") REFERENCES "ElectricalInspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ElectricalInspectionToWorker" ADD CONSTRAINT "_ElectricalInspectionToWorker_B_fkey" FOREIGN KEY ("B") REFERENCES "Worker"("id") ON DELETE CASCADE ON UPDATE CASCADE;
