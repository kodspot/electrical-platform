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

  loadTrend();
  loadRuns();
  loadCi();
})();
