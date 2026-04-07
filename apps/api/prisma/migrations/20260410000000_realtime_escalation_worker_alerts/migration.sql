-- Worker auth: PIN-based login
ALTER TABLE "Worker" ADD COLUMN "pinHash" TEXT;
ALTER TABLE "Worker" ADD COLUMN "tokenInvalidBefore" TIMESTAMP(3);

-- Notification: make userId optional, add workerId
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "workerId" TEXT;

-- Notification: worker FK + index
ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_workerId_fkey"
  FOREIGN KEY ("workerId") REFERENCES "Worker"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Notification_workerId_isRead_idx" ON "Notification"("workerId", "isRead");

-- AlertRule: escalation policy fields
ALTER TABLE "AlertRule" ADD COLUMN "escalateAfterMinutes" INTEGER;
ALTER TABLE "AlertRule" ADD COLUMN "escalationActions" JSONB;
ALTER TABLE "AlertRule" ADD COLUMN "maxEscalations" INTEGER DEFAULT 1;

-- Alert: escalation tracking
ALTER TABLE "Alert" ADD COLUMN "escalationLevel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Alert" ADD COLUMN "lastEscalatedAt" TIMESTAMP(3);
