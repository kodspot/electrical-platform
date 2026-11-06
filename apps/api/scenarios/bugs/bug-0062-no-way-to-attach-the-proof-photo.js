'use strict';

/**
 * BUG-0062 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (page) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', page), 'utf8');

module.exports = {
  id: 'BUG-0062',
  title: 'An electrician could not attach the proof photo, so could not resolve a ticket',
  description: 'public/css/design-system.css hides every file input, and the required #rPhoto on electrician-tickets.html had no label tied to it, so the page showed "Proof Photo *" with nothing to tap. The journeys set the file directly, which works on a hidden input, so no test noticed.',
  module: 'ele',
  category: 'workflow',
  severity: 'CRITICAL',
  status: 'FIXED',
  origin: 'UX pass 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'A global display:none on file inputs, with a required input that had no visible control.',
  expectedBehavior: 'A visible "Take proof photo" control opens the camera or file chooser; Mark Resolved stays disabled until a photo is attached.',
  brokenBehavior: 'Nothing to tap. The electrician could not resolve any ticket from the app.',
  reproductionSteps: [
    'Sign in as an electrician and open a job in My jobs.',
    'Tap Resolve With Photo.',
    'Broken: no control for the photo. Fixed: the label opens the file chooser.'
  ],
  scenarioDependencies: [],
  regressionTest: 'e2e/tests/forms.spec.js › "BUG-0062"',

  async apply() {
    return {};
  },

  async validate() {
    if (!read('electrician-tickets.html').includes('class="resolve-photo-label" for="rPhoto"')) return { ok: false, detail: 'the proof photo has no visible control' };
    if (!read('css/design-system.css').includes('input[type=file].sr-only { display: block; }')) return { ok: false, detail: 'file inputs are hidden outright again' };
    return { ok: true, detail: 'A visible "Take proof photo" control opens the camera or file chooser; Mark Resolved stays disabled until a photo is attached' };
  }
};
