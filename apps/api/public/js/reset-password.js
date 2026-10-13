/* Password reset page (the link emailed by POST /api/auth/forgot-password). [F12]
   The token is read once and removed from the address bar immediately, so it does not stay
   in history, bookmarks, screenshots or a Referer header (the page also sets no-referrer). */
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

  if (!token) {
    form.style.display = 'none';
    showError('This reset link is incomplete. Please request a new password reset from the sign-in page.');
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
