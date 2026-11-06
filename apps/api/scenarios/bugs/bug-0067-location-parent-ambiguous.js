'use strict';

/**
 * BUG-0067 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0067',
  title: 'Choosing a parent location was ambiguous and offered rooms as parents',
  description: 'admin-locations.html listed every location by name and raw type, including rooms, so a room could be filed under the wrong "Floor 1", or under another room, and its printed sticker named the wrong place.',
  module: 'ele',
  category: 'data-integrity',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The select listed all nodes with no path filter.',
  expectedBehavior: 'Only spaces that can hold others are listed, by full path, with a live line showing what the sticker will read.',
  brokenBehavior: 'Two "Floor 1" entries; rooms offered as parents.',
  reproductionSteps: [
    'Add a second block with a Floor 1.',
    'Add a room and open Parent.',
    'Broken: two identical entries. Fixed: "Block A → Floor 1" and "Block B → Floor 1".'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0067-location-parent-ambiguous.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('admin-locations.html').includes('allLocations.filter(function(l) { return isContainer(l.type); })')) return { ok: false, detail: 'the parent list is not limited to containers' };
    if (!read('admin-locations.html').includes('sticker will read')) return { ok: false, detail: 'no live path line' };
    return { ok: true, detail: 'Only spaces that can hold others are listed, by full path, with a live line showing what the sticker will read' };
  }
};
