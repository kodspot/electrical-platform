'use strict';

function attachTenantContextFromUser(request, user) {
  request.tenant = {
    orgId: user?.orgId || null,
    actorType: 'user',
    actorId: user?.id || null,
    role: user?.role || null,
    isSuperAdmin: user?.role === 'SUPER_ADMIN',
    saOrgSwitch: user?._saOrgSwitch || null
  };
  return request.tenant;
}

function attachTenantContextFromWorker(request, worker) {
  request.tenant = {
    orgId: worker?.orgId || null,
    actorType: 'worker',
    actorId: worker?.id || null,
    role: 'WORKER',
    isSuperAdmin: false,
    saOrgSwitch: null
  };
  return request.tenant;
}

function getTenantOrgId(request) {
  return request?.tenant?.orgId || request?.user?.orgId || request?.worker?.orgId || null;
}

module.exports = {
  attachTenantContextFromUser,
  attachTenantContextFromWorker,
  getTenantOrgId
};
