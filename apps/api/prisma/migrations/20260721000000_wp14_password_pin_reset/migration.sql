-- WP14: self-service password reset (User) and PIN reset (Worker).
-- Additive, nullable columns — safe against existing rows, no backfill needed.
ALTER TABLE "User" ADD COLUMN "resetToken" TEXT;
ALTER TABLE "User" ADD COLUMN "resetTokenExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_resetToken_key" ON "User"("resetToken");

ALTER TABLE "Worker" ADD COLUMN "resetToken" TEXT;
ALTER TABLE "Worker" ADD COLUMN "resetTokenExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Worker_resetToken_key" ON "Worker"("resetToken");
