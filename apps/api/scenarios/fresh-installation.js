'use strict';

/**
 * Scenario: Fresh Installation. [platform-M3, DPS §4]
 *
 * The empty-but-valid system: ensures the global module registry exists (the same
 * boot-time step index.js runs), so any org can use the module system. Creates no
 * tenant data. Every other scenario depends on this.
 */

const { prisma } = require('../src/lib/prisma');
const { ensureModuleRegistry } = require('../src/services/module-registry');

async function apply() {
  await ensureModuleRegistry(prisma);
  return {};
}

module.exports = {
  name: 'fresh-installation',
  description: 'Empty but valid: ensures the global module registry (ele/civil/asset/complaints).',
  dependsOn: [],
  apply
};
