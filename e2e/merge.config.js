'use strict';

/**
 * Merges the sharded e2e runs (.github/workflows/e2e.yml) into the same reports a single
 * run writes: HTML, JUnit and reports/results.json (which scripts/summarize.js reads).
 * Used only by `npx playwright merge-reports --config merge.config.js <blob dir>`: it starts
 * no web server and needs no database, unlike playwright.config.js.
 */

module.exports = {
  testDir: './tests',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['json', { outputFile: 'reports/results.json' }]
  ]
};
