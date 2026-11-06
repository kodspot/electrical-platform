/* ========================================================================
   CUSTOM SELECT — Styled dropdown replacement for native <select>
   Auto-enhances all .form-select elements on page load.
   Keeps native <select> synced for form submission & JS .value access.
   Supports dynamic option changes via MutationObserver.
   ======================================================================== */
'use strict';
(function () {
  var _openDropdown = null; // track currently open dropdown

  function initCustomSelects() {
    document.querySelectorAll('select.form-select').forEach(function (sel) {
      if (sel._csInit) return; // already enhanced
      sel._csInit = true;
      enhance(sel);
    });
  }

  function enhance(sel) {
    // Wrap the native select
    var wrap = document.createElement('div');
    wrap.className = 'cs-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);

    // Transfer sizing/layout classes from select to wrapper so page-specific CSS
    // rules (e.g. .sv-sort, .cr-filter-sel, .tk-filter-sel) apply to the wrapper
    var extraClasses = [];
    sel.classList.forEach(function (cls) {
      if (cls !== 'form-select' && cls !== 'cs-native-hidden') extraClasses.push(cls);
    });
    extraClasses.forEach(function (cls) { wrap.classList.add(cls); });

    // Copy relevant inline styles
    if (sel.style.cssText) wrap.style.cssText = sel.style.cssText;

    // Create trigger button
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (sel.id) trigger.setAttribute('aria-controls', 'cs-list-' + sel.id);
    if (sel.disabled) trigger.disabled = true;

    var triggerText = document.createElement('span');
    triggerText.className = 'cs-trigger-text';
    trigger.appendChild(triggerText);

    // Chevron SVG
    var chevron = document.createElement('span');
    chevron.className = 'cs-chevron';
    chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    trigger.appendChild(chevron);

    wrap.appendChild(trigger);

    // Create dropdown panel
    var dropdown = document.createElement('div');
    dropdown.className = 'cs-dropdown';
    dropdown.setAttribute('role', 'listbox');
    if (sel.id) dropdown.id = 'cs-list-' + sel.id;
    wrap.appendChild(dropdown);

    // Hide native select visually (keep in DOM for forms)
    sel.setAttribute('tabindex', '-1');
    sel.setAttribute('aria-hidden', 'true');
    sel.classList.add('cs-native-hidden');

    // Build options
    function buildOptions() {
      dropdown.innerHTML = '';
      var options = sel.options;
      for (var i = 0; i < options.length; i++) {
        var opt = options[i];
        var item = document.createElement('div');
        item.className = 'cs-option';
        if (dropdown.id) item.id = dropdown.id + '-' + i;
        item.setAttribute('role', 'option');
        item.setAttribute('data-value', opt.value);
        item.textContent = opt.textContent;
        if (opt.disabled) {
          item.classList.add('cs-option-disabled');
          item.setAttribute('aria-disabled', 'true');
        }
        if (opt.selected) {
          item.classList.add('cs-option-selected');
          item.setAttribute('aria-selected', 'true');
        }
        dropdown.appendChild(item);
      }
      updateTriggerText();
    }

    // The native select is hidden from assistive technology, so its name moves to the trigger.
    function labelText() {
      var label = sel.getAttribute('aria-label');
      if (label) return label;
      var before = wrap.previousElementSibling;
      var el = (sel.labels && sel.labels[0]) || (before && before.matches('label.form-label') ? before : null);
      return el ? el.textContent.replace(/\s*\*\s*$/, '').trim() : '';
    }

    function updateTriggerText() {
      var selected = sel.options[sel.selectedIndex];
      triggerText.textContent = selected ? selected.textContent : '';
      var name = labelText() || triggerText.textContent;
      if (name) trigger.setAttribute('aria-label', name);
      // Mark trigger empty-state if placeholder option selected (value="")
      if (selected && selected.value === '') {
        trigger.classList.add('cs-placeholder');
      } else {
        trigger.classList.remove('cs-placeholder');
      }
    }

    // Toggle dropdown
    function openDropdown() {
      if (_openDropdown && _openDropdown !== wrap) closeAll();
      dropdown.classList.add('cs-open');
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.add('cs-active');
      _openDropdown = wrap;

      // If inside a modal, temporarily allow overflow so dropdown isn't clipped
      var modal = wrap.closest('.modal');
      if (modal) modal.style.overflow = 'visible';

      // Start from the selected item, as a native select does
      focusItem(Array.prototype.indexOf.call(enabledItems(), dropdown.querySelector('.cs-option-selected')));

      // Position dropdown above if not enough space below
      positionDropdown();
    }

    function closeDropdown() {
      dropdown.classList.remove('cs-open', 'cs-above', 'cs-align-right');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('cs-active');
      trigger.removeAttribute('aria-activedescendant');
      if (_openDropdown === wrap) _openDropdown = null;
      _focusIdx = -1;

      // Restore modal overflow
      var modal = wrap.closest('.modal');
      if (modal) modal.style.overflow = '';
    }

    function positionDropdown() {
      dropdown.classList.remove('cs-above', 'cs-align-right');
      var triggerRect = trigger.getBoundingClientRect();
      var spaceBelow = window.innerHeight - triggerRect.bottom;
      // If dropdown would overflow and there's more room above
      if (spaceBelow < 200 && triggerRect.top > spaceBelow) {
        dropdown.classList.add('cs-above');
      }
      // If dropdown extends past viewport right edge, align to right
      var ddRect = dropdown.getBoundingClientRect();
      if (ddRect.right > window.innerWidth - 8) {
        dropdown.classList.add('cs-align-right');
      }
    }

    // Click on trigger
    trigger.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (sel.disabled) return;
      if (dropdown.classList.contains('cs-open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    // Click on option
    dropdown.addEventListener('click', function (e) {
      var item = e.target.closest('.cs-option');
      if (!item || item.classList.contains('cs-option-disabled')) return;
      var val = item.getAttribute('data-value');
      sel.value = val; // triggers syncSelection via property setter
      closeDropdown();
      // Fire change event on native select
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Keyboard navigation
    var _focusIdx = -1;
    var _typed = '';
    var _typedAt = 0;

    function enabledItems() {
      return dropdown.querySelectorAll('.cs-option:not(.cs-option-disabled)');
    }

    function focusItem(idx) {
      var items = enabledItems();
      items.forEach(function (o) { o.classList.remove('cs-option-focus'); });
      _focusIdx = idx;
      if (idx < 0 || idx >= items.length) { trigger.removeAttribute('aria-activedescendant'); return; }
      items[idx].classList.add('cs-option-focus');
      items[idx].scrollIntoView({ block: 'nearest' });
      if (items[idx].id) trigger.setAttribute('aria-activedescendant', items[idx].id);
    }

    // Letters jump to the next option that starts with them.
    function typeAhead(key) {
      var now = Date.now();
      _typed = now - _typedAt > 700 ? key : _typed + key;
      _typedAt = now;
      var items = enabledItems();
      for (var i = 0; i < items.length; i++) {
        var at = (_focusIdx + (_typed.length === 1 ? 1 : 0) + i) % items.length;
        if (items[at].textContent.trim().toLowerCase().indexOf(_typed) === 0) { focusItem(at); return; }
      }
    }

    trigger.addEventListener('focus', updateTriggerText);
    sel.addEventListener('focus', function () { trigger.focus(); });

    trigger.addEventListener('keydown', function (e) {
      var open = dropdown.classList.contains('cs-open');
      if (e.key === 'Tab') {
        if (open) closeDropdown();
      } else if (e.key === 'Home' || e.key === 'End') {
        if (!open) return;
        e.preventDefault();
        focusItem(e.key === 'Home' ? 0 : enabledItems().length - 1);
      } else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!open) openDropdown();
        typeAhead(e.key.toLowerCase());
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (dropdown.classList.contains('cs-open')) {
          // Select focused item
          var items = enabledItems();
          if (_focusIdx >= 0 && _focusIdx < items.length) {
            items[_focusIdx].click();
          } else {
            closeDropdown();
          }
        } else {
          openDropdown();
        }
      } else if (e.key === 'Escape') {
        if (!open) return; // Escape then belongs to the modal around the select
        e.stopPropagation();
        closeDropdown();
        trigger.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!dropdown.classList.contains('cs-open')) { openDropdown(); return; }
        var items = enabledItems();
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
          focusItem(_focusIdx < items.length - 1 ? _focusIdx + 1 : 0);
        } else {
          focusItem(_focusIdx > 0 ? _focusIdx - 1 : items.length - 1);
        }
      }
    });

    // Observe native select for dynamic option changes (.innerHTML = ...)
    var observer = new MutationObserver(function () {
      buildOptions();
    });
    observer.observe(sel, { childList: true, subtree: true, characterData: true });

    // Also intercept programmatic value set on native select
    var nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', {
      get: function () { return nativeValueDesc.get.call(sel); },
      set: function (v) {
        nativeValueDesc.set.call(sel, v);
        syncSelection();
      },
      configurable: true
    });

    // Intercept selectedIndex set
    var nativeIdxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    Object.defineProperty(sel, 'selectedIndex', {
      get: function () { return nativeIdxDesc.get.call(sel); },
      set: function (v) {
        nativeIdxDesc.set.call(sel, v);
        syncSelection();
      },
      configurable: true
    });

    function syncSelection() {
      var val = nativeValueDesc.get.call(sel);
      dropdown.querySelectorAll('.cs-option').forEach(function (o) {
        if (o.getAttribute('data-value') === val) {
          o.classList.add('cs-option-selected');
          o.setAttribute('aria-selected', 'true');
        } else {
          o.classList.remove('cs-option-selected');
          o.removeAttribute('aria-selected');
        }
      });
      updateTriggerText();
    }

    // Watch for disabled changes on native select
    var attrObserver = new MutationObserver(function () {
      trigger.disabled = sel.disabled;
    });
    attrObserver.observe(sel, { attributes: true, attributeFilter: ['disabled'] });

    // Handle form reset
    var form = sel.closest('form');
    if (form) {
      form.addEventListener('reset', function () {
        setTimeout(function () { syncSelection(); }, 0);
      });
    }

    // Initial build
    buildOptions();
  }

  // Close all dropdowns on outside click
  document.addEventListener('click', function (e) {
    if (_openDropdown && !_openDropdown.contains(e.target)) {
      closeAll();
    }
  });

  // Close on scroll of parent containers (for modals), but NOT on scroll inside the dropdown itself
  document.addEventListener('scroll', function (e) {
    if (_openDropdown) {
      // Don't close if the scroll is inside the dropdown panel
      if (_openDropdown.contains(e.target)) return;
      closeAll();
    }
  }, true);

  function closeAll() {
    if (_openDropdown) {
      var dd = _openDropdown.querySelector('.cs-dropdown');
      var trig = _openDropdown.querySelector('.cs-trigger');
      if (dd) dd.classList.remove('cs-open', 'cs-above', 'cs-align-right');
      if (trig) { trig.setAttribute('aria-expanded', 'false'); trig.classList.remove('cs-active'); }
      // Restore modal overflow if dropdown was inside a modal
      var modal = _openDropdown.closest('.modal');
      if (modal) modal.style.overflow = '';
      _openDropdown = null;
    }
  }

  // Re-init for dynamically added selects (e.g. modal content)
  window._initCustomSelects = initCustomSelects;

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCustomSelects);
  } else {
    initCustomSelects();
  }
})();
