'use strict';

// C8 — the Quality page's "End-to-end" tab renders the latest e2e run (journeys, axe counts,
// visual states, links to the run and its artifacts). The e2e app has no GitHub dispatch
// token, so "Run full test suite now" must stay hidden with the "off" note.

const { test, expect } = require('@playwright/test');
const { seed, db, signIn } = require('../support/app');
const { checkA11y } = require('../support/visual');

test('the End-to-end tab shows the latest e2e run; the dispatch button is off without a token', async ({ page }, testInfo) => {
  const s = seed();
  const marker = `E2E tab journey ${s.run} ${testInfo.project.name}`;
  const run = await db().qaRun.create({
    data: {
      source: 'e2e', status: 'passed', total: 2, passed: 2, failed: 0,
      ref: `e2e-tab-${s.run}`, commitSha: 'abcdef1',
      runUrl: 'https://github.com/kodspot/electrical-platform/actions/runs/1',
      durationMs: 61000,
      details: {
        counts: { tests: 2, pass: 2, fail: 0, flaky: 0 },
        journeys: [{ title: marker, project: 'chromium-desktop', status: 'passed', durationMs: 1200 }],
        pages: [{ page: 'admin-login', project: 'chromium-mobile', status: 'passed', visual: 'no-baseline', axe: { critical: 0, serious: 2, moderate: 0, minor: 0 } }]
      }
    }
  });
  try {
    await signIn(page, 'superadmin', s.superAdmin);
    await page.goto('/superadmin-quality');
    await expect(page.locator('#panelE2e')).toBeHidden();

    await page.getByRole('tab', { name: 'End-to-end' }).click();
    await expect(page.getByRole('tab', { name: 'End-to-end' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#panelUnit')).toBeHidden();
    const panel = page.locator('#panelE2e');
    await expect(panel.getByText(marker)).toBeVisible();
    await expect(panel.locator('tr', { hasText: 'admin-login' })).toContainText('no-baseline');
    await expect(panel.getByRole('link', { name: 'report and traces' })).toHaveAttribute('href', /actions\/runs\/1#artifacts$/);

    await expect(page.locator('#dispatchBtn')).toBeHidden();
    await expect(page.locator('#dispatchNote')).toContainText('no GitHub dispatch token');
    await checkA11y(page, testInfo, 'superadmin-quality-e2e-tab');
  } finally {
    await db().qaRun.delete({ where: { id: run.id } });
  }
});
