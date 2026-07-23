'use strict';

const { prisma } = require('../lib/prisma');

const VALID_MODULES = Object.freeze(['ele', 'civil', 'asset', 'complaints']);

const DEFAULT_MODULE_ISSUES = Object.freeze({
  ele: Object.freeze([
    Object.freeze({ key: 'ELECTRICAL_FAULT', label: 'Electrical Fault' }),
    Object.freeze({ key: 'WIRING_ISSUE', label: 'Wiring Issue' }),
    Object.freeze({ key: 'POWER_OUTAGE', label: 'Power Outage' }),
    Object.freeze({ key: 'SHORT_CIRCUIT', label: 'Short Circuit' }),
    Object.freeze({ key: 'LIGHT_NOT_WORKING', label: 'Light Not Working' }),
    Object.freeze({ key: 'FAN_NOT_WORKING', label: 'Fan Not Working' }),
    Object.freeze({ key: 'AC_NOT_WORKING', label: 'AC Not Working' }),
    Object.freeze({ key: 'SWITCH_SOCKET_ISSUE', label: 'Switch / Socket Issue' }),
    Object.freeze({ key: 'OTHER', label: 'Other Issue' })
  ]),
  civil: Object.freeze([
    Object.freeze({ key: 'STRUCTURAL_DAMAGE', label: 'Structural Damage' }),
    Object.freeze({ key: 'PLUMBING_LEAK', label: 'Plumbing Leak' }),
    Object.freeze({ key: 'PAINT_DAMAGE', label: 'Paint Damage' }),
    Object.freeze({ key: 'CEILING_DAMAGE', label: 'Ceiling Damage' }),
    Object.freeze({ key: 'FLOOR_DAMAGE', label: 'Floor Damage' }),
    Object.freeze({ key: 'DOOR_WINDOW_ISSUE', label: 'Door / Window Issue' }),
    Object.freeze({ key: 'WALL_CRACK', label: 'Wall Crack' }),
    Object.freeze({ key: 'OTHER', label: 'Other Issue' })
  ]),
  asset: Object.freeze([
    Object.freeze({ key: 'ASSET_DAMAGED', label: 'Asset Damaged' }),
    Object.freeze({ key: 'ASSET_MISSING', label: 'Asset Missing' }),
    Object.freeze({ key: 'ASSET_MALFUNCTION', label: 'Asset Malfunction' }),
    Object.freeze({ key: 'OTHER', label: 'Other Issue' })
  ]),
  complaints: Object.freeze([
    Object.freeze({ key: 'NOISE', label: 'Noise Complaint' }),
    Object.freeze({ key: 'TEMPERATURE', label: 'Temperature Issue' }),
    Object.freeze({ key: 'STAFF_BEHAVIOUR', label: 'Staff Behaviour' }),
    Object.freeze({ key: 'SAFETY_CONCERN', label: 'Safety Concern' }),
    Object.freeze({ key: 'OTHER', label: 'Other Issue' })
  ])
});

function normalizeModuleCode(moduleCode) {
  const normalized = String(moduleCode || 'ele').trim().toLowerCase();
  return VALID_MODULES.includes(normalized) ? normalized : 'ele';
}

function normalizeIssueKey(input) {
  return String(input || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 80);
}

function humanizeIssueKey(issueKey) {
  const key = normalizeIssueKey(issueKey);
  if (!key) return 'Other Issue';

  for (const mod of VALID_MODULES) {
    const found = DEFAULT_MODULE_ISSUES[mod].find((row) => row.key === key);
    if (found) return found.label;
  }

  return key
    .split('_')
    .filter(Boolean)
    .map((token) => token.charAt(0) + token.substring(1).toLowerCase())
    .join(' ');
}

function getDefaultCategories(moduleCode) {
  const module = normalizeModuleCode(moduleCode);
  return DEFAULT_MODULE_ISSUES[module].map((item, idx) => ({
    id: null,
    key: item.key,
    label: item.label,
    module,
    description: null,
    sortOrder: idx,
    isDefault: true,
    isHostelSpecific: false,
    hostelLocationId: null
  }));
}

async function getHostelLocationId(locationId, orgId, db = prisma) {
  if (!locationId || !orgId) return null;

  let cursorId = locationId;
  let depth = 0;

  while (cursorId && depth < 25) {
    const row = await db.location.findFirst({
      where: { id: cursorId, orgId },
      select: { id: true, parentId: true, type: true }
    });

    if (!row) return null;
    if (row.type === 'HOSTEL') return row.id;

    cursorId = row.parentId;
    depth += 1;
  }

  return null;
}

function mapCategory(row, isHostelSpecific) {
  return {
    id: row.id,
    key: row.key,
    label: row.name,
    module: row.module,
    description: row.description,
    sortOrder: row.sortOrder,
    isDefault: false,
    isHostelSpecific,
    hostelLocationId: row.hostelLocationId || null
  };
}

async function getComplaintCategoriesForLocation({ orgId, locationId, module, includeDefaults = true }, db = prisma) {
  const moduleCode = normalizeModuleCode(module);

  if (!orgId) {
    return {
      module: moduleCode,
      hostelLocationId: null,
      categories: includeDefaults ? getDefaultCategories(moduleCode) : []
    };
  }

  const hostelLocationId = await getHostelLocationId(locationId, orgId, db);

  const [globalRows, hostelRows] = await Promise.all([
    db.complaintCategory.findMany({
      where: {
        orgId,
        module: moduleCode,
        isActive: true,
        hostelLocationId: null
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        module: true,
        description: true,
        sortOrder: true,
        hostelLocationId: true
      }
    }),
    hostelLocationId
      ? db.complaintCategory.findMany({
        where: {
          orgId,
          module: moduleCode,
          isActive: true,
          hostelLocationId
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          key: true,
          name: true,
          module: true,
          description: true,
          sortOrder: true,
          hostelLocationId: true
        }
      })
      : Promise.resolve([])
  ]);

  const mergedByKey = new Map();
  for (const row of globalRows) {
    mergedByKey.set(row.key, mapCategory(row, false));
  }
  for (const row of hostelRows) {
    mergedByKey.set(row.key, mapCategory(row, true));
  }

  let categories = [...mergedByKey.values()].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.label.localeCompare(b.label);
  });

  if (!categories.length && includeDefaults) {
    categories = getDefaultCategories(moduleCode);
  }

  return {
    module: moduleCode,
    hostelLocationId,
    categories
  };
}

module.exports = {
  VALID_MODULES,
  DEFAULT_MODULE_ISSUES,
  normalizeModuleCode,
  normalizeIssueKey,
  humanizeIssueKey,
  getDefaultCategories,
  getHostelLocationId,
  getComplaintCategoriesForLocation
};
