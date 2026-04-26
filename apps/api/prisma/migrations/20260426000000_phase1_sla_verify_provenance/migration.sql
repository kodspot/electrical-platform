-- Phase 1: SLA tracking, supervisor verification, complaint provenance
-- Migration: phase1_sla_verify_provenance

-- Add RESOLVED_PENDING_VERIFY to TicketStatus enum
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'RESOLVED_PENDING_VERIFY';

-- Add SLA fields to Ticket
ALTER TABLE "Ticket"
  ADD COLUMN IF NOT EXISTS "slaDeadlineAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "slaBreachedAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "acceptedAt"     TIMESTAMP(3);

-- Add complaint provenance fields to Ticket
ALTER TABLE "Ticket"
  ADD COLUMN IF NOT EXISTS "sourceIp"   TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent"  TEXT,
  ADD COLUMN IF NOT EXISTS "riskScore"  INTEGER NOT NULL DEFAULT 0;

-- Add supervisor verification fields to Ticket
ALTER TABLE "Ticket"
  ADD COLUMN IF NOT EXISTS "verifiedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verifiedById"  TEXT,
  ADD COLUMN IF NOT EXISTS "verifyNote"    TEXT;

-- Add foreign key for verifiedById (non-strict: no cascade, nullable)
ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- Add isUrgent flag to Notification
ALTER TABLE "Notification"
  ADD COLUMN IF NOT EXISTS "isUrgent" BOOLEAN NOT NULL DEFAULT false;

-- Index: help SLA breach detection queries
CREATE INDEX IF NOT EXISTS "Ticket_slaDeadlineAt_status_idx"
  ON "Ticket"("slaDeadlineAt", "status");

-- Index: provenance risk score queries
CREATE INDEX IF NOT EXISTS "Ticket_sourceIp_createdAt_idx"
  ON "Ticket"("sourceIp", "createdAt");

-- Index: pending verify queries
CREATE INDEX IF NOT EXISTS "Ticket_orgId_status_verifiedAt_idx"
  ON "Ticket"("orgId", "status", "verifiedAt");
