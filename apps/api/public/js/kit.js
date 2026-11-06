/* Small helpers with no dependencies, for pages with or without app.js (the complaint, review
   and reset pages do not load it). */
'use strict';
window.Kit = (function () {
  var MAX_BYTES = 1.5 * 1024 * 1024;
  var MAX_EDGE = 1600;

  /* A phone photo is often 5 MB or more, which is slow or fails on a weak signal, and the server
     refuses anything over 5 MB. Larger photos are redrawn smaller as JPEG. On any failure the
     original file is returned: the upload must never be lost because of this step. */
  function shrinkPhoto(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type) || file.size <= MAX_BYTES) return resolve(file);
      var toCanvas = function (source, width, height) {
        var scale = Math.min(1, MAX_EDGE / Math.max(width, height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob || blob.size >= file.size) return resolve(file);
          resolve(new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.8);
      };
      var viaImage = function () {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          try { toCanvas(img, img.naturalWidth, img.naturalHeight); } catch (e) { resolve(file); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      };
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (bitmap) {
          toCanvas(bitmap, bitmap.width, bitmap.height);
        }).catch(viaImage);
      } else {
        viaImage();
      }
    });
  }

  /* A Show or Hide button inside a password or PIN field. */
  function revealToggle(input) {
    if (!input || input.dataset.reveal) return;
    input.dataset.reveal = '1';
    var wrap = document.createElement('div');
    wrap.className = 'reveal-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reveal-btn';
    btn.textContent = 'Show';
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', 'Show what you typed');
    btn.addEventListener('click', function () {
      var hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      btn.textContent = hidden ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(hidden));
    });
    wrap.appendChild(btn);
  }

  /* The words to show for a failed fetch, instead of the browser's own message. */
  function friendlyError(err) {
    var name = err && err.name;
    if (name === 'TypeError' || name === 'AbortError' || name === 'SyntaxError') {
      return 'No connection. Check your signal and try again.';
    }
    return (err && err.message) || 'Something went wrong. Please try again.';
  }

  /* The words for a refused sign-in. kind: 'pin', 'password' or 'key'. */
  function signInError(status, kind, serverError) {
    if (status === 429) return 'Too many tries. Wait a few minutes and try again.';
    if (status === 401 && kind === 'pin') return 'Employee ID or PIN is wrong. Check both and try again. Forgot your PIN? Tap the link below.';
    if (status === 401 && kind === 'key') return 'That admin key is wrong. Check it and try again.';
    if (status === 401) return 'Email or password is wrong. Check both and try again.';
    return serverError || 'Something went wrong. Please try again.';
  }

  return { shrinkPhoto: shrinkPhoto, revealToggle: revealToggle, friendlyError: friendlyError, signInError: signInError };
})();
