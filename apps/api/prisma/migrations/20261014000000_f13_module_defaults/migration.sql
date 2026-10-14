-- F13: the column defaults still named the old housekeeping module ('hk'), which is not a
-- valid module. Every create path sets the value explicitly, so no existing row is affected;
-- this aligns the database defaults with schema.prisma. Defaults only — no UPDATE of rows.

-- AlterTable
ALTER TABLE "Organization" ALTER COLUMN "enabledModules" SET DEFAULT ARRAY['ele']::TEXT[];

-- AlterTable
ALTER TABLE "Ticket" ALTER COLUMN "module" SET DEFAULT 'ele';
