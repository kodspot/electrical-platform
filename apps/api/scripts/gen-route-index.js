'use strict';

/**
 * Generates docs/reference/routes.generated.md from Fastify's own route table.
 *
 * This is documentation tooling, not application code — it imports the real app
 * assembly (buildApp/registerApp from index.js) so the emitted list is always exactly
 * what the server actually registers, and therefore cannot drift from the code. It does
 * not connect to the database or listen; registerApp() is side-effect-free that way.
 *
 * Run from apps/api/:   node scripts/gen-route-index.js
 * A CI step can run it and fail if the committed file differs (see docs/README.md
 * conventions: generated docs are regenerated, never hand-edited).
 */

const path = require('path');
const fs = require('fs');

async function main() {
  const { buildApp, registerApp } = require('../index');

  const fastify = buildApp({ logger: false });

  // Collect every route as it is registered. routeOptions carries the final (prefixed)
  // url and HTTP method. We deliberately do NOT emit an auth/public column: most routes
  // authenticate via an encapsulated `addHook('preHandler', authenticateJWT)` at the
  // route-file level, which does not appear in a route's own preHandler list — so auth
  // status cannot be derived reliably from the route table, and a guessed column would
  // mislead. The access model is documented in architecture/auth-and-tenancy.md.
  const routes = [];
  fastify.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    routes.push({
      methods: methods.filter((m) => m !== 'HEAD' && m !== 'OPTIONS'),
      url: r.url
    });
  });

  await registerApp(fastify);
  await fastify.ready();

  const rows = routes
    .filter((r) => r.methods.length)
    .map((r) => ({ method: r.methods.join(', '), url: r.url }))
    .sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)));

  const apiRows = rows.filter((r) => r.url.startsWith('/api'));
  const pageRows = rows.filter((r) => !r.url.startsWith('/api'));

  const table = (list) =>
    ['| Method | Path |', '|---|---|']
      .concat(list.map((r) => `| ${r.method} | \`${r.url}\` |`))
      .join('\n');

  const out = `# Route Index (generated)

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with:  node scripts/gen-route-index.js  (from apps/api/)
     Source of truth: the routes registered in apps/api/index.js and src/routes/. -->

This is the complete list of routes the server registers, emitted directly from Fastify's
route table. It is a **navigation index**, not full API documentation.

- For the **access/auth model** (who can call what), see
  [../architecture/auth-and-tenancy.md](../architecture/auth-and-tenancy.md). Auth is
  applied per route-file via an encapsulated hook, so it is intentionally not shown
  per-row here — it cannot be read reliably from the route table.
- For **request/response detail**, read the handler in \`apps/api/src/routes/\`.

Counts: ${apiRows.length} API routes, ${pageRows.length} page/other routes.

## API routes (\`/api\`)

${table(apiRows)}

## Pages & other routes

${table(pageRows)}
`;

  const outPath = path.join(__dirname, '..', '..', '..', 'docs', 'reference', 'routes.generated.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  console.log(`Wrote ${outPath} (${apiRows.length} API + ${pageRows.length} page routes)`);

  await fastify.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('Route index generation failed:', err);
  process.exit(1);
});
