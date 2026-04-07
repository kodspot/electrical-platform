'use strict';

/**
 * SSE (Server-Sent Events) real-time notification push service.
 *
 * Manages in-memory connections keyed by (orgId, userId/workerId).
 * When a notification is created, call broadcast() to push instantly.
 */

// Map<orgId, Map<recipientKey, Set<response>>>
// recipientKey = "user:<userId>" or "worker:<workerId>"
const connections = new Map();

/**
 * Register an SSE connection for a user or worker.
 * @param {string} orgId
 * @param {'user'|'worker'} recipientType
 * @param {string} recipientId
 * @param {object} reply - Fastify raw reply (for SSE streaming)
 */
function addConnection(orgId, recipientType, recipientId, reply) {
  if (!connections.has(orgId)) connections.set(orgId, new Map());
  const orgMap = connections.get(orgId);
  const key = `${recipientType}:${recipientId}`;
  if (!orgMap.has(key)) orgMap.set(key, new Set());
  orgMap.get(key).add(reply);
}

/**
 * Remove an SSE connection.
 */
function removeConnection(orgId, recipientType, recipientId, reply) {
  const orgMap = connections.get(orgId);
  if (!orgMap) return;
  const key = `${recipientType}:${recipientId}`;
  const set = orgMap.get(key);
  if (!set) return;
  set.delete(reply);
  if (set.size === 0) orgMap.delete(key);
  if (orgMap.size === 0) connections.delete(orgId);
}

/**
 * Send an SSE event to a specific recipient.
 * @param {string} orgId
 * @param {'user'|'worker'} recipientType
 * @param {string} recipientId
 * @param {string} event - SSE event name
 * @param {object} data - JSON payload
 */
function sendToRecipient(orgId, recipientType, recipientId, event, data) {
  const orgMap = connections.get(orgId);
  if (!orgMap) return;
  const key = `${recipientType}:${recipientId}`;
  const set = orgMap.get(key);
  if (!set || set.size === 0) return;

  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const reply of set) {
    try {
      reply.raw.write(msg);
    } catch {
      set.delete(reply);
    }
  }
}

/**
 * Broadcast to all connected users of a role in an org.
 * @param {string} orgId
 * @param {string} event
 * @param {object} data
 */
function broadcastToOrg(orgId, event, data) {
  const orgMap = connections.get(orgId);
  if (!orgMap) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [, set] of orgMap) {
    for (const reply of set) {
      try {
        reply.raw.write(msg);
      } catch {
        set.delete(reply);
      }
    }
  }
}

/**
 * Push a notification event to the correct recipients.
 * Called after createNotification / notifyAdmins / notifySupervisors.
 */
function pushNotification(orgId, notification) {
  if (notification.userId) {
    sendToRecipient(orgId, 'user', notification.userId, 'notification', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      entityId: notification.entityId,
      createdAt: notification.createdAt
    });
  }
  if (notification.workerId) {
    sendToRecipient(orgId, 'worker', notification.workerId, 'notification', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      entityId: notification.entityId,
      createdAt: notification.createdAt
    });
  }
}

/**
 * Push an alert event to all connected admins of an org.
 */
function pushAlert(orgId, alert) {
  broadcastToOrg(orgId, 'alert', {
    id: alert.id,
    trigger: alert.trigger,
    severity: alert.severity,
    title: alert.title,
    body: alert.body,
    escalationLevel: alert.escalationLevel || 0,
    createdAt: alert.createdAt
  });
}

/**
 * Get connection stats (for health monitoring).
 */
function getConnectionStats() {
  let totalOrgs = 0;
  let totalConnections = 0;
  for (const [, orgMap] of connections) {
    totalOrgs++;
    for (const [, set] of orgMap) {
      totalConnections += set.size;
    }
  }
  return { totalOrgs, totalConnections };
}

module.exports = {
  addConnection,
  removeConnection,
  sendToRecipient,
  broadcastToOrg,
  pushNotification,
  pushAlert,
  getConnectionStats
};
