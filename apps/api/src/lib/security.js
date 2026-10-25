'use strict';

const crypto = require('crypto');
const { z } = require('zod');

const BCRYPT_COST = 12;

const isProduction = process.env.NODE_ENV === 'production';

// Password strength: min 8 chars, uppercase, lowercase, digit
const passwordSchema = z.string().min(8).max(100)
  .refine(p => /[A-Z]/.test(p), { message: 'Password must contain at least one uppercase letter' })
  .refine(p => /[a-z]/.test(p), { message: 'Password must contain at least one lowercase letter' })
  .refine(p => /\d/.test(p), { message: 'Password must contain at least one number' });

const COOKIE_CONFIG = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? 'strict' : 'lax',
  maxAge: 86400000,
  path: '/'
};

if (isProduction && process.env.COOKIE_DOMAIN) {
  COOKIE_CONFIG.domain = process.env.COOKIE_DOMAIN;
}

// Hash the admin key for secure cookie comparison
function hashAdminKey(key) {
  return crypto.createHmac('sha256', process.env.COOKIE_SECRET).update(key).digest('hex');
}

// The Worker fields an org admin or super-admin may see: the profile, never credential
// material — the PIN hash, a pending reset token and its expiry, the session cut-off. [BUG-0031]
const WORKER_PROFILE_SELECT = Object.freeze({
  id: true, orgId: true, employeeId: true, name: true, phone: true, email: true, address: true,
  department: true, designation: true, dateOfBirth: true, dateOfJoin: true, gender: true,
  bloodGroup: true, aadharNo: true, notes: true, isActive: true, createdAt: true, updatedAt: true
});

module.exports = {
  BCRYPT_COST,
  COOKIE_CONFIG,
  hashAdminKey,
  passwordSchema,
  WORKER_PROFILE_SELECT
};
