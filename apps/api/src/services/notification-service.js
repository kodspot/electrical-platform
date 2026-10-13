'use strict';

const { prisma } = require('../lib/prisma');
const { pushNotification } = require('./sse');
const { sendEmail, emailAdmins } = require('../lib/email');

/**
 * Create a notification for a user or worker.
 */
async function createNotification({ orgId, userId, workerId, type, title, body, entityId, isUrgent }) {
  const notif = await prisma.notification.create({
    data: {
      orgId,
      userId: userId || null,
      workerId: workerId || null,
      type,
      title,
      body: body || null,
      entityId: entityId || null,
      isUrgent: !!isUrgent
    }
  });

  // Push via SSE in real-time.
  try { pushNotification(orgId, notif); } catch { /* silent */ }
  return notif;
}

/**
 * Notify all active admins of an org.
 */
async function notifyAdmins(orgId, { type, title, body, entityId, isUrgent }) {
  const admins = await prisma.user.findMany({
    where: { orgId, role: 'ADMIN', isActive: true },
    select: { id: true }
  });

  if (!admins.length) return;

  const rows = admins.map(a => ({
    orgId,
    userId: a.id,
    type,
    title,
    body: body || null,
    entityId: entityId || null,
    isUrgent: !!isUrgent
  }));

  await prisma.notification.createMany({ data: rows });

  // Push SSE to each admin.
  for (const a of admins) {
    try {
      pushNotification(orgId, {
        userId: a.id,
        type,
        title,
        body,
        entityId,
        isUrgent: !!isUrgent,
        createdAt: new Date()
      });
    } catch { /* silent */ }
  }
}

/**
 * Notify all active supervisors of an org.
 *
 * `excludeUserIds` (optional) skips supervisors a caller has already notified more
 * specifically — e.g. a public complaint's assigned supervisors, who get their own
 * "assigned" notification and must not get the broadcast as a second one. [WP-H F3]
 */
async function notifySupervisors(orgId, { type, title, body, entityId, isUrgent }, { excludeUserIds = [] } = {}) {
  const supervisors = await prisma.user.findMany({
    where: {
      orgId,
      role: 'SUPERVISOR',
      isActive: true,
      ...(excludeUserIds.length ? { id: { notIn: excludeUserIds } } : {})
    },
    select: { id: true }
  });

  if (!supervisors.length) return;

  const rows = supervisors.map(s => ({
    orgId,
    userId: s.id,
    type,
    title,
    body: body || null,
    entityId: entityId || null,
    isUrgent: !!isUrgent
  }));

  await prisma.notification.createMany({ data: rows });

  // Push SSE to each supervisor.
  for (const s of supervisors) {
    try {
      pushNotification(orgId, {
        userId: s.id,
        type,
        title,
        body,
        entityId,
        isUrgent: !!isUrgent,
        createdAt: new Date()
      });
    } catch { /* silent */ }
  }
}

/**
 * Notify specific supervisors (as opposed to notifySupervisors, which
 * notifies every active supervisor in the org). Mirrors notifyWorkers below —
 * a single batched createMany instead of one insert per supervisor. [WP11]
 */
async function notifySupervisorIds(orgId, supervisorIds, { type, title, body, entityId, isUrgent }) {
  if (!supervisorIds || !supervisorIds.length) return;

  const rows = supervisorIds.map(sid => ({
    orgId,
    userId: sid,
    type,
    title,
    body: body || null,
    entityId: entityId || null,
    isUrgent: !!isUrgent
  }));

  await prisma.notification.createMany({ data: rows });

  for (const sid of supervisorIds) {
    try {
      pushNotification(orgId, {
        userId: sid,
        type,
        title,
        body,
        entityId,
        isUrgent: !!isUrgent,
        createdAt: new Date()
      });
    } catch { /* silent */ }
  }
}

/**
 * Notify specific workers.
 */
async function notifyWorkers(orgId, workerIds, { type, title, body, entityId, isUrgent }) {
  if (!workerIds || !workerIds.length) return;

  const rows = workerIds.map(wid => ({
    orgId,
    workerId: wid,
    type,
    title,
    body: body || null,
    entityId: entityId || null,
    isUrgent: !!isUrgent
  }));

  await prisma.notification.createMany({ data: rows });

  // Push SSE to each worker.
  for (const wid of workerIds) {
    try {
      pushNotification(orgId, {
        workerId: wid,
        type,
        title,
        body,
        entityId,
        isUrgent: !!isUrgent,
        createdAt: new Date()
      });
    } catch { /* silent */ }
  }
}

/**
 * Audience dispatch table for notify() below (WP15). Each key is a property
 * route handlers set on notify()'s `to` argument (e.g. `{ userId }` or
 * `{ admins: true }`); the value is the existing in-app/SSE function that
 * already handles it. Adding a new notification audience is a single
 * addition to this table — no route handler needs to change to gain it.
 */
const NOTIFY_CHANNELS = {
  userId: (orgId, to, payload) => createNotification({ orgId, userId: to.userId, ...payload }),
  workerId: (orgId, to, payload) => createNotification({ orgId, workerId: to.workerId, ...payload }),
  admins: (orgId, _to, payload) => notifyAdmins(orgId, payload),
  supervisors: (orgId, _to, payload) => notifySupervisors(orgId, payload),
  supervisorIds: (orgId, to, payload) => notifySupervisorIds(orgId, to.supervisorIds, payload),
  workerIds: (orgId, to, payload) => notifyWorkers(orgId, to.workerIds, payload)
};

/**
 * Single shared entry point for triggering a notification and, optionally,
 * its paired email — replacing the independently-paired notify+email calls
 * previously scattered across route handlers (`tickets.js`, `public.js`).
 * [WP15]
 *
 * `to` selects the audience via exactly one of `NOTIFY_CHANNELS`'s keys
 * (e.g. `{ userId }`, `{ admins: true }`). `email`, if present, sends the
 * paired email through the existing `lib/email.js` helpers — `{ to, subject,
 * html }` for a single address, or `{ toAdmins: true, subject, html }` to
 * email every active admin — exactly as each call site did before, just
 * from one call instead of two. Both sides run concurrently and neither
 * throws (matching the pre-existing fire-and-forget convention at every
 * call site this replaces).
 */
async function notify({ orgId, to, type, title, body, entityId, isUrgent, email }) {
  const payload = { type, title, body, entityId, isUrgent };

  const channelKey = Object.keys(NOTIFY_CHANNELS).find((k) => to && to[k] !== undefined);
  const notifyPromise = channelKey
    ? NOTIFY_CHANNELS[channelKey](orgId, to, payload)
    : Promise.resolve();

  const emailPromise = !email ? Promise.resolve()
    : email.toAdmins ? emailAdmins(prisma, orgId, email.subject, email.html)
    : email.to ? sendEmail(email.to, email.subject, email.html)
    : Promise.resolve();

  const [notifyResult] = await Promise.all([
    notifyPromise.catch(() => {}),
    emailPromise.catch(() => {})
  ]);
  return notifyResult;
}

module.exports = {
  createNotification,
  notifyAdmins,
  notifySupervisors,
  notifySupervisorIds,
  notifyWorkers,
  notify,
  NOTIFY_CHANNELS
};
