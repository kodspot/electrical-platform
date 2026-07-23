-- Expand ticket lifecycle statuses without breaking existing rows.
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'ACKNOWLEDGED';
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'ON_HOLD';
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
