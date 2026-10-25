# Frontend Architecture

The frontend is **server-rendered static HTML with vanilla JavaScript**, delivered as an
installable PWA — no build step, no SPA framework. This document explains the *patterns and
contracts* that hold the ~37 pages together. It deliberately does **not** catalog the pages
(that would just restate the filesystem under `apps/api/public/`) — pages come and go; the
patterns are what matter.

The shared client library is `apps/api/public/js/app.js` (exposed as `window.App`). Treat
its public surface as a contract; don't inventory its internals.

## Sessions: role-scoped token storage {#sessions}

Four role dashboards can be open in the same browser without clobbering each other, because
each stores its session under a **separate** localStorage key:

| Role | Token key | User key |
|---|---|---|
| Admin | `token` | `user` |
| Super-admin | `sa_token` | `sa_user` |
| Supervisor | `sup_token` | `sup_user` |
| Electrician | `elec_token` | `elec_user` |

The SuperAdmin's currently-selected org is `selectedOrgId` (with `selectedOrgName`), sent as
the `X-Org-Id` header — this is the browser side of the SA cross-tenant capability described
in [auth-and-tenancy.md](auth-and-tenancy.md#the-one-cross-tenant-capability-superadmin-x-org-id).
Each role has its own fetch helper (`apiFetch`, `saHeaders`-based fetch, `supFetch`,
`elecFetch`) that attaches the correct token; a `401` clears that role's token set and
redirects to its login, without touching the others.

## API access contract

All API calls go through `App.apiFetch(path, opts)` (and its JSON variant). This one place
owns: attaching the auth header for the active role, injecting `X-Org-Id` when a SuperAdmin
has an org selected, and handling `401` centrally. New page code calls `apiFetch` rather
than using `fetch` directly, so auth and tenant-context handling stay in a single place.
After a network error it retries GET and HEAD only (up to three attempts). A submission
(POST/PATCH/DELETE) may already have reached the server, so it is not repeated: the call
fails with "Network error" (BUG-0047). A `503` is retried for every method, because the
server's circuit breaker refused it before doing any work.

## Escaping text into markup

Pages build HTML strings from data that org admins and guests type (names, notes, titles),
and super-admins open those pages for every org. Two helpers in `public/js/app.js` cover the
two contexts:
- **`App.esc(text)`** for element content and for quoted attribute values
  (`title="…"`, `data-name="…"`, `value="…"`). It escapes `& < > " '`.
- **`App.escJs(text)`** for a JS string argument inside an inline handler, as in
  `onclick="fn('" + App.escJs(name) + "')"`. The browser HTML-decodes the attribute before
  running it, so this escapes for JS first and then for HTML.

Never pass `esc()` output to an inline handler. Text set through `textContent` or `.value`
needs no escaping. `test/public-escaping.test.js` enforces this (BUG-0028).

## Module-scoped routing & PWA {#module-scoped-routing--pwa}

Pages are served under **org-and-module-scoped URLs**: `/:orgSlug/:mod/<page>` (e.g.
`/acme/ele/admin-dashboard`), plus static top-level pages (`/`, `/superadmin-login`,
`/privacy`, …). `routes/pages.js` validates that the org slug exists and is `ACTIVE` before
serving — a suspended org's pages stop resolving, matching the backend gate
([auth-and-tenancy.md](auth-and-tenancy.md)).

Each org+module combination gets a **dynamically generated PWA manifest and service
worker** (`/:orgSlug/:mod/manifest.json`, `/:orgSlug/:mod/sw.js`), themed per module
(`MODULE_META` in `pages.js` — name, short name, color). This is why the platform installs
as a distinct app per module rather than one generic PWA.

## Offline sync contract

Field devices (electrician/supervisor) can lose connectivity mid-task, so writes are made
durable through `apps/api/public/js/offline-sync.js` (`window.KodspotSync`), an **IndexedDB
queue** (`kodspot-sync` DB):

- `enqueue({ url, method, headers, body })` stores a pending request, **stripping the
  `Authorization` header** — so a fresh token is re-attached on replay rather than a stale
  one being persisted.
- `getAll` (oldest-first), `remove(id)`, `count()`, `clearAll()` manage the queue.
- The queue survives page reloads (unlike an in-memory retry list), which is the whole
  point on an unreliable field connection.

The security-relevant contract here: **queued requests never persist a bearer token**;
authentication is re-established at replay time.

**Each request uses its own role's session.** One phone can hold several sessions, for
example a supervisor's and an admin's.
- A queued entry records the role that queued it (`scope`; `App.enqueueRetry` fills in the
  page's own role).
- A queued entry is replayed only with that role's token. If that role is not signed in, the
  entry waits.
- Photo URLs (`App.imgUrl`) carry the session of the page they are on.
- Before BUG-0054, both took the first token found. That could send a supervisor's inspection
  in as the admin.

## Static delivery & caching

Static files are served by `@fastify/static` from `public/` (`plugins/content.js`). Caddy
sets the caching policy (`infrastructure/Caddyfile`): long cache for `/css` and `/js`,
`no-store` for org-scoped admin/supervisor/superadmin pages and for every service worker and
manifest, so a client never runs a stale SW.

**When a file in `public/js/` or `public/css/` changes, bump its `?v=`.**
- Browsers keep `/js` and `/css` for a day (`max-age=86400`).
- Both service workers serve them from cache first, then refresh in the background.
- So a changed file reaches people only through a new URL.
- Bump the version on every page that loads the file, and in both precache lists:
  `public/sw.js` and the module worker in `src/routes/pages.js`. Bump both `CACHE_NAME`s too,
  so the old entries are dropped.
- `test/asset-versions.test.js` fails when the pages and the workers disagree. CSP is set by Helmet in the backend
(`plugins/security.js`), not duplicated in Caddy.

## Related

- [overview.md](overview.md) · [auth-and-tenancy.md](auth-and-tenancy.md) ·
  [module-system.md](module-system.md)
- Code: `apps/api/public/js/app.js`, `offline-sync.js`, `routes/pages.js`,
  `infrastructure/Caddyfile`
