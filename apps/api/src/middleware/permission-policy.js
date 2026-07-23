'use strict';

const POLICY_DEFINITIONS = Object.freeze({
  SUPER_ADMIN: Object.freeze({
    roles: Object.freeze(['SUPER_ADMIN']),
    requireOrgContext: false,
    allowSuperAdmin: true
  }),
  ORG_ADMIN: Object.freeze({
    roles: Object.freeze(['ADMIN']),
    requireOrgContext: true,
    allowSuperAdmin: true
  }),
  ORG_STAFF: Object.freeze({
    roles: Object.freeze(['ADMIN', 'SUPERVISOR']),
    requireOrgContext: true,
    allowSuperAdmin: true
  }),
  SUPERVISOR: Object.freeze({
    roles: Object.freeze(['SUPERVISOR']),
    requireOrgContext: true,
    allowSuperAdmin: true
  }),
  ADMIN_OR_SUPER_ADMIN: Object.freeze({
    roles: Object.freeze(['ADMIN', 'SUPER_ADMIN']),
    requireOrgContext: false,
    allowSuperAdmin: true
  })
});

const MODULE_CODES = Object.freeze({
  ELE: 'ele',
  CIVIL: 'civil',
  ASSET: 'asset',
  COMPLAINTS: 'complaints'
});

function getPermissionPolicy(policyName) {
  const policy = POLICY_DEFINITIONS[policyName];
  if (!policy) {
    throw new Error(`Unknown permission policy: ${policyName}`);
  }
  return policy;
}

module.exports = {
  POLICY_DEFINITIONS,
  MODULE_CODES,
  getPermissionPolicy
};
