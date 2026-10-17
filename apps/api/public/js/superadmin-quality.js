/* Super-admin Quality page. [WP-Q]
   Everything rendered from the server goes through App.esc. The production-checks stream is
   read with fetch + ReadableStream so the Authorization header is used — never a token in a
   URL, never EventSource. */
'use strict';
(function () {
  var esc = App.esc, $ = App.$;

  var token = App.getSAToken();
  var user = App.getSAUser();
  if (!token || !user || user.role !== 'SUPER_ADMIN') { App.logoutSA(); return; }
  localStorage.removeItem('selectedOrgId');
  localStorage.removeItem('selectedOrgName');
  $('userName').textContent = user.name || user.email || '';
  $('logoutBtn').addEventListener('click', function () { App.logoutSA(); });

  var PAGE_SIZE = 20;
  var page = 1;
  var ciTimer = null;

  function statusBadge(status) {
    var map = {
      passed: ['badge-success', 'Passed'],
      passed_with_not_executed: ['badge-warning', 'Passed — not everything ran'],
      failed: ['badge-danger', 'Failed']
    };
    var m = map[status] || ['badge-muted', status || 'unknown'];
    return '<span class="badge ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function checkBadge(status) {
    var cls = { PASS: 'badge-success', WARN: 'badge-warning', FAIL: 'badge-danger', SKIPPED: 'badge-muted' }[status] || 'badge-muted';
    return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
  }

  function ciBadge(run) {
    if (run.status !== 'completed') return '<span class="badge badge-info">' + esc((run.status || '').replace('_', ' ')) + '</span>';
    var cls = run.conclusion === 'success' ? 'badge-success' : run.conclusion === 'failure' ? 'badge-danger' : 'badge-muted';
    return '<span class="badge ' + cls + '">' + esc(run.conclusion || 'completed') + '</span>';
  }

  function fmtWhen(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDuration(ms) {
    if (ms == null) return '—';
    return ms < 60000 ? (Math.round(ms / 100) / 10) + ' s' : Math.floor(ms / 60000) + ' m ' + Math.round((ms % 60000) / 1000) + ' s';
  }

  var notRun = function (r) { return (r.skipped || 0) + (r.todo || 0) + (r.cancelled || 0); };

  // Only https links from the server are rendered as links.
  function safeLink(url, label) {
    return /^https:\/\//.test(url || '') ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>' : '';
  }

  // ── Latest run ──
  function renderLatest(run) {
    if (!run) {
      $('latestBadge').innerHTML = '';
      $('latestBody').innerHTML = '<p class="q-muted">No test runs recorded yet. CI posts each run here once QA_INGEST_TOKEN is configured.</p>';
      return;
    }
    $('latestBadge').innerHTML = statusBadge(run.status);
    var ne = notRun(run);
    $('latestBody').innerHTML =
      (ne > 0 ? '<div class="q-warn" role="status">NOT EXECUTED: ' + ne + ' tests — this is not a pass</div>' : '') +
      '<div class="q-counts">' +
        '<div class="q-count"><b>' + run.total + '</b><span>total</span></div>' +
        '<div class="q-count"><b>' + run.passed + '</b><span>passed</span></div>' +
        '<div class="q-count"><b>' + run.failed + '</b><span>failed</span></div>' +
        '<div class="q-count"><b>' + ne + '</b><span>not executed</span></div>' +
      '</div>' +
      '<p class="q-muted">' + esc(fmtWhen(run.createdAt)) + ' · ' + esc(run.source) + ' · ' + esc(run.ref || '—') +
      ' · ' + esc((run.commitSha || '').slice(0, 7) || '—') + ' · Node ' + esc(run.nodeVersion || '?') + ' · ' + esc(fmtDuration(run.durationMs)) +
      (run.runUrl ? ' · ' + safeLink(run.runUrl, 'open run') : '') + '</p>';
  }

  // ── Trend (hand-drawn SVG: one stacked bar per run) ──
  function renderTrend(runs) {
    if (!runs.length) { $('trendChart').innerHTML = '<p class="q-muted">No runs yet.</p>'; return; }
    var W = 600, H = 150, pad = 4;
    var max = Math.max.apply(null, runs.map(function (r) { return r.total || 1; }));
    var bw = (W - pad * 2) / runs.length;
    var bars = runs.map(function (r, i) {
      var x = pad + i * bw, w = Math.max(1, bw - 2);
      var scale = (H - 10) / max;
      var bad = (r.failed || 0) + (r.cancelled || 0), skip = (r.skipped || 0) + (r.todo || 0);
      var ok = Math.max(0, (r.passed || 0));
      var y = H, parts = '';
      [[ok, 'var(--success)'], [skip, 'var(--warning)'], [bad, 'var(--danger)']].forEach(function (p) {
        var h = p[0] * scale;
        if (h <= 0) return;
        y -= h;
        parts += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + p[1] + '"></rect>';
      });
      return '<g><title>' + esc(fmtWhen(r.createdAt) + ' — ' + r.passed + '/' + r.total + ' passed, ' + bad + ' failed/cancelled, ' + skip + ' not executed') + '</title>' + parts + '</g>';
    }).join('');
    $('trendChart').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Pass, fail and not-executed counts for the last ' + runs.length + ' runs">' + bars + '</svg>';
  }

  // ── Runs table + drill-in ──
  function renderRuns(data) {
    var body = $('runsBody');
    if (!data.runs.length) {
      body.innerHTML = '<tr><td colspan="10" class="q-muted">No runs.</td></tr>';
    } else {
      body.innerHTML = data.runs.map(function (r) {
        return '<tr data-run-id="' + esc(r.id) + '" tabindex="0">' +
          '<td>' + esc(fmtWhen(r.createdAt)) + '</td><td>' + esc(r.source) + '</td><td>' + statusBadge(r.status) + '</td>' +
          '<td>' + r.total + '</td><td>' + r.passed + '</td><td>' + r.failed + '</td><td>' + notRun(r) + '</td>' +
          '<td>' + esc(fmtDuration(r.durationMs)) + '</td><td>' + esc((r.commitSha || '').slice(0, 7) || '—') + '</td><td>' + esc(r.ref || '—') + '</td></tr>';
      }).join('');
    }
    var pages = Math.max(1, Math.ceil(data.total / data.limit));
    $('pageInfo').textContent = 'Page ' + data.page + ' of ' + pages;
    $('prevPage').disabled = data.page <= 1;
    $('nextPage').disabled = data.page >= pages;
  }

  function tableOf(headers, rows) {
    return '<div class="table-wrap"><table class="q-table"><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }

  async function showRun(id) {
    var el = $('runDetail');
    el.innerHTML = '<p class="q-muted">Loading run…</p>';
    var run = await App.saFetchJson('/superadmin/qa/runs/' + encodeURIComponent(id));
    if (!run) { el.innerHTML = '<p class="q-muted">Could not load this run.</p>'; return; }
    var d = run.details || {};
    var html = '<h3>Run ' + esc(fmtWhen(run.createdAt)) + ' ' + statusBadge(run.status) + (run.runUrl ? ' ' + safeLink(run.runUrl, 'open in GitHub') : '') + '</h3>';
    if (Array.isArray(d.tiers) && d.tiers.length) {
      html += '<h3>By tier</h3>' + tableOf(['Tier', 'Files', 'Tests', 'Passed', 'Failed', 'Cancelled', 'Skipped'],
        d.tiers.map(function (t) { return [t.tier, t.files, t.tests, t.passed, t.failed, t.cancelled, t.skipped]; }));
    }
    if (Array.isArray(d.journeys) && d.journeys.length) {
      html += '<h3>Journeys</h3>' + tableOf(['Journey', 'Project', 'Status', 'Duration'],
        d.journeys.map(function (j) { return [j.title, j.project, j.status, fmtDuration(j.durationMs)]; }));
    }
    if (Array.isArray(d.failures) && d.failures.length) {
      html += '<h3>Failures and cancellations (' + d.failures.length + ')</h3>' + d.failures.map(function (f) {
        return '<div class="q-fail"><b>' + esc(f.test) + '</b><div class="q-muted">' + esc(f.file) + ' · ' + esc(f.status) + ' · ' + esc(f.classification || '') + '</div>' + esc(f.detail || '') + '</div>';
      }).join('');
    }
    if (Array.isArray(d.files) && d.files.length) {
      html += '<h3>By file</h3>' + tableOf(['File', 'Tier', 'Tests', 'Passed', 'Failed', 'Skipped'],
        d.files.map(function (f) { return [f.file, f.tier, f.tests, f.passed, f.failed, f.skipped]; }));
    }
    el.innerHTML = html;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('runsBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-run-id]');
    if (tr) showRun(tr.getAttribute('data-run-id'));
  });
  $('runsBody').addEventListener('keydown', function (e) {
    var tr = e.target.closest('tr[data-run-id]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showRun(tr.getAttribute('data-run-id')); }
  });
  $('prevPage').addEventListener('click', function () { if (page > 1) { page--; loadRuns(); } });
  $('nextPage').addEventListener('click', function () { page++; loadRuns(); });
  $('sourceFilter').addEventListener('change', function () { page = 1; loadRuns(); loadTrend(); });

  async function loadRuns() {
    var src = $('sourceFilter').value;
    var data = await App.saFetchJson('/superadmin/qa/runs?page=' + page + '&limit=' + PAGE_SIZE + (src ? '&source=' + encodeURIComponent(src) : ''));
    if (data) renderRuns(data);
  }

  async function loadTrend() {
    var src = $('sourceFilter').value;
    var data = await App.saFetchJson('/superadmin/qa/trend?limit=30' + (src ? '&source=' + encodeURIComponent(src) : ''));
    if (!data) return;
    renderTrend(data.runs);
    renderLatest(data.runs.length ? data.runs[data.runs.length - 1] : null);
    // The trend omits ref/commit/runUrl; fetch the latest run in full for its card.
    if (data.runs.length) {
      var latest = await App.saFetchJson('/superadmin/qa/runs/' + encodeURIComponent(data.runs[data.runs.length - 1].id));
      if (latest) renderLatest(latest);
    }
  }

  // ── Live CI ──
  async function loadCi() {
    var data = await App.saFetchJson('/superadmin/qa/ci-status');
    var list = $('ciList');
    showDispatch(Boolean(data && data.dispatchEnabled));
    var active = false;
    if (!data || data.state !== 'ok') {
      list.innerHTML = '<li class="q-muted">CI status unavailable' + (data && data.reason ? ' (' + esc(data.reason) + ')' : '') + '.</li>';
    } else if (!data.runs.length) {
      list.innerHTML = '<li class="q-muted">No workflow runs.</li>';
    } else {
      list.innerHTML = data.runs.map(function (r) {
        if (r.status !== 'completed') active = true;
        return '<li>' + ciBadge(r) + '<div><b>' + esc(r.name || 'workflow') + '</b>' +
          '<span class="q-muted">' + esc(r.branch || '') + ' · ' + esc(r.event || '') + ' · ' + esc(fmtWhen(r.updated_at)) + ' · ' + esc((r.head_sha || '').slice(0, 7)) + '</span> ' +
          safeLink(r.html_url, 'open') + '</div></li>';
      }).join('');
    }
    $('ciUpdated').textContent = data && data.fetchedAt ? 'updated ' + fmtWhen(data.fetchedAt) : '';
    scheduleCi(active ? 15000 : 60000);
  }

  function scheduleCi(ms) {
    clearTimeout(ciTimer);
    if (document.hidden) return;
    ciTimer = setTimeout(loadCi, ms);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimeout(ciTimer);
    else loadCi();
  });

  // ── Production checks (NDJSON stream) ──
  $('runChecksBtn').addEventListener('click', async function () {
    var btn = this, list = $('checksList');
    btn.disabled = true; btn.textContent = 'Running…';
    list.innerHTML = '';
    try {
      var res = await App.saFetch('/superadmin/qa/checks', { method: 'POST' });
      if (!res) return;
      if (res.status === 429) { list.innerHTML = '<li class="q-muted">Checks were run moments ago — try again in 30 seconds.</li>'; return; }
      if (!res.ok || !res.body) { list.innerHTML = '<li class="q-muted">Checks could not be started.</li>'; return; }
      var reader = res.body.getReader(), decoder = new TextDecoder(), buf = '';
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split('\n'); buf = lines.pop();
        lines.forEach(function (line) {
          if (!line.trim()) return;
          var r; try { r = JSON.parse(line); } catch (e) { return; }
          if (r.done) {
            var t = r.tally || {};
            list.insertAdjacentHTML('beforeend', '<li class="q-muted">' + (r.error ? esc(r.error) : 'Done — ' + (t.PASS || 0) + ' pass, ' + (t.WARN || 0) + ' warn, ' + (t.FAIL || 0) + ' fail, ' + (t.SKIPPED || 0) + ' skipped') + '</li>');
            return;
          }
          list.insertAdjacentHTML('beforeend', '<li>' + checkBadge(r.status) + '<div><b>' + esc(r.name) + '</b><span class="q-muted">' + esc(r.detail) + '</span></div></li>');
        });
      }
    } catch (e) {
      list.insertAdjacentHTML('beforeend', '<li class="q-muted">The checks stream was interrupted.</li>');
    } finally {
      btn.disabled = false; btn.textContent = 'Run production checks';
    }
  });

  // ── Tabs: Unit & integration | End-to-end | Explorer | Design | Changes | Production ──
  // Each panel loads its data the first time it is opened. [QA-2: the last four]
  var TABS = [
    { tab: 'tabUnit', panel: 'panelUnit' },
    { tab: 'tabE2e', panel: 'panelE2e', load: function () { loadE2e(); } },
    { tab: 'tabExplorer', panel: 'panelExplorer', load: function () { loadLatest('e2e', renderExplorer, 'explorerBody'); } },
    { tab: 'tabDesign', panel: 'panelDesign', load: function () { loadLatest('e2e', renderDesign, 'designBody'); } },
    { tab: 'tabChanges', panel: 'panelChanges', load: function () { loadChanges(); } },
    { tab: 'tabProd', panel: 'panelProd', load: function () { loadProd(); } }
  ];
  function selectTab(index) {
    TABS.forEach(function (t, i) {
      var on = i === index;
      $(t.tab).setAttribute('aria-selected', String(on));
      $(t.tab).tabIndex = on ? 0 : -1;
      $(t.panel).hidden = !on;
    });
    var t = TABS[index];
    if (t.load && !t.loaded) { t.loaded = true; t.load(); }
  }
  TABS.forEach(function (t, i) {
    $(t.tab).addEventListener('click', function () { selectTab(i); });
    $(t.tab).addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      selectTab(next);
      $(TABS[next].tab).focus();
    });
  });

  /** The newest run of a source, with its details, rendered by `render` into `bodyId`. */
  async function loadLatest(source, render, bodyId) {
    $(bodyId).innerHTML = '<div class="skeleton skeleton-card"></div>';
    var list = await App.saFetchJson('/superadmin/qa/runs?source=' + encodeURIComponent(source) + '&limit=1');
    if (!list) { $(bodyId).innerHTML = '<p class="q-muted">Could not load the runs.</p>'; return; }
    if (!list.runs.length) { render(null); return; }
    var run = await App.saFetchJson('/superadmin/qa/runs/' + encodeURIComponent(list.runs[0].id));
    render(run || list.runs[0]);
  }

  function runMeta(run) {
    return '<p class="q-muted">' + esc(fmtWhen(run.createdAt)) + ' · ' + esc(run.ref || '—') + ' · ' + esc((run.commitSha || '').slice(0, 7) || '—') +
      (run.runUrl ? ' · ' + safeLink(run.runUrl, 'open run') : '') + '</p>';
  }
  function countsRow(items) {
    return '<div class="q-counts">' + items.map(function (c) { return '<div class="q-count"><b>' + esc(c[0]) + '</b><span>' + esc(c[1]) + '</span></div>'; }).join('') + '</div>';
  }
  function table(headers, rows) {
    return '<div class="table-wrap"><table class="q-table"><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  var td = function (v, wrap) { return '<td' + (wrap ? ' style="white-space:normal"' : '') + '>' + esc(v == null || v === '' ? '—' : v) + '</td>'; };

  // ── Explorer (details.explorer of the latest e2e run) ──
  function renderExplorer(run) {
    var x = run && run.details && run.details.explorer;
    if (!x) {
      $('explorerBadge').innerHTML = '';
      $('explorerBody').innerHTML = '<p class="q-muted">No explorer results yet. They appear with the next end-to-end run.</p>';
      return;
    }
    var rows = [].concat(x.desktop || [], x.mobile || []);
    var failed = rows.filter(function (r) { return r.status !== 'passed'; });
    var allowed = rows.filter(function (r) { return r.allowed; });
    var forb = x.forbidden || [];
    var shown = forb.filter(function (f) { return f.shown; });
    $('explorerBadge').innerHTML = statusBadge(failed.length || shown.length ? 'failed' : 'passed');
    var html = countsRow([
      [rows.length, 'role × page × viewport'], [failed.length, 'failed'], [allowed.length, 'with allow-listed findings'],
      [forb.reduce(function (n, f) { return n + (f.checked || 0); }, 0), 'forbidden pages checked']
    ]) + runMeta(run);
    var unused = (x.allowlist && x.allowlist.unused) || [];
    if (unused.length) html += '<div class="q-warn" role="status">Allow-list entries that no longer reproduce (remove them): ' + esc(unused.join('; ')) + '</div>';
    if (shown.length) html += '<div class="q-warn" role="status">Pages shown to a role that may not open them: ' + esc(shown.map(function (f) { return f.role + ' (' + f.project + '): ' + f.shown; }).join('; ')) + '</div>';
    ['desktop', 'mobile'].forEach(function (key) {
      var list = x[key] || [];
      if (!list.length) return;
      html += '<h3>' + (key === 'desktop' ? 'Desktop' : 'Phone (Pixel 7)') + '</h3>' + table(['Role', 'Page', 'Status', 'Failed checks', 'Allow-listed', 'Links followed', 'Links failed', 'Tabs'],
        list.map(function (r) {
          return '<tr>' + td(r.role) + td(r.page) + '<td>' + e2eStatusBadge(r.status) + '</td>' + td(r.failed, true) + td(r.allowed) + td(r.links) + td(r.linkFailures) + td(r.tabs) + '</tr>';
        }));
    });
    if (forb.length) {
      html += '<h3>Forbidden pages</h3>' + table(['Viewport', 'Role', 'Pages checked', 'Shown (must be none)', 'Status'],
        forb.map(function (f) { return '<tr>' + td(f.project) + td(f.role) + td(f.checked) + td(f.shown || 'none') + '<td>' + e2eStatusBadge(f.status) + '</td></tr>'; }));
    }
    $('explorerBody').innerHTML = html;
  }

  // ── Design (visual states of the latest e2e run; the ratchets once recorded) ──
  function renderDesign(run) {
    var d = run && run.details;
    var pages = d && Array.isArray(d.pages) ? d.pages : [];
    if (!run || !pages.length) {
      $('designBadge').innerHTML = '';
      $('designBody').innerHTML = '<p class="q-muted">No design results yet. They appear with the next end-to-end run.</p>';
      return;
    }
    var by = function (v) { return pages.filter(function (p) { return p.visual === v; }); };
    var diffs = by('diff');
    var ratchets = (d.design && Array.isArray(d.design.ratchets)) ? d.design.ratchets : [];
    var worse = ratchets.filter(function (r) { return r.status === 'worse'; });
    $('designBadge').innerHTML = statusBadge(diffs.length || worse.length ? 'failed' : 'passed');
    var html = countsRow([[pages.length, 'page views'], [by('compared').length, 'match the baseline'], [diffs.length, 'differ'], [by('no-baseline').length, 'no baseline yet']]) + runMeta(run);
    if (diffs.length) {
      html += '<div class="q-warn" role="status">Visual differences: ' + esc(diffs.map(function (p) { return p.page + ' (' + p.project + ')'; }).join(', ')) +
        (run.runUrl ? ' — expected / actual / diff images: ' + safeLink(run.runUrl + '#artifacts', 'e2e-traces artifact') : '') + '</div>';
    }
    if (ratchets.length) {
      html += '<h3>Design ratchets</h3>' + table(['Ratchet', 'Now', 'Baseline', 'Status'],
        ratchets.map(function (r) { return '<tr>' + td(r.name) + td(r.count) + td(r.baseline) + '<td>' + e2eStatusBadge(r.status === 'worse' ? 'failed' : 'passed') + '</td></tr>'; }));
    }
    html += '<h3>Pages</h3>' + table(['Page', 'Viewport', 'Visual', 'Critical', 'Serious'],
      pages.map(function (p) { var a = p.axe || {}; return '<tr>' + td(p.page) + td(p.project) + td(p.visual) + td(a.critical) + td(a.serious) + '</tr>'; }));
    $('designBody').innerHTML = html;
  }

  // ── Changes (one change impact report per pull-request push) ──
  async function loadChanges() {
    $('changesBody').innerHTML = '<div class="skeleton skeleton-card"></div>';
    var data = await App.saFetchJson('/superadmin/qa/runs?source=impact&limit=20');
    if (!data) { $('changesBody').innerHTML = '<p class="q-muted">Could not load the reports.</p>'; return; }
    if (!data.runs.length) { $('changesBody').innerHTML = '<p class="q-muted">No change impact reports yet. The Change impact workflow posts one for every pull-request push.</p>'; return; }
    $('changesBody').innerHTML = table(['When', 'Branch', 'Commit', 'Affected', 'Covered', 'Not covered'],
      data.runs.map(function (r) {
        return '<tr data-impact-id="' + esc(r.id) + '" tabindex="0">' + td(fmtWhen(r.createdAt)) + td(r.ref) + td((r.commitSha || '').slice(0, 7)) + td(r.total) + td(r.passed) +
          '<td>' + (r.failed ? '<span class="badge badge-warning">' + esc(r.failed) + '</span>' : '0') + '</td></tr>';
      }));
    $('changesBody').querySelectorAll('tr[data-impact-id]').forEach(function (tr) {
      var open = function () { showImpact(tr.getAttribute('data-impact-id')); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    showImpact(data.runs[0].id);
  }
  async function showImpact(id) {
    var run = await App.saFetchJson('/superadmin/qa/runs/' + encodeURIComponent(id));
    var d = run && run.details;
    if (!d) { $('changesDetail').innerHTML = ''; return; }
    var html = '<h3>' + esc(run.ref || '—') + ' · ' + esc((run.commitSha || '').slice(0, 7) || '—') + '</h3>' + runMeta(run);
    if (Array.isArray(d.uncovered) && d.uncovered.length) html += '<div class="q-warn" role="status">Changed but not covered: ' + esc(d.uncovered.join('; ')) + '</div>';
    if (Array.isArray(d.items) && d.items.length) {
      html += table(['Kind', 'Affected', 'Covered by', 'Pages calling it'], d.items.map(function (i) {
        return '<tr>' + td(i.kind) + td(i.id, true) + (i.covered ? td(i.coveredBy) : '<td><span class="badge badge-warning">not covered</span></td>') + td(i.pages, true) + '</tr>';
      }));
    } else {
      html += '<p class="q-muted">No page, route or data change in this push.</p>';
    }
    if (Array.isArray(d.other) && d.other.length) html += '<p class="q-muted">Other files: ' + esc(d.other.join('; ')) + '</p>';
    $('changesDetail').innerHTML = html;
  }

  // ── Production (the post-deploy / nightly smoke) ──
  async function loadProd() {
    await loadLatest('prod-smoke', renderProd, 'prodBody');
  }
  function renderProd(run) {
    var d = run && run.details;
    if (!run || !d) {
      $('prodBadge').innerHTML = '';
      $('prodBody').innerHTML = '<p class="q-muted">No production smoke runs yet. The Production smoke workflow runs after every deploy and nightly.</p>';
      return;
    }
    $('prodBadge').innerHTML = statusBadge(run.status);
    var methods = d.methods || {};
    var sent = Object.keys(methods).map(function (m) { return m + ' ' + methods[m]; }).join(', ') || 'none';
    var html = countsRow([[run.total, 'checks'], [run.passed, 'passed'], [run.failed, 'failed']]) + runMeta(run) +
      '<p class="q-muted">Target: ' + esc(d.target || '—') + ' · trigger: ' + esc(run.event || '—') + ' · requests made: ' + esc(sent) + '</p>' +
      (d.readOnly === false ? '<div class="q-warn" role="status">This run attempted a request other than GET/HEAD (it was blocked, and the run failed).</div>' : '<p class="q-muted">Read-only: only GET and HEAD requests were sent.</p>');
    if (Array.isArray(d.checks) && d.checks.length) {
      html += table(['Check', 'Status', 'Detail'], d.checks.map(function (c) { return '<tr>' + td(c.check, true) + '<td>' + e2eStatusBadge(c.status) + '</td>' + td(c.detail, true) + '</tr>'; }));
    }
    $('prodBody').innerHTML = html;
  }

  // ── End-to-end: latest run (journeys, accessibility, visual) ──
  function e2eStatusBadge(s) {
    var cls = s === 'passed' ? 'badge-success' : s === 'flaky' ? 'badge-warning' : s === 'skipped' ? 'badge-muted' : 'badge-danger';
    return '<span class="badge ' + cls + '">' + esc(s || 'unknown') + '</span>';
  }

  function renderE2e(run) {
    if (!run) {
      $('e2eBadge').innerHTML = '';
      $('e2eBody').innerHTML = '<p class="q-muted">No end-to-end runs recorded yet. The E2E workflow posts each run here once QA_INGEST_TOKEN is configured.</p>';
      return;
    }
    var d = run.details || {};
    var journeys = Array.isArray(d.journeys) ? d.journeys : [];
    var pages = Array.isArray(d.pages) ? d.pages : [];
    var flaky = (d.counts && d.counts.flaky) || 0;
    $('e2eBadge').innerHTML = statusBadge(run.status);
    var html =
      '<div class="q-counts">' +
        '<div class="q-count"><b>' + run.total + '</b><span>tests</span></div>' +
        '<div class="q-count"><b>' + run.passed + '</b><span>passed</span></div>' +
        '<div class="q-count"><b>' + run.failed + '</b><span>failed</span></div>' +
        '<div class="q-count"><b>' + flaky + '</b><span>flaky</span></div>' +
      '</div>' +
      '<p class="q-muted">' + esc(fmtWhen(run.createdAt)) + ' · ' + esc(run.ref || '—') + ' · ' + esc((run.commitSha || '').slice(0, 7) || '—') +
      ' · ' + esc(fmtDuration(run.durationMs)) +
      (run.runUrl ? ' · ' + safeLink(run.runUrl, 'open run') + ' · ' + safeLink(run.runUrl + '#artifacts', 'report and traces') : '') + '</p>';

    if (journeys.length) {
      html += '<h3>Journeys</h3><div class="table-wrap"><table class="q-table"><thead><tr><th>Journey</th><th>Project</th><th>Status</th><th>Duration</th></tr></thead><tbody>' +
        journeys.map(function (j) {
          return '<tr><td style="white-space:normal">' + esc(j.title) + '</td><td>' + esc(j.project) + '</td><td>' + e2eStatusBadge(j.status) + '</td><td>' + esc(fmtDuration(j.durationMs)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (pages.length) {
      var noBaseline = pages.filter(function (p) { return p.visual === 'no-baseline'; }).length;
      var diffs = pages.filter(function (p) { return p.visual === 'diff'; });
      html += '<h3>Accessibility (axe) and visual checks</h3>' +
        (noBaseline ? '<p class="q-muted">' + noBaseline + ' page view(s) have no visual baseline yet (baselines are generated in CI on Linux).</p>' : '') +
        (diffs.length ? '<div class="q-warn" role="status">Visual differences: ' + esc(diffs.map(function (p) { return p.page + ' (' + p.project + ')'; }).join(', ')) + '</div>' : '') +
        '<div class="table-wrap"><table class="q-table"><thead><tr><th>Page</th><th>Project</th><th>Critical</th><th>Serious</th><th>Moderate</th><th>Minor</th><th>Visual</th></tr></thead><tbody>' +
        pages.map(function (p) {
          var a = p.axe || {};
          return '<tr><td>' + esc(p.page) + '</td><td>' + esc(p.project) + '</td><td>' + esc(a.critical == null ? '—' : a.critical) + '</td><td>' + esc(a.serious == null ? '—' : a.serious) +
            '</td><td>' + esc(a.moderate == null ? '—' : a.moderate) + '</td><td>' + esc(a.minor == null ? '—' : a.minor) + '</td><td>' + esc(p.visual || '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    if (Array.isArray(d.failures) && d.failures.length) {
      html += '<h3>Failures (' + d.failures.length + ')</h3>' + d.failures.map(function (f) {
        return '<div class="q-fail"><b>' + esc(f.test) + '</b><div class="q-muted">' + esc(f.file) + ' · ' + esc(f.status) + '</div>' + esc(f.detail || '') + '</div>';
      }).join('');
    }
    $('e2eBody').innerHTML = html;
  }

  async function loadE2e() {
    $('e2eBody').innerHTML = '<div class="skeleton skeleton-card"></div>';
    var list = await App.saFetchJson('/superadmin/qa/runs?source=e2e&limit=1');
    if (!list) { $('e2eBody').innerHTML = '<p class="q-muted">Could not load end-to-end runs.</p>'; return; }
    if (!list.runs.length) { renderE2e(null); return; }
    var run = await App.saFetchJson('/superadmin/qa/runs/' + encodeURIComponent(list.runs[0].id));
    renderE2e(run || list.runs[0]);
  }

  // ── "Run full test suite now" (offered only when the server has a dispatch token) ──
  function showDispatch(enabled) {
    $('dispatchBtn').hidden = !enabled;
    if (!enabled) $('dispatchNote').textContent = 'Starting the suite from here is off: the server has no GitHub dispatch token configured.';
  }

  $('dispatchBtn').addEventListener('click', async function () {
    var btn = this, msg = $('dispatchMsg');
    btn.disabled = true; btn.textContent = 'Starting…';
    msg.innerHTML = '';
    try {
      var res = await App.saFetch('/superadmin/qa/dispatch', { method: 'POST' });
      if (!res) return;
      if (res.status === 429) { msg.textContent = 'The suite was started moments ago — try again in 10 minutes.'; return; }
      if (res.status === 404) { showDispatch(false); return; }
      var body = null;
      try { body = await res.json(); } catch (e) { /* handled below */ }
      if (!body || !body.message) { msg.textContent = 'The suite could not be started.'; return; }
      if (body.state === 'started') {
        msg.innerHTML = 'Started.' + (body.url ? ' ' + safeLink(body.url, 'Follow the run') : ' It appears under Live CI shortly.');
      } else {
        msg.textContent = 'Not started: ' + body.message + '.';
      }
    } catch (e) {
      msg.textContent = 'The suite could not be started.';
    } finally {
      btn.disabled = false; btn.textContent = 'Run full test suite now';
    }
  });

  loadTrend();
  loadRuns();
  loadCi();
})();
