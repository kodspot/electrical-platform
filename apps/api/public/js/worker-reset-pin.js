/* Electrician PIN reset page (the link emailed by POST /api/auth/worker-forgot-pin). [F12]
   The token is read once and removed from the address bar immediately (history.replaceState),
   and the page sets no-referrer, so it does not linger in history or leak via Referer. */
'use strict';
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  if (location.search) history.replaceState(null, '', location.pathname);

  var form = document.getElementById('resetForm');
  var errorEl = document.getElementById('error');
  var doneEl = document.getElementById('done');
  var btn = document.getElementById('btn');

  function showError(msg) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  function clearError() { errorEl.textContent = ''; errorEl.classList.remove('show'); }

  // The reset response has no org slug; ask worker-me (with the fresh session token the reset
  // returned) for it, to link to this organization's electrician sign-in page.
  async function loginPath(sessionToken) {
    try {
      var res = await fetch('/api/auth/worker-me', { headers: { Authorization: 'Bearer ' + sessionToken } });
      if (!res.ok) return '/';
      var data = await res.json();
      var slug = data.org && data.org.slug;
      if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return '/';
      var mod = (data.org.enabledModules && data.org.enabledModules[0]) || 'ele';
      return '/' + encodeURIComponent(slug) + '/' + encodeURIComponent(mod) + '/electrician-login';
    } catch (_) {
      return '/';
    }
  }

  async function finish(sessionToken) {
    form.style.display = 'none';
    var a = document.createElement('a');
    a.href = await loginPath(sessionToken);
    a.textContent = 'Go to sign in';
    a.setAttribute('data-testid', 'reset-login-link');
    doneEl.textContent = 'Your PIN has been changed. Sign in with your Employee ID and new PIN. ';
    doneEl.appendChild(a);
    doneEl.classList.add('show');
  }

  if (!token) {
    form.style.display = 'none';
    showError('This reset link is incomplete. Please request a new PIN reset from the sign-in page.');
    return;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearError();
    var pin = document.getElementById('newPin').value.trim();
    var confirm = document.getElementById('confirmPin').value.trim();
    if (!/^\d{6}$/.test(pin)) return showError('The PIN must be exactly 6 digits.');
    if (pin !== confirm) return showError('The two PINs do not match.');

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var res = await fetch('/api/auth/worker-reset-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, newPin: pin })
      });
      var data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON */ }
      if (res.ok) {
        token = '';
        return await finish(data.token);
      }
      if (res.status === 400 && /invalid or has expired/i.test(data.error || '')) {
        form.style.display = 'none';
        return showError('This reset link has expired or has already been used. Please request a new one from the sign-in page.');
      }
      if (res.status === 429) return showError('Too many attempts. Please wait a few minutes and try again.');
      showError(data.error || 'Could not reset the PIN. Please try again.');
    } catch (_) {
      showError('Network error. Please check your connection and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Set new PIN';
    }
  });
})();
