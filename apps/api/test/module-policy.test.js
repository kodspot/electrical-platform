'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_ENABLED_MODULES,
  normalizeEnabledModules,
  getEnabledModulesFromOrg,
  isModuleEnabled
} = require('../src/services/module-policy');

test('normalizeEnabledModules returns a non-empty array unchanged', () => {
  const modules = ['ele', 'asset'];
  assert.deepStrictEqual(normalizeEnabledModules(modules), modules);
});

test('normalizeEnabledModules falls back to the default for undefined, null, or an empty array', () => {
  assert.deepStrictEqual(normalizeEnabledModules(undefined), [...DEFAULT_ENABLED_MODULES]);
  assert.deepStrictEqual(normalizeEnabledModules(null), [...DEFAULT_ENABLED_MODULES]);
  assert.deepStrictEqual(normalizeEnabledModules([]), [...DEFAULT_ENABLED_MODULES]);
});

test('normalizeEnabledModules returns a fresh copy, not the frozen default reference', () => {
  const result = normalizeEnabledModules(null);
  result.push('civil');
  assert.deepStrictEqual(DEFAULT_ENABLED_MODULES, ['ele'], 'mutating the returned array must not affect the frozen default');
});

test('getEnabledModulesFromOrg reads enabledModules off an org-like object', () => {
  assert.deepStrictEqual(getEnabledModulesFromOrg({ enabledModules: ['ele', 'complaints'] }), ['ele', 'complaints']);
});

test('getEnabledModulesFromOrg falls back to default when org has no enabledModules, or org is null/undefined', () => {
  assert.deepStrictEqual(getEnabledModulesFromOrg({}), [...DEFAULT_ENABLED_MODULES]);
  assert.deepStrictEqual(getEnabledModulesFromOrg(null), [...DEFAULT_ENABLED_MODULES]);
  assert.deepStrictEqual(getEnabledModulesFromOrg(undefined), [...DEFAULT_ENABLED_MODULES]);
});

test('isModuleEnabled accepts a raw modules array', () => {
  assert.strictEqual(isModuleEnabled(['ele', 'asset'], 'asset'), true);
  assert.strictEqual(isModuleEnabled(['ele', 'asset'], 'civil'), false);
});

test('isModuleEnabled accepts an org-like object', () => {
  assert.strictEqual(isModuleEnabled({ enabledModules: ['ele', 'civil'] }, 'civil'), true);
  assert.strictEqual(isModuleEnabled({ enabledModules: ['ele', 'civil'] }, 'asset'), false);
});

test('isModuleEnabled defaults an org with no enabledModules to ele-only', () => {
  assert.strictEqual(isModuleEnabled({}, 'ele'), true);
  assert.strictEqual(isModuleEnabled({}, 'asset'), false);
});
