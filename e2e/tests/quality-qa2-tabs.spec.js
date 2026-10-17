'use strict';

// QA-2 — the Quality page's Explorer, Design, Changes and Production tabs render the latest
// runs of their sources; the existing tabs keep showing test-suite runs only. The runs are
// created here and deleted afterwards, so the page's visual baseline does not depend on them.

const { test, expect } = require('@playwright/test');
const { seed, db, signIn } = require('../support/app');
const { checkA11y } = require('../support/visual');

const RUN_URL = 'https://github.com/kodspot/electrical-platform/actions/runs/7';

test('the Explorer, Design, Changes and Production tabs show their latest runs', async ({ page }, testInfo) => {
  const s = seed();
  const tag = `${s.run}-${testInfo.project.name}`;
  const runs = await Promise.all([
    db().qaRun.create({
      data: {
        source: 'e2e', status: 'passed', total: 3, passed: 3, failed: 0, ref: `qa2-tabs-${tag}`, commitSha: 'e2e0001', runUrl: RUN_URL,
        details: {
          counts: { tests: 3, pass: 3, fail: 0, flaky: 0 },
          journeys: [],
          pages: [
            { page: 'admin-login', project: 'chromium-desktop', status: 'passed', visual: 'compared', axe: { critical: 0, serious: 0 } },
            { page: 'admin-tickets', project: 'chromium-mobile', status: 'failed', visual: 'diff', axe: { critical: 0, serious: 1 } }
          ],
          design: { ratchets: [{ name: 'colour literals', count: 120, baseline: 120, status: 'ok' }] },
          explorer: {
            desktop: [{ role: 'supervisor', page: 'supervisor-assets', status: 'passed', failed: '', allowed: '', links: 4, linkFailures: 0, tabs: 0 }],
            mobile: [{ role: 'admin', page: 'admin-assets', status: 'passed', failed: '', allowed: 'F16, F17', links: 15, linkFailures: 0, tabs: 0 }],
            forbidden: [{ project: 'desktop', role: 'electrician', checked: 24, shown: '', status: 'passed' }],
            allowlist: { entries: 10, unused: [] }
          }
        }
      }
    }),
    db().qaRun.create({
      data: {
        source: 'impact', status: 'not_covered', total: 2, passed: 1, failed: 1, ref: `qa2-impact-${tag}`, commitSha: 'imp0001', runUrl: RUN_URL,
        details: {
          items: [
            { kind: 'page', id: 'admin-tickets', covered: true, coveredBy: 'journey, explorer', pages: '' },
            { kind: 'route', id: 'POST /api/tickets/:id/resolve', covered: false, coveredBy: '', pages: 'admin-tickets' }
          ],
          uncovered: ['route POST /api/tickets/:id/resolve'],
          other: ['docs/x.md (docs)']
        }
      }
    }),
    db().qaRun.create({
      data: {
        source: 'prod-smoke', status: 'passed', total: 2, passed: 2, failed: 0, ref: 'main', commitSha: 'prd0001', runUrl: RUN_URL, event: 'push',
        details: {
          checks: [{ check: 'production is ready (/health/ready)', status: 'passed', detail: '' }, { check: 'security headers are present', status: 'passed', detail: '' }],
          methods: { GET: 31, HEAD: 0 }, readOnly: true, target: 'example.test'
        }
      }
    })
  ]);
  try {
    await signIn(page, 'superadmin', s.superAdmin);
    await page.goto('/superadmin-quality');
    // The existing tabs are unchanged: the reports are not test-suite runs.
    await expect(page.locator('#runsBody')).not.toContainText(`qa2-impact-${tag}`);
    await expect(page.locator('#runsBody')).not.toContainText('prod-smoke');

    await page.getByRole('tab', { name: 'Explorer' }).click();
    const explorer = page.locator('#panelExplorer');
    await expect(explorer.locator('tr', { hasText: 'supervisor-assets' })).toContainText('passed');
    await expect(explorer.locator('tr', { hasText: 'admin-assets' })).toContainText('F16, F17');
    await expect(explorer.locator('tr', { hasText: 'electrician' }).last()).toContainText('24');

    await page.getByRole('tab', { name: 'Design' }).click();
    const design = page.locator('#panelDesign');
    await expect(design.getByText('Visual differences: admin-tickets (chromium-mobile)')).toBeVisible();
    await expect(design.getByRole('link', { name: 'e2e-traces artifact' })).toHaveAttribute('href', /actions\/runs\/7#artifacts$/);
    await expect(design.locator('tr', { hasText: 'colour literals' })).toContainText('120');

    await page.getByRole('tab', { name: 'Changes' }).click();
    const changes = page.locator('#panelChanges');
    await expect(changes.locator('tr', { hasText: `qa2-impact-${tag}` })).toBeVisible();
    await expect(changes.getByText('Changed but not covered: route POST /api/tickets/:id/resolve')).toBeVisible();

    await page.getByRole('tab', { name: 'Production' }).click();
    const prod = page.locator('#panelProd');
    await expect(prod).toContainText('requests made: GET 31, HEAD 0');
    await expect(prod).toContainText('Read-only: only GET and HEAD requests were sent.');
    await expect(prod.locator('tr', { hasText: 'security headers are present' })).toContainText('passed');

    // Arrow keys move between all six tabs.
    await page.getByRole('tab', { name: 'Production' }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Unit & integration' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Unit & integration' })).toBeFocused();

    await page.getByRole('tab', { name: 'Explorer' }).click();
    await checkA11y(page, testInfo, 'superadmin-quality-qa2-tabs');
  } finally {
    await db().qaRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
  }
});
