'use strict';

/**
 * Scenario engine. [platform-M3, DPS §4]
 *
 * A scenario is a named module ({ name, description, dependsOn, apply(ctx) }) that
 * composes the shared factories into a coherent business state. The engine resolves
 * dependencies, runs each scenario once per invocation, and threads a shared `ctx`
 * (ctx[name] = that scenario's returned handles) so later scenarios build on earlier
 * ones. The same scenarios are reused by seed, `npm run scenario`, and tests.
 */

const { prisma } = require('../src/lib/prisma');

const SCENARIOS = {
  'fresh-installation': require('./fresh-installation'),
  'demo-organization': require('./demo-organization'),
  'ticket-workflow': require('./ticket-workflow'),
  'electrical-workflow': require('./electrical-workflow'),
  'attendance-workflow': require('./attendance-workflow'),
  'notification-workflow': require('./notification-workflow'),
  'ai-workflow': require('./ai-workflow'),
  'supervisor-workflow': require('./supervisor-workflow'),
  'worker-workflow': require('./worker-workflow'),
  'admin-workflow': require('./admin-workflow'),
  'reporting-workflow': require('./reporting-workflow')
};

// The canonical demo dataset (DPS §5): a curated composition — the base org plus the
// workflows that add distinct, non-redundant data. The role-focused scenarios
// (supervisor/worker/admin) remain available individually via `npm run scenario`.
const PROFILES = {
  demo: [
    'fresh-installation',
    'demo-organization',
    'ticket-workflow',
    'electrical-workflow',
    'attendance-workflow',
    'notification-workflow',
    'ai-workflow',
    'reporting-workflow'
  ]
};

const { DEMO_SLUG } = require('./demo-organization');

function list() {
  return Object.entries(SCENARIOS).map(([name, s]) => ({ name, description: s.description }));
}

function has(name) {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, name);
}

/** Run one scenario (resolving its dependencies first), accumulating handles into ctx. */
async function run(name, ctx = {}, ran = new Set()) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`Unknown scenario: ${name}. Try one of: ${Object.keys(SCENARIOS).join(', ')}`);
  if (ran.has(name)) return ctx[name];
  for (const dep of scenario.dependsOn || []) await run(dep, ctx, ran);
  ctx[name] = (await scenario.apply(ctx)) || {};
  ran.add(name);
  return ctx[name];
}

/** Delete the demo organisation (cascade), so a full seed is a deterministic clean rebuild. */
async function clearDemo() {
  await prisma.organization.deleteMany({ where: { slug: DEMO_SLUG } });
}

/** Apply a named profile (default "demo"): clear the demo org, then run its scenarios. */
async function seed(profile = 'demo') {
  const names = PROFILES[profile];
  if (!names) throw new Error(`Unknown profile: ${profile}. Available: ${Object.keys(PROFILES).join(', ')}`);
  await clearDemo();
  const ctx = {};
  const ran = new Set();
  for (const name of names) await run(name, ctx, ran);
  return ctx;
}

module.exports = { SCENARIOS, PROFILES, DEMO_SLUG, list, has, run, seed, clearDemo };
