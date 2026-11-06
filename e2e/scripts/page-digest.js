'use strict';

/**
 * `npm run audit:digest` (repository root).
 *
 * A compact digest of every page in apps/api/public, for reviews and audits
 * (docs/AUDIT_PLAYBOOK.md): the static markup without styles or svg paths, the user-facing
 * strings inside its scripts, its function names and its API calls. About a fifth of the size
 * of the pages. An AI reviewer that loads whole pages runs out of its usage limit within
 * minutes; a human gets a quick map of a page.
 *
 * Output: e2e/reports/page-digest/<page>.txt (git-ignored).
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC = path.join(REPO, 'apps', 'api', 'public');
const OUT = path.join(REPO, 'e2e', 'reports', 'page-digest');

/** Strings in a script that read like text for a person, not code, CSS or a selector. */
function userStrings(scripts) {
  const strings = new Set();
  for (const m of scripts.matchAll(/'((?:[^'\\\n]|\\.){4,200})'|"((?:[^"\\\n]|\\.){4,200})"/g)) {
    const s = (m[1] || m[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^[A-Z][a-z]|^No |\.\.\.$|…$|\?$/.test(s) && /[a-z]{3}/.test(s) && !/[{};=]|^(GET|POST|PATCH|DELETE|Content-Type|Bearer|Authorization|YYYY)/.test(s)) strings.add(s);
  }
  return [...strings];
}

function digest(file) {
  const raw = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const title = (raw.match(/<title>([^<]*)/) || [])[1] || '';
  const scripts = [...raw.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const body = (raw.match(/<body[\s\S]*<\/body>/) || [raw])[0]
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\sstyle="[^"]*"/g, '').replace(/[ \t]+/g, ' ').replace(/\r/g, '').replace(/\n\s*\n+/g, '\n').trim();
  const functions = [...new Set([...scripts.matchAll(/(?:async\s+)?function\s+([A-Za-z_]\w*)/g)].map((m) => m[1]))];
  const api = [...new Set([...scripts.matchAll(/(?:apiFetch(?:Json)?|supFetch(?:Json)?|elecFetch(?:Json)?|saFetch(?:Json)?|fetch)\(\s*['"`]([^'"`]+)/g)].map((m) => m[1]))];
  return `# ${file} — ${title}\n${raw.split('\n').length} lines, ${raw.length} bytes\n\n## Markup\n${body}\n\n## User-facing strings in scripts\n${userStrings(scripts).join('\n')}\n\n## Functions\n${functions.join(', ')}\n\n## API calls\n${api.join(', ')}\n`;
}

fs.mkdirSync(OUT, { recursive: true });
let bytes = 0;
const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
for (const f of pages) {
  const d = digest(f);
  bytes += d.length;
  fs.writeFileSync(path.join(OUT, f.replace(/\.html$/, '.txt')), d);
}
console.log(`[digest] ${pages.length} pages, ${bytes} characters, in ${path.relative(REPO, OUT)}`);
