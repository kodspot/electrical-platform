'use strict';

/**
 * BUG-0020 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestLocation } = require('../factories');

module.exports = {
  id: 'BUG-0020',
  title: 'A guest complaint could be filed under a module the organization had not enabled',
  description: 'POST /api/public/complaint checked only that the module code was one of the platform\'s modules, not that the organization had it enabled. A crafted request, or a QR page left open while an admin switched a module off, created a ticket in a module the organization does not have — rung to its electricians and supervisors, but outside every module-scoped list. POST /api/tickets already refused this for staff (403).',
  module: 'complaints',
  category: 'public-complaint',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Bug hunt 2026-10-20 (authorization: disabled module)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-20',
  rootCause: 'public.js validated `VALID_MODULES.includes(mod)` only; the location lookup did not load the organization\'s enabledModules.',
  expectedBehavior: 'A complaint for a module the organization has not enabled answers 400 and creates nothing; enabled modules work as before.',
  brokenBehavior: '200 and a ticket in the disabled module.',
  reproductionSteps: [
    'Create an org with enabledModules ["ele"] and a location.',
    'As a guest, POST /api/public/complaint { locationId, module: "civil", issueType: "PLUMBING_LEAK" }.',
    'Broken: 200 and a civil ticket. Fixed: 400 and no ticket.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/authz-sweep.test.js',

  async apply() {
    const org = await createTestOrg({ enabledModules: ['ele'] });
    const location = await createTestLocation(org.id);
    return { org, location };
  },

  async validate(ctx) {
    const { org, location } = ctx['BUG-0020'];
    const res = await ctx.app.inject({ method: 'POST', url: '/api/public/complaint', headers: { 'x-forwarded-for': '10.94.0.20' }, payload: { locationId: location.id, module: 'civil', issueType: 'PLUMBING_LEAK' } });
    const tickets = await ctx.prisma.ticket.count({ where: { orgId: org.id } });
    if (res.statusCode !== 400 || tickets !== 0) return { ok: false, detail: `expected 400 and no ticket, got ${res.statusCode} and ${tickets} ticket(s)` };
    return { ok: true, detail: 'refused with 400; no ticket in the disabled module' };
  }
};
