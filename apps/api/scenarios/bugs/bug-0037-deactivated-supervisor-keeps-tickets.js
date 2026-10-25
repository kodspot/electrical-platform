'use strict';

/**
 * BUG-0037 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const { createTestOrg, createTestUser, createTestLocation, createTestTicket, createTestSupervisorAssignment } = require('../factories');

module.exports = {
  id: 'BUG-0037',
  title: 'A deactivated (or moved) supervisor kept their open tickets, where no one else could see them',
  description: 'Deactivating a supervisor (PATCH /api/supervisors/:id, DELETE /api/supervisors/:id, or the super-admin user edit) left their open tickets assigned to them. Other supervisors only see tickets assigned to themselves or unassigned, and only the assigned supervisor or an admin may verify, so the work stranded. A super-admin moving the user to another org also left the tickets — and the user\'s coverage, so new complaints kept going to someone in another org. Found by the 2026-10 product and architecture review (PAR-10/09).',
  module: 'ele',
  category: 'supervisor-workflow',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/09)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The deactivation paths only flipped isActive; nothing re-ran the assignment rule for the tickets they held.',
  expectedBehavior: 'Each open ticket goes to the nearest active supervisor covering its location, else back to the pool; audited, and the new assignee is notified. A move also drops the old org\'s coverage.',
  brokenBehavior: 'The open ticket stayed assigned to the deactivated supervisor.',
  reproductionSteps: [
    'Give a supervisor an OPEN ticket at a location another supervisor also covers.',
    'Deactivate the first supervisor as the org admin.',
    'Broken: the ticket is still theirs. Fixed: it belongs to the other supervisor.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/supervisor-handover.test.js',

  async apply() {
    const org = await createTestOrg();
    const admin = await createTestUser(org.id, { role: 'ADMIN' });
    const location = await createTestLocation(org.id);
    const leaving = await createTestUser(org.id, { role: 'SUPERVISOR' });
    const staying = await createTestUser(org.id, { role: 'SUPERVISOR' });
    await createTestSupervisorAssignment(org.id, leaving.id, location.id);
    await createTestSupervisorAssignment(org.id, staying.id, location.id);
    const ticket = await createTestTicket(org.id, location.id, { status: 'OPEN', assignedToId: leaving.id });
    return { org, admin, leaving, staying, ticket };
  },

  async validate(ctx) {
    const { admin, leaving, staying, ticket } = ctx['BUG-0037'];
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-forwarded-for': '10.94.0.37' }, payload: { email: admin.email, password: admin.plaintextPassword } });
    if (login.statusCode !== 200) return { ok: false, detail: `admin login expected 200, got ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'PATCH', url: `/api/supervisors/${leaving.id}`, headers: { authorization: `Bearer ${login.json().token}` }, payload: { isActive: false } });
    if (res.statusCode !== 200) return { ok: false, detail: `deactivate answered ${res.statusCode}` };
    const now = await ctx.prisma.ticket.findUnique({ where: { id: ticket.id }, select: { assignedToId: true } });
    if (now.assignedToId !== staying.id) return { ok: false, detail: `the ticket is assigned to ${now.assignedToId === leaving.id ? 'the deactivated supervisor' : now.assignedToId}` };
    return { ok: true, detail: 'the open ticket went to the supervisor still covering the location' };
  }
};
