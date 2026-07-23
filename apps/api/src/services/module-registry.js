'use strict';

const { prisma } = require('../lib/prisma');
const { normalizeEnabledModules } = require('./module-policy');

const DEFAULT_MODULE_DEFINITIONS = Object.freeze([
  { code: 'ele', name: 'Electrical', isCore: true, sortOrder: 10 },
  { code: 'civil', name: 'Civil', isCore: false, sortOrder: 20 },
  { code: 'asset', name: 'Asset Management', isCore: false, sortOrder: 30 },
  { code: 'complaints', name: 'Complaints', isCore: false, sortOrder: 40 }
]);

// Keep dependencies explicit and data-driven through ModuleDependency rows.
const DEFAULT_MODULE_DEPENDENCIES = Object.freeze([
  { moduleCode: 'civil', dependsOnCode: 'ele' },
  { moduleCode: 'asset', dependsOnCode: 'ele' },
  { moduleCode: 'complaints', dependsOnCode: 'ele' }
]);

function uniqueSortedModuleCodes(modules) {
  return [...new Set(normalizeEnabledModules(modules).map((m) => String(m).trim().toLowerCase()))].sort();
}

async function ensureModuleRegistry(db = prisma, logger = null) {
  for (const mod of DEFAULT_MODULE_DEFINITIONS) {
    await db.moduleDefinition.upsert({
      where: { code: mod.code },
      update: {
        name: mod.name,
        isCore: mod.isCore,
        sortOrder: mod.sortOrder,
        isActive: true
      },
      create: {
        code: mod.code,
        name: mod.name,
        isCore: mod.isCore,
        sortOrder: mod.sortOrder,
        isActive: true
      }
    });
  }

  const defs = await db.moduleDefinition.findMany({
    where: { code: { in: DEFAULT_MODULE_DEFINITIONS.map((m) => m.code) } },
    select: { id: true, code: true }
  });
  const idByCode = new Map(defs.map((d) => [d.code, d.id]));

  for (const dep of DEFAULT_MODULE_DEPENDENCIES) {
    const moduleId = idByCode.get(dep.moduleCode);
    const dependsOnModuleId = idByCode.get(dep.dependsOnCode);
    if (!moduleId || !dependsOnModuleId) continue;

    await db.moduleDependency.upsert({
      where: {
        moduleId_dependsOnModuleId: {
          moduleId,
          dependsOnModuleId
        }
      },
      update: {},
      create: {
        moduleId,
        dependsOnModuleId
      }
    });
  }

  if (logger) {
    logger.info({ count: DEFAULT_MODULE_DEFINITIONS.length }, 'Module registry ensured');
  }
}

async function loadModuleRegistry(db = prisma) {
  const modules = await db.moduleDefinition.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true, isCore: true }
  });

  const deps = await db.moduleDependency.findMany({
    select: {
      moduleId: true,
      dependsOnModuleId: true,
      module: { select: { code: true } },
      dependsOnModule: { select: { code: true } }
    }
  });

  const moduleByCode = new Map(modules.map((m) => [m.code, m]));
  const dependencyMap = new Map();
  const reverseDependencyMap = new Map();

  for (const dep of deps) {
    const moduleCode = dep.module.code;
    const dependsOnCode = dep.dependsOnModule.code;

    if (!dependencyMap.has(moduleCode)) dependencyMap.set(moduleCode, new Set());
    dependencyMap.get(moduleCode).add(dependsOnCode);

    if (!reverseDependencyMap.has(dependsOnCode)) reverseDependencyMap.set(dependsOnCode, new Set());
    reverseDependencyMap.get(dependsOnCode).add(moduleCode);
  }

  return { moduleByCode, dependencyMap, reverseDependencyMap };
}

async function validateActivationPlan({ currentModules, targetModules }, db = prisma) {
  await ensureModuleRegistry(db);
  const registry = await loadModuleRegistry(db);

  const current = new Set(uniqueSortedModuleCodes(currentModules));
  const target = new Set(uniqueSortedModuleCodes(targetModules));
  const errors = [];

  if (!target.size) {
    errors.push({ code: 'EMPTY_MODULE_SET', message: 'At least one module must remain active.' });
  }

  for (const code of target) {
    if (!registry.moduleByCode.has(code)) {
      errors.push({ code: 'UNKNOWN_MODULE', message: `Unknown or inactive module: ${code}`, module: code });
    }
  }

  for (const mod of registry.moduleByCode.values()) {
    if (mod.isCore && !target.has(mod.code)) {
      errors.push({ code: 'CORE_MODULE_REQUIRED', message: `Core module cannot be deactivated: ${mod.code}`, module: mod.code });
    }
  }

  for (const code of target) {
    const deps = registry.dependencyMap.get(code);
    if (!deps) continue;
    for (const depCode of deps) {
      if (!target.has(depCode)) {
        errors.push({
          code: 'MISSING_DEPENDENCY',
          message: `Module ${code} requires ${depCode}`,
          module: code,
          dependsOn: depCode
        });
      }
    }
  }

  for (const code of current) {
    if (target.has(code)) continue;
    const dependents = registry.reverseDependencyMap.get(code);
    if (!dependents) continue;
    for (const dep of dependents) {
      if (target.has(dep)) {
        errors.push({
          code: 'DEPENDENT_BLOCKS_DEACTIVATION',
          message: `Cannot deactivate ${code} while dependent module ${dep} remains active.`,
          module: code,
          dependent: dep
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    normalizedModules: [...target]
  };
}

async function syncOrgModuleActivations({ orgId, targetModules, actorId = null }, db = prisma) {
  await ensureModuleRegistry(db);

  const normalizedTarget = new Set(uniqueSortedModuleCodes(targetModules));
  const definitions = await db.moduleDefinition.findMany({
    where: { code: { in: [...normalizedTarget] } },
    select: { id: true, code: true }
  });
  const targetByCode = new Map(definitions.map((d) => [d.code, d.id]));

  const existing = await db.orgModuleActivation.findMany({
    where: { orgId },
    select: {
      id: true,
      moduleId: true,
      isActive: true,
      module: { select: { code: true } }
    }
  });

  const existingByCode = new Map(existing.map((e) => [e.module.code, e]));
  const now = new Date();

  for (const code of normalizedTarget) {
    const moduleId = targetByCode.get(code);
    if (!moduleId) continue;

    const row = existingByCode.get(code);
    if (!row) {
      await db.orgModuleActivation.create({
        data: {
          orgId,
          moduleId,
          isActive: true,
          activatedAt: now,
          activatedById: actorId,
          deactivatedAt: null,
          deactivatedById: null
        }
      });
      continue;
    }

    if (!row.isActive) {
      await db.orgModuleActivation.update({
        where: { id: row.id },
        data: {
          isActive: true,
          activatedAt: now,
          activatedById: actorId,
          deactivatedAt: null,
          deactivatedById: null
        }
      });
    }
  }

  for (const row of existing) {
    const code = row.module.code;
    if (normalizedTarget.has(code) || !row.isActive) continue;

    await db.orgModuleActivation.update({
      where: { id: row.id },
      data: {
        isActive: false,
        deactivatedAt: now,
        deactivatedById: actorId
      }
    });
  }
}

module.exports = {
  ensureModuleRegistry,
  validateActivationPlan,
  syncOrgModuleActivations
};
