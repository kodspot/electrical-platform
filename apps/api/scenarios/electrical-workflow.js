'use strict';

/**
 * Scenario: Electrical / Inspection Workflow. [platform-M3, DPS §4]
 * An inspection template plus submitted and flagged inspections with checklist items.
 */

const { createTestInspectionTemplate, createTestElectricalInspection } = require('./factories');

async function apply(ctx) {
  const { org, rooms, supervisors, workers } = ctx['demo-organization'];

  const template = await createTestInspectionTemplate(org.id, {
    name: 'Standard Electrical Inspection',
    description: 'Default electrical safety checklist',
    isDefault: true,
    items: {
      create: [
        { label: 'Lighting', checkKey: 'LIGHTING', responseType: 'STATUS', sortOrder: 0 },
        { label: 'Fan', checkKey: 'FAN', responseType: 'STATUS', sortOrder: 1 },
        { label: 'MCB Panel', checkKey: 'MCB_PANEL', responseType: 'STATUS', sortOrder: 2 }
      ]
    }
  });

  const clean = await createTestElectricalInspection(org.id, rooms[0].id, supervisors[0].id, {
    shift: 'MORNING', status: 'SUBMITTED',
    items: { create: [{ checkType: 'LIGHTING', status: 'OK' }, { checkType: 'FAN', status: 'OK' }, { checkType: 'MCB_PANEL', status: 'OK' }] },
    workers: { connect: [{ id: workers[0].id }] }
  });

  const flagged = await createTestElectricalInspection(org.id, rooms[1].id, supervisors[0].id, {
    shift: 'AFTERNOON', status: 'FLAGGED', flagReason: 'Faulty wiring found', faultyCount: 1,
    items: { create: [{ checkType: 'LIGHTING', status: 'FAULTY', remarks: 'Flickering, needs rewiring' }, { checkType: 'FAN', status: 'OK' }, { checkType: 'MCB_PANEL', status: 'OK' }] },
    workers: { connect: [{ id: workers[1].id }] }
  });

  return { template, inspections: [clean, flagged], count: 2 };
}

module.exports = {
  name: 'electrical-workflow',
  description: 'An inspection template + one clean (SUBMITTED) and one FLAGGED inspection with checklist items.',
  dependsOn: ['demo-organization'],
  apply
};
