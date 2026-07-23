'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret-for-unit-tests';

const { passwordSchema, hashAdminKey, COOKIE_CONFIG, BCRYPT_COST } = require('../src/lib/security');

test('passwordSchema accepts a password with upper, lower, digit, length 8-100', () => {
  const result = passwordSchema.safeParse('GoodPass1');
  assert.strictEqual(result.success, true);
});

test('passwordSchema rejects a password missing an uppercase letter', () => {
  const result = passwordSchema.safeParse('lowercase1');
  assert.strictEqual(result.success, false);
  assert.match(result.error.issues.map((i) => i.message).join(' '), /uppercase/i);
});

test('passwordSchema rejects a password missing a lowercase letter', () => {
  const result = passwordSchema.safeParse('UPPERCASE1');
  assert.strictEqual(result.success, false);
  assert.match(result.error.issues.map((i) => i.message).join(' '), /lowercase/i);
});

test('passwordSchema rejects a password missing a digit', () => {
  const result = passwordSchema.safeParse('NoDigitsHere');
  assert.strictEqual(result.success, false);
  assert.match(result.error.issues.map((i) => i.message).join(' '), /number/i);
});

test('passwordSchema rejects a password shorter than 8 characters', () => {
  const result = passwordSchema.safeParse('Ab1');
  assert.strictEqual(result.success, false);
});

test('passwordSchema rejects a password longer than 100 characters', () => {
  const tooLong = 'Aa1' + 'x'.repeat(98); // 101 chars
  const result = passwordSchema.safeParse(tooLong);
  assert.strictEqual(result.success, false);
});

test('hashAdminKey is deterministic for the same key and secret', () => {
  const a = hashAdminKey('my-admin-key');
  const b = hashAdminKey('my-admin-key');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, 'HMAC-SHA256 hex digest is 64 characters');
});

test('hashAdminKey produces different output for different input keys', () => {
  const a = hashAdminKey('key-one');
  const b = hashAdminKey('key-two');
  assert.notStrictEqual(a, b);
});

test('COOKIE_CONFIG always sets httpOnly and a root path regardless of environment', () => {
  assert.strictEqual(COOKIE_CONFIG.httpOnly, true);
  assert.strictEqual(COOKIE_CONFIG.path, '/');
  assert.strictEqual(typeof COOKIE_CONFIG.maxAge, 'number');
});

test('BCRYPT_COST is set to a production-appropriate value', () => {
  assert.strictEqual(BCRYPT_COST, 12);
});
