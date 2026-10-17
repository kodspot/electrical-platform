'use strict';

// UI defects found by the QA-2 visual baselines that need a browser to check. The others are
// covered by the explorer (rawValue, nav, overflow, axe) and the bug registry (BUG-0012..0014).

const { test, expect } = require('@playwright/test');
const { seed } = require('../support/app');

// F18: on the module home, "← All modules" (shown when an org has more than one module) used
// var(--primary) — blue on the blue page gradient. axe cannot measure contrast over a
// gradient (it reports "needs review", not a violation), so this computes the WCAG ratio
// between the link's colour and EVERY colour stop of the gradient behind it, and requires AA.
test('F18 — the module home\'s "All modules" link has readable contrast (WCAG AA) on every part of the gradient', async ({ page }) => {
  const s = seed();
  await page.goto(`/${s.explorer.org.slug}/ele`);
  const link = page.locator('.mod-back a');
  await expect(link).toBeVisible();
  const { text, stops } = await link.evaluate((a) => {
    const rgb = (s) => (s.match(/rgba?\([^)]*\)/g) || []).map((c) => c.match(/[\d.]+/g).slice(0, 3).map(Number));
    // The nearest ancestor that paints a background (an image/gradient or an opaque colour).
    let el = a.parentElement;
    let stops = [];
    while (el && !stops.length) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') stops = rgb(cs.backgroundImage);
      else if (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) stops = rgb(cs.backgroundColor);
      el = el.parentElement;
    }
    return { text: rgb(getComputedStyle(a).color)[0], stops };
  });
  const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  expect(stops.length, 'no background found behind the link').toBeGreaterThan(0);
  const worst = Math.min(...stops.map((st) => ratio(text, st)));
  expect(worst, `lowest contrast of the link against the gradient (text rgb(${text}))`).toBeGreaterThanOrEqual(4.5);
});
