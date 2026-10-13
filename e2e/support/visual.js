'use strict';

// Design and accessibility checks (C7).
//
// Visual: toHaveScreenshot against a per-platform baseline
// (tests/__screenshots__/<platform>/<project>/<name>.png). Baselines are generated ONLY in
// CI on Linux (e2e.yml, workflow_dispatch update_snapshots=true → uploaded as an artifact,
// then committed by a person). Until a baseline exists for this platform the check records
// "no baseline", attaches the screenshot, and does not fail.
//
// Accessibility: axe-core (WCAG 2.0/2.1 A + AA). Report-only — the test fails only on
// "critical" violations. Counts per impact are recorded as an annotation and a JSON
// attachment that holds rule ids, impact, help text and selectors only — never node HTML,
// which could carry an ?token= image URL into a public artifact.

const fs = require('node:fs');
const { expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
// Anything that changes from run to run or day to day: times, dates, relative times.
const DYNAMIC_TEXT = new RegExp(
  `\\b\\d{1,2}:\\d{2}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b|\\b\\d{1,2} (${MONTHS})|\\b(${MONTHS})[a-z]* \\d{1,2}\\b|\\bago\\b|\\btoday\\b|\\byesterday\\b`,
  'i'
);

/**
 * Wait until the page has settled: loaded, no skeleton or "Loading…" placeholder left, fonts
 * ready. Not 'networkidle': signed-in pages hold an SSE notification stream open, so the
 * network never goes idle.
 */
async function settle(page) {
  await page.waitForLoadState('load');
  // Visible ones only: closed modals and inactive tabs keep their placeholders forever.
  await expect(page.locator('.skeleton, .spinner, .loading-center').filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText(/^\s*Loading[^\n]*…\s*$/).filter({ visible: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

/**
 * Compare a screenshot with the platform baseline, or record "no baseline".
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} name — e.g. 'admin-login.png'
 * @param {string[]} [maskSelectors] — page-specific dynamic regions
 */
async function checkVisual(page, testInfo, name, maskSelectors = []) {
  await settle(page);
  const mask = [page.getByText(DYNAMIC_TEXT), page.locator('canvas'), ...maskSelectors.map((s) => page.locator(s))];
  const baseline = testInfo.snapshotPath(name, { kind: 'screenshot' });
  const updating = ['all', 'changed'].includes(testInfo.config.updateSnapshots);

  if (!updating && !fs.existsSync(baseline)) {
    testInfo.annotations.push({ type: 'visual', description: `no baseline: ${name} (${process.platform}/${testInfo.project.name})` });
    await testInfo.attach(`screenshot-${name}`, {
      body: await page.screenshot({ fullPage: true, animations: 'disabled', mask }),
      contentType: 'image/png'
    });
    return 'no-baseline';
  }

  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    mask,
    maxDiffPixelRatio: 0.01
  });
  testInfo.annotations.push({ type: 'visual', description: `${updating ? 'baseline written' : 'compared'}: ${name}` });
  return updating ? 'updated' : 'compared';
}

/**
 * Run axe on the current page. Records counts; fails only on critical violations.
 * @returns {Promise<{critical:number, serious:number, moderate:number, minor:number}>}
 */
async function checkA11y(page, testInfo, name) {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const violations = results.violations.map((v) => {
    if (counts[v.impact] !== undefined) counts[v.impact] += v.nodes.length;
    return { id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 10).map((n) => n.target.join(' ')) };
  });
  testInfo.annotations.push({
    type: 'axe',
    description: `${name}: critical ${counts.critical}, serious ${counts.serious}, moderate ${counts.moderate}, minor ${counts.minor}`
  });
  await testInfo.attach(`axe-${name}.json`, { body: JSON.stringify({ page: name, counts, violations }, null, 2), contentType: 'application/json' });
  const critical = violations.filter((v) => v.impact === 'critical');
  expect(critical, `critical accessibility violations on ${name}: ${critical.map((v) => `${v.id} (${v.nodes})`).join(', ')}`).toEqual([]);
  return counts;
}

module.exports = { checkVisual, checkA11y, settle, DYNAMIC_TEXT };
