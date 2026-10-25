'use strict';

const jwt = require('jsonwebtoken');
const { prisma } = require('../lib/prisma');
const { getFromR2 } = require('../lib/r2');
const { JWT_VERIFY_OPTIONS } = require('../lib/security');

const issuedBefore = (decoded, invalidBefore) =>
  Boolean(invalidBefore && decoded.iat && decoded.iat < Math.floor(invalidBefore.getTime() / 1000));

async function orgIsActive(orgId) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } });
  return Boolean(org && org.status === 'ACTIVE');
}

/**
 * Resolve the ?token= to a reader, with the same checks as the header-based auth paths
 * (middleware/auth.js for staff, worker-auth.js for workers). Returns
 * { orgId, anyOrg } or { code, error } to send. [F15]
 */
async function resolveReader(token) {
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS); } catch { return { code: 401, error: 'Unauthorized' }; }

  if (decoded.userId) {
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, orgId: true, role: true, isActive: true, tokenInvalidBefore: true }
    });
    if (!user || !user.isActive) return { code: 401, error: 'Unauthorized' };
    if (issuedBefore(decoded, user.tokenInvalidBefore)) return { code: 401, error: 'Session expired. Please log in again.' };
    if (user.role === 'SUPER_ADMIN') return { anyOrg: true };
    if (!user.orgId || !(await orgIsActive(user.orgId))) return { code: 403, error: 'Organization is not active' };
    return { orgId: user.orgId };
  }

  if (decoded.workerId) {
    const worker = await prisma.worker.findUnique({
      where: { id: decoded.workerId },
      select: { id: true, orgId: true, isActive: true, tokenInvalidBefore: true }
    });
    if (!worker || !worker.isActive) return { code: 401, error: 'Unauthorized' };
    if (issuedBefore(decoded, worker.tokenInvalidBefore)) return { code: 401, error: 'Session expired. Please log in again.' };
    if (!(await orgIsActive(worker.orgId))) return { code: 403, error: 'Organization is not active' };
    return { orgId: worker.orgId };
  }

  // Neither a staff nor a worker token: refuse before any query.
  return { code: 401, error: 'Unauthorized' };
}

async function imageRoutes(fastify, opts) {
  // Private image proxy — serves R2 images through the API
  // Auth via query param ?token=JWT (since <img> tags can't send headers).
  // Staff tokens (userId) and worker tokens (workerId) are both accepted. [F15]
  fastify.get('/images/*', async (request, reply) => {
    const token = request.query.token;
    if (!token) return reply.code(401).send({ error: 'Unauthorized' });

    const reader = await resolveReader(token);
    if (reader.code) return reply.code(reader.code).send({ error: reader.error });

    const key = request.params['*'];

    // Security: block path traversal and validate key format
    if (!key || key.includes('..') || !key.startsWith('uploads/')) {
      return reply.code(404).send({ error: 'Not found' });
    }

    // Org-scoped access: key format is uploads/{orgId}/filename. SUPER_ADMIN can read
    // any org's images; everyone else only their own org's. Another org's key answers
    // 404, not 403, so its existence is not disclosed (tenant contract, Charter §6.1).
    const parts = key.split('/');
    if (parts.length < 3) return reply.code(404).send({ error: 'Not found' });
    if (!reader.anyOrg && parts[1] !== reader.orgId) {
      return reply.code(404).send({ error: 'Not found' });
    }

    try {
      const response = await getFromR2(key);
      reply.header('Content-Type', response.ContentType || 'image/webp');
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(response.Body);
    } catch (err) {
      if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
        return reply.code(404).send({ error: 'Image not found' });
      }
      throw err;
    }
  });
}

module.exports = imageRoutes;
