'use strict';

/**
 * Generates docs/reference/bug-registry.generated.md from the bug registry. [platform-M4]
 * Documentation tooling (like gen-route-index.js) — the registry is the single source of
 * truth, so this doc cannot drift. Regenerate: `npm run docs:bugs` (from apps/api/).
 */

const fs = require('fs');
const path = require('path');
const registry = require('../scenarios/bugs/registry');

const OUT = path.join(__dirname, '..', '..', '..', 'docs', 'reference', 'bug-registry.generated.md');
const bugs = registry.all();

let md = `# Bug Scenario Registry (generated)

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with:  npm run docs:bugs   (from apps/api/)
     Source of truth: apps/api/scenarios/bugs/ -->

Every fixed production/engineering defect encoded as a reproducible scenario with a
regression test (platform milestone M4, see the Developer Platform Specification §6). Each
bug reuses the M3 scenario system to build its triggering state and asserts the fixed
behavior via the real app. Adding a bug: drop a module in \`apps/api/scenarios/bugs/\` and
register it — see an existing bug for the shape.

Commands: \`npm run bug:list\` · \`npm run bug:run -- <ID>\` · \`npm run bug:validate\` · \`npm run bug:test\`.

## Registry

| ID | Severity | Status | Module | Title | Regression test |
|---|---|---|---|---|---|
`;
for (const b of bugs) {
  md += `| ${b.id} | ${b.severity} | ${b.status} | ${b.module} | ${b.title} | \`${b.regressionTest}\` |\n`;
}
md += `\nCount: ${bugs.length} bug scenario(s).\n\n`;

for (const b of bugs) {
  md += `## ${b.id} — ${b.title}\n\n`;
  md += `- **Severity:** ${b.severity} · **Status:** ${b.status} · **Module:** ${b.module} · **Category:** ${b.category}\n`;
  md += `- **Origin:** ${b.origin}\n`;
  md += `- **Introduced:** ${b.dateIntroduced} · **Fixed:** ${b.dateFixed}\n`;
  md += `- **Description:** ${b.description}\n`;
  md += `- **Root cause:** ${b.rootCause}\n`;
  md += `- **Expected behavior:** ${b.expectedBehavior}\n`;
  md += `- **Broken behavior:** ${b.brokenBehavior}\n`;
  md += `- **Scenario dependencies:** ${(b.scenarioDependencies || []).join(', ') || '—'}\n`;
  md += `- **Regression test:** \`${b.regressionTest}\`\n\n`;
  md += `**Reproduction steps:**\n\n`;
  (b.reproductionSteps || []).forEach((s, i) => { md += `${i + 1}. ${s}\n`; });
  md += `\n`;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md);
console.log(`Wrote ${OUT} (${bugs.length} bug scenarios)`);
