'use strict';

const DEFAULT_ENABLED_MODULES = Object.freeze(['ele']);

/**
 * Returns a non-empty module list with safe defaults.
 */
function normalizeEnabledModules(modules) {
  if (Array.isArray(modules) && modules.length > 0) {
    return modules;
  }
  return [...DEFAULT_ENABLED_MODULES];
}

/**
 * Reads enabled modules from an org-like object.
 */
function getEnabledModulesFromOrg(org) {
  return normalizeEnabledModules(org?.enabledModules);
}

/**
 * Accepts either a modules array or an org-like object.
 */
function isModuleEnabled(modulesOrOrg, moduleCode) {
  const modules = Array.isArray(modulesOrOrg)
    ? normalizeEnabledModules(modulesOrOrg)
    : getEnabledModulesFromOrg(modulesOrOrg);

  return modules.includes(moduleCode);
}

module.exports = {
  DEFAULT_ENABLED_MODULES,
  normalizeEnabledModules,
  getEnabledModulesFromOrg,
  isModuleEnabled
};
