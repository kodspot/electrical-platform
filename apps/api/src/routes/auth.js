'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { z } = require('zod');
const { prisma } = require('../lib/prisma');
const { BCRYPT_COST, passwordSchema, hashResetToken } = require('../lib/security');
const { strictRateLimit, loginRateLimit } = require('../middleware/rateLimits');
const { authenticateJWT, requirePolicy } = require('../middleware/auth');
const { APP_URL } = require('../config/env');
const { normalizeEnabledModules, isModuleEnabled } = require('../services/module-policy');
const { sendEmail, escHtml } = require('../lib/email');

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Anti-enumeration: a forgot-password request takes the same time whether or
// not the email/org combination matches an account, so a caller can't infer
// existence from response latency (matches the jitter already used on
// invalid-credential paths in /auth/login below).
async function antiEnumerationDelay() {
  await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
}

// Constant-time comparison that doesn't leak input length
function safeCompareKeys(input, secret) {
  const hash = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(hash(input), hash(secret));
}

async function authRoutes(fastify, opts) {

  // Bootstrap: Create first SUPER_ADMIN (one-time, admin key only — no email/password needed)
  fastify.post('/auth/bootstrap', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      adminKey: z.string().min(1)
    });

    const { adminKey } = schema.parse(request.body);

    if (!process.env.ADMIN_KEY || !safeCompareKeys(adminKey, process.env.ADMIN_KEY)) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(403).send({ error: 'Invalid admin key' });
    }

    // Only allow if no SUPER_ADMIN exists yet
    const existing = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
    if (existing) {
      return reply.code(409).send({ error: 'SuperAdmin already exists. Use /auth/login instead.' });
    }

    // Internal values — login is always done via admin key, not email/password
    const internalEmail = 'superadmin@internal.kodspot';
    const passwordHash = await bcrypt.hash(adminKey, BCRYPT_COST);

    const user = await prisma.user.create({
      data: {
        name: 'Super Admin',
        email: internalEmail,
        passwordHash,
        role: 'SUPER_ADMIN',
        orgId: null
      }
    });

    const token = jwt.sign(
      { userId: user.id, orgId: null, role: 'SUPER_ADMIN' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  // Login: email + password → JWT (also supports ADMIN_KEY-only for SuperAdmin)
  fastify.post('/auth/login', {
    config: { rateLimit: loginRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      email: z.string().email().max(200).optional(),
      password: z.string().min(1).max(100).optional(),
      orgId: z.string().uuid().optional(),
      orgSlug: z.string().max(50).optional(),
      adminKey: z.string().min(1).optional()
    });

    const { email, password, orgId, orgSlug, adminKey } = schema.parse(request.body);

    // ADMIN_KEY-only login for SuperAdmin
    if (adminKey) {
      if (!process.env.ADMIN_KEY || !safeCompareKeys(adminKey, process.env.ADMIN_KEY)) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return reply.code(401).send({ error: 'Invalid admin key' });
      }
      const superAdmin = await prisma.user.findFirst({
        where: { role: 'SUPER_ADMIN', isActive: true },
        select: { id: true, orgId: true, role: true, name: true, email: true }
      });
      if (!superAdmin) return reply.code(404).send({ error: 'No SuperAdmin account exists. Use /auth/bootstrap first.' });

      const token = jwt.sign(
        { userId: superAdmin.id, orgId: null, role: 'SUPER_ADMIN' },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );
      return { token, user: { id: superAdmin.id, name: superAdmin.name, email: superAdmin.email, role: superAdmin.role, orgId: null } };
    }

    // Normal email+password login
    if (!email || !password) return reply.code(400).send({ error: 'Email and password are required' });
    const normalizedEmail = email.toLowerCase().trim();

    const users = await prisma.user.findMany({
      where: { email: normalizedEmail, isActive: true },
      select: { id: true, orgId: true, role: true, name: true, email: true, passwordHash: true }
    });

    if (users.length === 0) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Single match or caller specified orgId/orgSlug
    let user;
    if (users.length === 1) {
      user = users[0];
    } else {
      // Resolve orgSlug to orgId if provided
      let resolvedOrgId = orgId;
      if (!resolvedOrgId && orgSlug) {
        const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
        if (org) resolvedOrgId = org.id;
      }
      if (!resolvedOrgId) {
        return reply.code(400).send({
          error: 'Multiple accounts found. Please specify organization.',
          organizations: users.map(u => ({ orgId: u.orgId, role: u.role }))
        });
      }
      user = users.find(u => u.orgId === resolvedOrgId);
      if (!user) {
        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    // Check org status for non-superadmin
    let orgSlugValue = null;
    let orgNameValue = null;
    let enabledModules = normalizeEnabledModules();
    if (user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { status: true, slug: true, name: true, enabledModules: true }
      });
      if (!org || org.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'Organization is not active' });
      }
      orgSlugValue = org.slug;
      orgNameValue = org.name;
      enabledModules = normalizeEnabledModules(org.enabledModules);
    }

    const token = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.orgId, orgSlug: orgSlugValue, orgName: orgNameValue, enabledModules }
    };
  });

  // Get current user profile
  fastify.get('/auth/me', {
    preHandler: [authenticateJWT]
  }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true, name: true, email: true, phone: true, role: true, orgId: true,
        isActive: true, createdAt: true,
        org: { select: { id: true, name: true, type: true, slug: true, enabledModules: true } }
      }
    });
    if (!user) return reply.code(404).send({ error: 'User not found' });
    return user;
  });

  // Change own password
  fastify.patch('/auth/password', {
    preHandler: [authenticateJWT]
  }, async (request, reply) => {
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: passwordSchema
    });

    const { currentPassword, newPassword } = schema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { passwordHash: true }
    });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      return reply.code(400).send({ error: 'Current password is incorrect' });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    await prisma.user.update({
      where: { id: request.user.id },
      data: { passwordHash, tokenInvalidBefore: new Date() }
    });

    // Issue a fresh token so the current session stays alive
    const newToken = jwt.sign(
      { userId: request.user.id, orgId: request.user.orgId, role: request.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return { success: true, message: 'Password updated', token: newToken };
  });

  // Request a self-service password reset. Always returns the same generic
  // response regardless of whether the email/org matches an account, how
  // many accounts share the email, or which orgs it belongs to — the
  // response body and timing must never let a caller distinguish these
  // cases. [WP14]
  fastify.post('/auth/forgot-password', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      email: z.string().email().max(200),
      orgId: z.string().uuid().optional(),
      orgSlug: z.string().max(50).optional()
    });

    const { email, orgId, orgSlug } = schema.parse(request.body);
    const normalizedEmail = email.toLowerCase().trim();

    const genericResponse = { success: true, message: 'If an account exists for this email, a password reset link has been sent.' };

    let resolvedOrgId = orgId;
    if (!resolvedOrgId && orgSlug) {
      const org = await prisma.organization.findUnique({ where: { slug: orgSlug }, select: { id: true } });
      if (org) resolvedOrgId = org.id;
    }

    const where = resolvedOrgId
      ? { email: normalizedEmail, orgId: resolvedOrgId, isActive: true }
      : { email: normalizedEmail, isActive: true };

    // No orgId/orgSlug filter given and the email is shared across orgs?
    // Reset all matching accounts rather than asking the caller to
    // disambiguate — unlike /auth/login, revealing "these are your orgs"
    // before any credential has been proven is itself an enumeration leak.
    const users = await prisma.user.findMany({ where, select: { id: true, name: true } });

    for (const user of users) {
      const token = crypto.randomBytes(32).toString('hex');
      const resetTokenExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      // Only the hash is stored; the e-mailed token is the credential. [BUG-0034]
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken: hashResetToken(token), resetTokenExpiresAt }
      });

      const resetUrl = `${APP_URL}/reset-password?token=${token}`;
      sendEmail(
        normalizedEmail,
        'Reset your password',
        `<p>Hi ${escHtml(user.name)},</p>
         <p>We received a request to reset your password. This link is valid for 1 hour and can only be used once.</p>
         <p><a class="btn" href="${resetUrl}">Reset Password</a></p>
         <p>If you didn't request this, you can safely ignore this email — your password won't be changed.</p>`
      ).catch(() => {});
    }

    await antiEnumerationDelay();
    return genericResponse;
  });

  // Complete a self-service password reset. [WP14]
  fastify.post('/auth/reset-password', {
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const schema = z.object({
      token: z.string().min(1),
      newPassword: passwordSchema
    });

    const { token, newPassword } = schema.parse(request.body);

    const user = await prisma.user.findUnique({
      where: { resetToken: hashResetToken(token) },
      select: { id: true, orgId: true, role: true, name: true, email: true, isActive: true, resetTokenExpiresAt: true }
    });

    if (!user || !user.isActive || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
      await antiEnumerationDelay();
      return reply.code(400).send({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }

    let orgSlugValue = null, orgNameValue = null;
    let enabledModules = normalizeEnabledModules();
    if (user.orgId) {
      const org = await prisma.organization.findUnique({
        where: { id: user.orgId },
        select: { status: true, slug: true, name: true, enabledModules: true }
      });
      if (!org || org.status !== 'ACTIVE') {
        return reply.code(403).send({ error: 'Organization is not active' });
      }
      orgSlugValue = org.slug;
      orgNameValue = org.name;
      enabledModules = normalizeEnabledModules(org.enabledModules);
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // Single-use: the token is cleared in the same write that consumes it —
    // a second request with the same token will find no matching user.
    // Session invalidation: tokenInvalidBefore rejects every token issued
    // before this moment, so a leaked pre-reset session can't survive this.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        tokenInvalidBefore: new Date(),
        resetToken: null,
        resetTokenExpiresAt: null
      }
    });

    const newToken = jwt.sign(
      { userId: user.id, orgId: user.orgId, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    return {
      success: true,
      message: 'Password reset successfully',
      token: newToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, orgId: user.orgId, orgSlug: orgSlugValue, orgName: orgNameValue, enabledModules }
    };
  });

  // DPDP Act Sec 6 — Data portability: export all personal data for the current user
  fastify.get('/auth/export', {
    preHandler: [authenticateJWT],
    config: { rateLimit: strictRateLimit }
  }, async (request, reply) => {
    const userId = request.user.id;
    const orgId = request.user.orgId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        designation: true, employeeId: true, department: true, gender: true,
        dateOfBirth: true, dateOfJoin: true, address: true, notes: true,
        isActive: true, createdAt: true, updatedAt: true,
        org: { select: { name: true, type: true } }
      }
    });

    const inspections = orgId ? await prisma.electricalInspection.findMany({
      where: { supervisorId: userId },
      select: { id: true, shift: true, notes: true, status: true, inspectedAt: true, createdAt: true,
        location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    const tickets = orgId ? await prisma.ticket.findMany({
      where: { OR: [{ createdById: userId }, { assignedToId: userId }] },
      select: { id: true, title: true, description: true, status: true, priority: true, source: true,
        createdAt: true, resolvedAt: true, location: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    const auditLogs = orgId ? await prisma.auditLog.findMany({
      where: { actorId: userId },
      select: { id: true, action: true, entityType: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500
    }) : [];

    reply.header('content-disposition', 'attachment; filename="kodspot-data-export.json"');
    return {
      exportedAt: new Date().toISOString(),
      platform: 'Kodspot Electrical',
      user,
      inspections,
      tickets,
      auditLogs
    };
  });

  // === Login QR Code Generator (for admin panel) ===
  const VALID_MODULES_QR = ['ele', 'civil', 'asset', 'complaints'];
  const VALID_ROLES_QR = ['admin', 'supervisor'];

  fastify.get('/auth/login-qr', {
    preHandler: [authenticateJWT, requirePolicy('ORG_ADMIN')]
  }, async (request, reply) => {
    const { mod, role } = request.query;

    if (!mod || VALID_MODULES_QR.indexOf(mod) === -1) {
      return reply.code(400).send({ error: 'Invalid module' });
    }
    if (!role || VALID_ROLES_QR.indexOf(role) === -1) {
      return reply.code(400).send({ error: 'Invalid role' });
    }

    const org = await prisma.organization.findUnique({
      where: { id: request.user.orgId },
      select: { slug: true, enabledModules: true }
    });
    if (!org || !org.slug) return reply.code(400).send({ error: 'Organization not configured' });

    if (!isModuleEnabled(org, mod)) {
      return reply.code(400).send({ error: 'Module not enabled' });
    }

    const loginPage = role === 'admin' ? 'admin-login' : 'supervisor-login';
    const qrData = `${APP_URL}/${org.slug}/${mod}/${loginPage}`;

    const svg = await QRCode.toString(qrData, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 512,
      color: { dark: '#1e293b', light: '#ffffff' }
    });

    reply.header('Content-Type', 'image/svg+xml');
    reply.header('Cache-Control', 'public, max-age=3600');
    return svg;
  });
}

module.exports = authRoutes;
