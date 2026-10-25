/* Password reset page (the link emailed by POST /api/auth/forgot-password). [F12]
   The token is read once and removed from the address bar immediately, so it does not stay
   in history, bookmarks, screenshots or a Referer header (the page also sets no-referrer). */
'use strict';
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  // The sign-in page's "Forgot password?" passes its organization, to reset that account only.
  var org = params.get('org') || '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(org)) org = '';
  if (location.search) history.replaceState(null, '', location.pathname);

  var form = document.getElementById('resetForm');
  var errorEl = document.getElementById('error');
  var doneEl = document.getElementById('done');
  var btn = document.getElementById('btn');

  function showError(msg) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  function clearError() { errorEl.textContent = ''; errorEl.classList.remove('show'); }

  // Mirrors the server's passwordSchema (src/lib/security.js); the server still decides.
  function passwordProblem(p) {
    if (p.length < 8) return 'Password must be at least 8 characters.';
    if (p.length > 100) return 'Password must be at most 100 characters.';
    if (!/[A-Z]/.test(p)) return 'Password must contain at least one uppercase letter.';
    if (!/[a-z]/.test(p)) return 'Password must contain at least one lowercase letter.';
    if (!/\d/.test(p)) return 'Password must contain at least one number.';
    return null;
  }

  function loginPath(user) {
    if (!user) return '/';
    if (user.role === 'SUPER_ADMIN') return '/superadmin-login';
    var slug = user.orgSlug;
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return '/';
    var mod = (user.enabledModules && user.enabledModules[0]) || 'ele';
    var page = user.role === 'SUPERVISOR' ? 'supervisor-login' : 'admin-login';
    return '/' + encodeURIComponent(slug) + '/' + encodeURIComponent(mod) + '/' + page;
  }

  function finish(user) {
    form.style.display = 'none';
    var a = document.createElement('a');
    a.href = loginPath(user);
    a.textContent = 'Go to sign in';
    a.setAttribute('data-testid', 'reset-login-link');
    doneEl.textContent = 'Your password has been changed. Sign in with your new password. ';
    doneEl.appendChild(a);
    doneEl.classList.add('show');
  }

  // No token: the page was opened from "Forgot password?" (or a link was cut short), so it asks
  // for the email and requests a link. The server answers the same whether or not an account
  // matches. [BUG-0051]
  function showRequestForm() {
    var requestForm = document.getElementById('requestForm');
    var requestBtn = document.getElementById('requestBtn');
    document.getElementById('subtitle').textContent = 'Reset your password';
    requestForm.style.display = '';
    requestForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearError();
      var email = document.getElementById('email').value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Enter a valid email address.');
      var body = { email: email };
      if (org) body.orgSlug = org;
      requestBtn.disabled = true; requestBtn.textContent = 'Sending…';
      try {
        var res = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = {};
        try { data = await res.json(); } catch (_) { /* non-JSON */ }
        if (res.ok) {
          requestForm.style.display = 'none';
          doneEl.textContent = (data.message || 'If an account exists for this email, a password reset link has been sent.') +
            ' The link works once, for 1 hour. If no email arrives, ask your administrator to reset your password.';
          doneEl.classList.add('show');
          return;
        }
        if (res.status === 429) return showError('Too many attempts. Please wait a few minutes and try again.');
        showError(data.error || 'Could not send the reset link. Please try again.');
      } catch (_) {
        showError('Network error. Please check your connection and try again.');
      } finally {
        requestBtn.disabled = false; requestBtn.textContent = 'Send reset link';
      }
    });
  }

  if (!token) {
    form.style.display = 'none';
    showRequestForm();
    return;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearError();
    var pw = document.getElementById('newPassword').value;
    var confirm = document.getElementById('confirmPassword').value;
    var problem = passwordProblem(pw);
    if (problem) return showError(problem);
    if (pw !== confirm) return showError('The two passwords do not match.');

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, newPassword: pw })
      });
      var data = {};
      try { data = await res.json(); } catch (_) { /* non-JSON */ }
      if (res.ok) {
        token = '';
        return finish(data.user);
      }
      if (res.status === 400 && /invalid or has expired/i.test(data.error || '')) {
        form.style.display = 'none';
        return showError('This reset link has expired or has already been used. Please request a new one from the sign-in page.');
      }
      if (res.status === 429) return showError('Too many attempts. Please wait a few minutes and try again.');
      showError((data.details && data.details.join(' ')) || data.error || 'Could not reset the password. Please try again.');
    } catch (_) {
      showError('Network error. Please check your connection and try again.');
    } finally {
      btn.disabled = false; btn.textContent = 'Set new password';
    }
  });
})();
