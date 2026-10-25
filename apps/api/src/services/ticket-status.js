'use strict';

const TICKET_STATUSES = Object.freeze({
  OPEN: 'OPEN',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
  RESOLVED_PENDING_VERIFY: 'RESOLVED_PENDING_VERIFY',
  RESOLVED: 'RESOLVED',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED'
});

const OPEN_TICKET_STATUSES = Object.freeze([
  TICKET_STATUSES.OPEN,
  TICKET_STATUSES.ACKNOWLEDGED,
  TICKET_STATUSES.ASSIGNED
]);

const ACTIVE_TICKET_STATUSES = Object.freeze([
  ...OPEN_TICKET_STATUSES,
  TICKET_STATUSES.IN_PROGRESS,
  TICKET_STATUSES.ON_HOLD
]);

const VERIFY_PENDING_TICKET_STATUSES = Object.freeze([
  TICKET_STATUSES.RESOLVED_PENDING_VERIFY
]);

const DONE_TICKET_STATUSES = Object.freeze([
  TICKET_STATUSES.RESOLVED,
  TICKET_STATUSES.CANCELLED,
  TICKET_STATUSES.CLOSED
]);

const EDITABLE_TICKET_STATUSES = Object.freeze([
  TICKET_STATUSES.OPEN,
  TICKET_STATUSES.ACKNOWLEDGED,
  TICKET_STATUSES.ASSIGNED,
  TICKET_STATUSES.IN_PROGRESS,
  TICKET_STATUSES.ON_HOLD,
  TICKET_STATUSES.RESOLVED_PENDING_VERIFY,
  TICKET_STATUSES.RESOLVED,
  TICKET_STATUSES.CANCELLED,
  TICKET_STATUSES.CLOSED
]);

function isOpenLikeStatus(status) {
  return OPEN_TICKET_STATUSES.includes(status);
}

function isActiveLikeStatus(status) {
  return ACTIVE_TICKET_STATUSES.includes(status);
}

const STALE_TICKET_ERROR = 'This ticket was changed by someone else just now. Reload it and try again.';

/**
 * Compare-and-set for ticket transitions: the update applies only if the ticket's status is
 * still the one the route read and checked (plus any extra `where` conditions; a route may
 * widen `status` to the set it accepts). When two people act on one ticket at once — verify
 * vs reject, a double verify, two supervisors' pickups — only one write lands; the other gets
 * null and answers 409 STALE_TICKET_ERROR. Before, every request "succeeded" and the last
 * write won. [BUG-0038]
 */
async function updateTicketIfUnchanged(client, ticket, args) {
  try {
    return await client.ticket.update({ ...args, where: { status: ticket.status, ...(args.where || {}), id: ticket.id } });
  } catch (err) {
    if (err && err.code === 'P2025') return null; // the status (or a condition) no longer matches
    throw err;
  }
}

module.exports = {
  TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  ACTIVE_TICKET_STATUSES,
  VERIFY_PENDING_TICKET_STATUSES,
  DONE_TICKET_STATUSES,
  EDITABLE_TICKET_STATUSES,
  isOpenLikeStatus,
  isActiveLikeStatus,
  STALE_TICKET_ERROR,
  updateTicketIfUnchanged
};
