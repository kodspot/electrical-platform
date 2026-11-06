'use strict';

/**
 * BUG-0074 — a fixed defect, encoded as a reproducible scenario + regression.
 */

const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');

module.exports = {
  id: 'BUG-0074',
  title: 'The AI assistant sent supervisors\' and electricians\' names to the outside AI provider',
  description: 'src/routes/ai.js built the prompt with each inspection\'s supervisor and electrician names. The privacy notice says aggregated summaries are sent, and the assistant does not need names to summarise the day.',
  module: 'ele',
  category: 'privacy',
  severity: 'MEDIUM',
  status: 'FIXED',
  origin: 'Security and DPDP audit 2026-11',
  dateIntroduced: 'pre-audit',
  dateFixed: '2026-11-06',
  rootCause: 'The prompt was written for usefulness, with no minimisation step.',
  expectedBehavior: 'The prompt holds counts: "Morning shift, 2 electrician(s)". No person\'s name is sent.',
  brokenBehavior: 'Named staff in each request to Google or Microsoft.',
  reproductionSteps: [
    'Enable AI for an organization and ask the assistant about today.',
    'Broken: the provider receives the names. Fixed: counts only.'
  ],
  scenarioDependencies: [],
  regressionTest: 'apps/api/scenarios/bugs/bug-0074-ai-prompt-names-staff.js',

  async apply() {
    return {};
  },

  async validate() {
    const src = read('src/routes/ai.js');
    if (/supervisor: \{ select: \{ name: true/.test(src) || /workers: \{ select: \{ name: true/.test(src)) return { ok: false, detail: 'the AI context still reads staff names' };
    return { ok: true, detail: 'the AI context holds counts, not names' };
  }
};
