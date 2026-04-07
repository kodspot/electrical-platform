-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "aiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Organization" ADD COLUMN "aiProvider" TEXT;
ALTER TABLE "Organization" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "Organization" ADD COLUMN "aiApiKey" TEXT;
