'use strict';

/**
 * BUG-0030 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser } = require('../factories');

const AADHAAR = '5432 1098 7654';

module.exports = {
  id: 'BUG-0030',
  title: 'Supervisors\' Aadhaar numbers and blood groups were stored in plain text and copied into audit logs',
  description: 'POST /api/supervisors and PATCH /api/supervisors/:id wrote User.aadharNo and User.bloodGroup as typed. Only electricians\' (Worker) values went through lib/crypto.js. Every supervisor edit also copied the old and new values into AuditLog.newValue as { from, to }, and from there into every backup. The Engineering Charter (§6) requires these fields encrypted at rest, and docs/architecture/data-model.md said they were. Found by the 2026-10 product and architecture review (PAR-10/15).',
  module: 'ele',
  category: 'data-exposure',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/15)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'supervisors.js never called the PII encryption helpers (they were named and used for workers only), and its audit diff recorded every changed field\'s raw values.',
  expectedBehavior: 'Both fields are stored encrypted ("v1:…") and read back decrypted by the admin; audit rows record { changed: true } for them. scripts/migrate-user-pii.js encrypts rows saved before the fix.',
  brokenBehavior: 'The database row and the audit row held the Aadhaar number as typed.',
  reproductionSteps: [
    'As an org admin, POST /api/supervisors with an aadharNo, then PATCH it to another number.',
    'Read User.aadharNo and the supervisor_updated AuditLog row directly from the database.',
    'Broken: both hold the numbers in plain text. Fixed: the row holds "v1:…" and the audit row { changed: true }.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/supervisor-pii.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    return { org, admin };
  },

  async validate(ctx) {
    const { org, admin } = ctx['BUG-0030'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.30' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const headers = { authorization: `Bearer ${login.json().token}` };
    const created = await ctx.app.inject({ method: 'POST', url: '/api/supervisors', headers, payload: { name: '__wp1_test__ BUG-0030', email: `bug0030-${Date.now()}@example.test`, password: 'Bug0030pass', aadharNo: AADHAAR } });
    if (created.statusCode !== 200) return { ok: false, detail: `create expected 200, got ${created.statusCode}` };
    const id = created.json().id;
    await ctx.app.inject({ method: 'PATCH', url: `/api/supervisors/${id}`, headers, payload: { aadharNo: '1111 2222 3333' } });
    const row = await ctx.prisma.user.findUnique({ where: { id }, select: { aadharNo: true } });
    if (!/^v1:/.test(row.aadharNo || '')) return { ok: false, detail: 'the Aadhaar number is stored in plain text' };
    const audit = await ctx.prisma.auditLog.findFirst({ where: { orgId: org.id, entityId: id, action: 'supervisor_updated' } });
    if (!audit || JSON.stringify(audit).includes(AADHAAR) || JSON.stringify(audit).includes('1111 2222 3333')) return { ok: false, detail: 'the audit row holds the Aadhaar number' };
    return { ok: true, detail: 'stored encrypted; the audit row records only that it changed' };
  }
};
