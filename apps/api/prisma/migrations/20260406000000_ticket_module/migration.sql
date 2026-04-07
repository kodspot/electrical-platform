-- AlterTable: Add module column to Ticket (defaults to "hk" for backward compat)
ALTER TABLE "Ticket" ADD COLUMN "module" TEXT NOT NULL DEFAULT 'hk';

-- Index: fast filtering by org + module + status
CREATE INDEX "Ticket_orgId_module_status_idx" ON "Ticket"("orgId", "module", "status");
