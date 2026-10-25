'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  ACTIVE_TICKET_STATUSES,
  VERIFY_PENDING_TICKET_STATUSES,
  DONE_TICKET_STATUSES,
  EDITABLE_TICKET_STATUSES,
  isOpenLikeStatus,
  isActiveLikeStatus,
  updateTicketIfUnchanged
} = require('../src/services/ticket-status');

test('every OPEN_TICKET_STATUSES value is also in ACTIVE_TICKET_STATUSES', () => {
  for (const status of OPEN_TICKET_STATUSES) {
    assert(ACTIVE_TICKET_STATUSES.includes(status), `${status} missing from ACTIVE_TICKET_STATUSES`);
  }
});

test('ACTIVE_TICKET_STATUSES is exactly OPEN + IN_PROGRESS + ON_HOLD, no more, no less', () => {
  const expected = new Set([...OPEN_TICKET_STATUSES, TICKET_STATUSES.IN_PROGRESS, TICKET_STATUSES.ON_HOLD]);
  assert.strictEqual(ACTIVE_TICKET_STATUSES.length, expected.size, 'unexpected duplicate or extra entry');
  for (const status of ACTIVE_TICKET_STATUSES) {
    assert(expected.has(status), `${status} should not be in ACTIVE_TICKET_STATUSES`);
  }
});

test('every status in the enum is categorized into exactly one of ACTIVE, VERIFY_PENDING, or DONE', () => {
  const allStatuses = Object.values(TICKET_STATUSES);
  const groups = [ACTIVE_TICKET_STATUSES, VERIFY_PENDING_TICKET_STATUSES, DONE_TICKET_STATUSES];

  for (const status of allStatuses) {
    const membershipCount = groups.filter((group) => group.includes(status)).length;
    assert.strictEqual(
      membershipCount,
      1,
      `${status} must belong to exactly one lifecycle grouping (found in ${membershipCount})`
    );
  }

  // And the reverse: every grouped status must be a real enum value (catches typos)
  for (const group of groups) {
    for (const status of group) {
      assert(allStatuses.includes(status), `${status} in a grouping is not a real TICKET_STATUSES value`);
    }
  }
});

test('EDITABLE_TICKET_STATUSES currently covers every defined status (documents today\'s unrestricted admin PATCH behavior)', () => {
  const allStatuses = Object.values(TICKET_STATUSES);
  assert.strictEqual(EDITABLE_TICKET_STATUSES.length, allStatuses.length);
  for (const status of allStatuses) {
    assert(EDITABLE_TICKET_STATUSES.includes(status), `${status} missing from EDITABLE_TICKET_STATUSES`);
  }
});

test('isOpenLikeStatus is true only for OPEN/ACKNOWLEDGED/ASSIGNED', () => {
  assert.strictEqual(isOpenLikeStatus(TICKET_STATUSES.OPEN), true);
  assert.strictEqual(isOpenLikeStatus(TICKET_STATUSES.ACKNOWLEDGED), true);
  assert.strictEqual(isOpenLikeStatus(TICKET_STATUSES.ASSIGNED), true);
  assert.strictEqual(isOpenLikeStatus(TICKET_STATUSES.IN_PROGRESS), false);
  assert.strictEqual(isOpenLikeStatus(TICKET_STATUSES.RESOLVED), false);
  assert.strictEqual(isOpenLikeStatus('NOT_A_REAL_STATUS'), false);
});

test('isActiveLikeStatus is true for the full open+in-progress+on-hold set', () => {
  assert.strictEqual(isActiveLikeStatus(TICKET_STATUSES.OPEN), true);
  assert.strictEqual(isActiveLikeStatus(TICKET_STATUSES.IN_PROGRESS), true);
  assert.strictEqual(isActiveLikeStatus(TICKET_STATUSES.ON_HOLD), true);
  assert.strictEqual(isActiveLikeStatus(TICKET_STATUSES.RESOLVED_PENDING_VERIFY), false);
  assert.strictEqual(isActiveLikeStatus(TICKET_STATUSES.CLOSED), false);
});

// BUG-0038: transitions write only if the status is still the one they checked.
test('updateTicketIfUnchanged conditions the write on the status it read, lets a route widen it, and turns a miss into null', async () => {
  const calls = [];
  const client = { ticket: { update: async (args) => { calls.push(args); return { id: args.where.id }; } } };
  const ticket = { id: 't1', status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY };
  assert.deepStrictEqual(await updateTicketIfUnchanged(client, ticket, { data: { status: 'RESOLVED' } }), { id: 't1' });
  assert.deepStrictEqual(calls[0].where, { status: TICKET_STATUSES.RESOLVED_PENDING_VERIFY, id: 't1' });
  await updateTicketIfUnchanged(client, ticket, { where: { assignedToId: null, status: { in: ACTIVE_TICKET_STATUSES }, id: 'other' }, data: {} });
  assert.deepStrictEqual(calls[1].where, { status: { in: ACTIVE_TICKET_STATUSES }, assignedToId: null, id: 't1' }, 'the id is never overridden');
  const missing = { ticket: { update: async () => { const e = new Error('not found'); e.code = 'P2025'; throw e; } } };
  assert.strictEqual(await updateTicketIfUnchanged(missing, ticket, { data: {} }), null);
  const broken = { ticket: { update: async () => { throw new Error('connection lost'); } } };
  await assert.rejects(updateTicketIfUnchanged(broken, ticket, { data: {} }), /connection lost/, 'other errors still surface');
});
