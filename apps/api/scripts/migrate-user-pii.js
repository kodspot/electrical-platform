'use strict';

/**
 * One-off data migration for BUG-0030. Before the fix, supervisors' (User) Aadhaar number
 * and blood group were stored in plain text, and every supervisor edit copied them into
 * AuditLog.newValue as { from, to }. This script:
 *   1. encrypts any User aadharNo / bloodGroup still in plain text (lib/crypto.js);
 *   2. replaces those two fields in old supervisor audit rows with { changed: true }.
 *
 *   node scripts/migrate-user-pii.js            # dry run: counts only, writes nothing
 *   node scripts/migrate-user-pii.js --apply    # write
 *
 * Runs with the app's own environment (DATABASE_URL, DATA_ENCRYPTION_KEY), so in production
 * inside the api container. Prints counts, never values. Idempotent: encrypted values and
 * redacted rows are skipped, so an interrupted run can simply be repeated. Step 1 can be
 * undone with the key; step 2 cannot — take a fresh backup first (docs/DEPLOYMENT.md).
 */

const { PII_FIELDS, isEncrypted, encryptField } = require('../src/lib/crypto');

const AUDIT_ACTIONS = ['supervisor_updated', 'supervisor_deactivated', 'supervisor_reactivated'];
const PAGE = 500;

const isRedacted = (v) => v && typeof v === 'object' && v.changed === true && Object.keys(v).length === 1;

/**
 * @param {object} opts
 * @param {import('@prisma/client').PrismaClient} opts.prisma
 * @param {boolean} [opts.apply=false]   write changes (otherwise only count them)
 * @param {string[]|null} [opts.orgIds]  limit to these orgs (default: every org)
 * @param {(msg: string) => void} [opts.log]
 */
async function migrateUserPII({ prisma, apply = false, orgIds = null, log = console.log }) {
  const orgFilter = orgIds ? { orgId: { in: orgIds } } : {};
  const result = { usersToEncrypt: 0, usersEncrypted: 0, auditRowsToRedact: 0, auditRowsRedacted: 0 };

  const users = await prisma.user.findMany({
    where: { ...orgFilter, OR: PII_FIELDS.map((f) => ({ [f]: { not: null } })) },
    select: { id: true, aadharNo: true, bloodGroup: true }
  });
  for (const u of users) {
    const data = {};
    for (const f of PII_FIELDS) if (u[f] && !isEncrypted(u[f])) data[f] = encryptField(u[f]);
    if (Object.keys(data).length === 0) continue;
    result.usersToEncrypt++;
    if (apply) {
      await prisma.user.update({ where: { id: u.id }, data });
      result.usersEncrypted++;
    }
  }

  let cursor = null;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: { ...orgFilter, entityType: 'User', action: { in: AUDIT_ACTIONS } },
      select: { id: true, newValue: true },
      orderBy: { id: 'asc' },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const value = row.newValue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const fields = PII_FIELDS.filter((f) => value[f] !== undefined && !isRedacted(value[f]));
      if (fields.length === 0) continue;
      result.auditRowsToRedact++;
      if (apply) {
        const next = { ...value };
        for (const f of fields) next[f] = { changed: true };
        await prisma.auditLog.update({ where: { id: row.id }, data: { newValue: next } });
        result.auditRowsRedacted++;
      }
    }
    cursor = rows[rows.length - 1].id;
  }

  log(`migrate-user-pii (${apply ? 'apply' : 'dry run'}): users with plain-text PII ${result.usersToEncrypt}` +
    `${apply ? `, encrypted ${result.usersEncrypted}` : ''}; audit rows with PII values ${result.auditRowsToRedact}` +
    `${apply ? `, redacted ${result.auditRowsRedacted}` : ''}`);
  return result;
}

if (require.main === module) {
  // Load the app's environment the way the app does (and validate DATA_ENCRYPTION_KEY) before Prisma.
  require('../src/config/env');
  const { prisma } = require('../src/lib/prisma');
  migrateUserPII({ prisma, apply: process.argv.includes('--apply') })
    .then(async () => { await prisma.$disconnect(); process.exit(0); })
    .catch(async (e) => { console.error('migrate-user-pii: failed:', e.message); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
}

module.exports = { migrateUserPII };
