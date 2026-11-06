'use strict';

/**
 * BUG-0076 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestWorker } = require('../factories');

module.exports = {
  id: 'BUG-0076',
  title: 'Electricians had no way to get a copy of their own data, and the staff export had no button',
  description: 'GET /auth/export served staff tokens only, no page called it, and the privacy notice promised a data export feature. Electricians are a separate account type, and they alone have Aadhaar and blood group stored.',
  module: 'ele',
  category: 'privacy',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Security and DPDP audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The export was built for one account type and never wired to a screen.',
  expectedBehavior: 'GET /auth/worker-export gives an electrician their own record, attendance, inspections and tickets, decrypted, and no one else\'s; "Download my data" is in the account menu.',
  brokenBehavior: 'No access to their own data without asking the admin.',
  reproductionSteps: [
    'Sign in as an electrician.',
    'Call GET /api/auth/worker-export.',
    'Broken: 404. Fixed: their own data.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0076-electrician-cannot-export-own-data.js',

  async apply() {
    const org = await createTestOrg();
    const worker = await createTestWorker(org.id, { pin: '135792' });
    const other = await createTestWorker(org.id, { pin: '135793' });
    return { org, worker, other };
  },

  async validate(ctx) {
    const { org, worker, other } = ctx['BUG-0076'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': '10.88.76.1' }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: '135792' } });
    if (login.statusCode !== 200) return { ok: false, detail: 'worker-login answered ' + login.statusCode };
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/worker-export', headers: { authorization: 'Bearer ' + login.json().token, 'x-forwarded-for': '10.88.76.1' } });
    if (res.statusCode !== 200) return { ok: false, detail: 'worker-export answered ' + res.statusCode };
    const body = res.json();
    if (body.personalData.id !== worker.id) return { ok: false, detail: 'the export is not the signed-in electrician' };
    if (JSON.stringify(body).includes(other.id)) return { ok: false, detail: 'the export holds another electrician' };
    const anon = await ctx.app.inject({ method: 'GET', url: '/api/auth/worker-export', headers: { 'x-forwarded-for': '10.88.76.1' } });
    if (anon.statusCode !== 401) return { ok: false, detail: 'without a session it answered ' + anon.statusCode };
    return { ok: true, detail: 'an electrician can read their own data, and only theirs' };
  }
};
