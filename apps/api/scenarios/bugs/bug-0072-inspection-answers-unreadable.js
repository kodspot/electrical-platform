'use strict';

/**
 * BUG-0072 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0072',
  title: 'The inspection answer buttons were unreadable in the dark field theme',
  description: 'supervisor-electrical.html set no text colour on .check-btn, so the browser default black sat on a dark surface, at 10px, for the Yes/No/OK/Fault buttons that make up an inspection.',
  module: 'ele',
  category: 'ux',
  severity: 'HIGH',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'A button style with a background and no colour.',
  expectedBehavior: 'Answers use the text colour, at .9rem and 48px tall, with a solid fill and a tick when chosen, and aria-pressed.',
  brokenBehavior: 'Black on near-black, in small type, on a phone in a dim plant room.',
  reproductionSteps: [
    'Open an inspection as a supervisor.',
    'Broken: the answers cannot be read. Fixed: readable, large, and marked when chosen.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0072-inspection-answers-unreadable.js',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('supervisor-electrical.html').includes('background:var(--surface);color:var(--text);border-radius:var(--radius-sm);padding:.25rem .6rem;font-size:.9rem')) return { ok: false, detail: 'the answer buttons lost their text colour' };
    if (!read('supervisor-electrical.html').includes('press(\'OK\')')) return { ok: false, detail: 'chosen answers are not exposed with aria-pressed' };
    return { ok: true, detail: 'Answers use the text colour, at ' };
  }
};
