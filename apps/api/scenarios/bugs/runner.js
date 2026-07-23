'use strict';

/**
 * Bug-scenario runner. [platform-M4, DPS §6]
 *
 * Builds on the M3 scenario engine — it does NOT reimplement scenario execution. A bug
 * scenario's triggering state is produced by running its M3 scenario dependencies
 * (through the existing `engine.run`) and then its own `apply`. Validation reproduces the
 * bug against the real app (in-process `app.inject`) and asserts the fixed behavior holds.
 */

const engine = require('../index'); // the M3 scenario engine — reused, never duplicated
const { prisma } = require('../../src/lib/prisma');

// The app is built once, lazily, via the same assembly production uses. Lazy so that
// read-only commands (bug:list) never load config/env or build the app.
let _appPromise = null;
function getApp() {
  if (!_appPromise) {
    const { buildApp, registerApp } = require('../../index');
    const fastify = buildApp({ logger: false });
    _appPromise = registerApp(fastify).then(() => fastify);
  }
  return _appPromise;
}

/** Log in via the real auth route and return a bearer token. */
async function loginAs(app, email, password) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${email} (${res.statusCode})`);
  return res.json().token;
}

/** Produce the bug's triggering state: run its M3 scenario dependencies, then its own apply. */
async function applyBug(bug, ctx = {}) {
  for (const dep of bug.scenarioDependencies || []) await engine.run(dep, ctx);
  if (typeof bug.apply === 'function') ctx[bug.id] = await bug.apply(ctx);
  return ctx;
}

/**
 * Reproduce the bug and validate the fixed behavior. Returns { ok, detail }.
 * The bug's validate(ctx) receives ctx.app (the real app), ctx.prisma, and ctx.loginAs.
 */
async function validateBug(bug, ctx = {}) {
  ctx.app = await getApp();
  ctx.prisma = prisma;
  ctx.loginAs = (email, password) => loginAs(ctx.app, email, password);
  await applyBug(bug, ctx);
  return bug.validate(ctx);
}

module.exports = { getApp, loginAs, applyBug, validateBug, prisma };
