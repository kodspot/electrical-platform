'use strict';

/**
 * BUG-0050 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const {
  createTestOrg, createTestLocation, createTestTicket, createTestWorker, createTestWorkerAssignment
} = require('../factories');
const { getAssignedWorkerIds } = require('../../src/services/assignment-resolver');

module.exports = {
  id: 'BUG-0050',
  title: 'An electrician was rung for a ticket under a deactivated location that their app would not open',
  description: 'A location can be deactivated while its children stay active (DELETE /locations/:id?force=true), and those children still take complaints. getAssignedWorkerIds walked UP through the inactive location and rang the electrician covering the building, but getLocationDescendants — the electrician app\'s coverage — walked DOWN only through active locations, so the app answered 404. Found by the 2026-10 product and architecture review (PAR-10/50).',
  module: 'ele',
  category: 'worker-workflow',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Product and architecture review 2026-10 (PAR-10/50)',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-10-25',
  rootCause: 'The descendant walk filtered "isActive" = true; the ancestor walk did not.',
  expectedBehavior: 'The electrician a ticket rings can open it: both walks follow the same tree, through deactivated locations.',
  brokenBehavior: 'GET /api/worker/tickets/:id answered 404 for a ticket the electrician was notified about.',
  reproductionSteps: [
    'Building ← Floor ← Room; an electrician assigned to the building with coverChildren.',
    'Deactivate the floor with force=true; raise a complaint in the room.',
    'Open the ticket in the electrician app. Broken: 404. Fixed: 200.'
  ],
  scenarioDependencies: [],
  regressionTest: 'test/integration/worker-coverage-inactive.test.js',

  async apply() {
    const org = await createTestOrg();
    const building = await createTestLocation(org.id, { type: 'BUILDING' });
    const floor = await createTestLocation(org.id, { type: 'FLOOR', parentId: building.id, isActive: false });
    const room = await createTestLocation(org.id, { type: 'ROOM', parentId: floor.id });
    const worker = await createTestWorker(org.id, { pin: '505050' });
    await createTestWorkerAssignment(org.id, worker.id, building.id, { coverChildren: true });
    const ticket = await createTestTicket(org.id, room.id);
    return { org, room, worker, ticket };
  },

  async validate(ctx) {
    const { org, room, worker, ticket } = ctx['BUG-0050'];
    const ring = await getAssignedWorkerIds(room.id, org.id);
    if (!ring.includes(worker.id)) return { ok: false, detail: 'the ring no longer reaches the building\'s electrician (update this scenario)' };
    const login = await ctx.app.inject({ method: 'POST', url: '/api/auth/worker-login', headers: { 'x-forwarded-for': '10.88.50.250' }, payload: { orgSlug: org.slug, employeeId: worker.employeeId, pin: worker.plaintextPin } });
    if (login.statusCode !== 200) return { ok: false, detail: `worker login answered ${login.statusCode}` };
    const res = await ctx.app.inject({ method: 'GET', url: `/api/worker/tickets/${ticket.id}`, headers: { authorization: `Bearer ${login.json().token}` } });
    if (res.statusCode !== 200) return { ok: false, detail: `the electrician it rings got ${res.statusCode} for the ticket` };
    return { ok: true, detail: 'the electrician a ticket rings can open it' };
  }
};
