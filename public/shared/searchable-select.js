/* ── Searchable Select Component ──────────────────────────────────────────── *
 * Upgrades every <select class="agzit-select"> into a type-to-filter widget.
 * Call window.initSearchableSelects() after adding options dynamically.
 * ─────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── Build one searchable-select widget ─────────────────────────────────── */
  function buildWidget(select) {
    const dataWidth = select.dataset.width;

    /* Wrapper */
    const wrapper = document.createElement('div');
    wrapper.className = 'ss-wrapper';
    if (dataWidth) wrapper.style.width = parseInt(dataWidth, 10) + 'px';

    /* Display button */
    const display = document.createElement('div');
    display.className = 'ss-display';
    display.setAttribute('tabindex', '0');
    display.setAttribute('role', 'combobox');
    display.setAttribute('aria-haspopup', 'listbox');
    display.setAttribute('aria-expanded', 'false');

    const selText = document.createElement('span');
    selText.className = 'ss-selected-text';

    const arrow = document.createElement('span');
    arrow.className = 'ss-arrow';
    arrow.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"' +
      ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<polyline points="4 6 8 10 12 6"/></svg>';

    display.appendChild(selText);
    display.appendChild(arrow);

    /* Dropdown — appended to body for z-index / overflow safety */
    const dropdown = document.createElement('div');
    dropdown.className = 'ss-dropdown';

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'ss-search';
    search.placeholder = 'Type to search\u2026';
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('autocorrect', 'off');
    search.setAttribute('spellcheck', 'false');

    const optList = document.createElement('div');
    optList.className = 'ss-options';
    optList.setAttribute('role', 'listbox');

    dropdown.appendChild(search);
    dropdown.appendChild(optList);
    document.body.appendChild(dropdown);

    wrapper.appendChild(display);

    /* ── Helpers ─────────────────────────────────────────────────────────── */
    function getOptions() { return Array.from(select.options); }

    function setDisplayText() {
      const opts = getOptions();
      const cur  = opts.find(o => o.value === select.value);
      if (cur && cur.text.trim()) {
        selText.textContent = cur.text;
        selText.classList.remove('ss-placeholder');
      } else if (opts.length) {
        selText.textContent = opts[0].text;
        selText.classList.toggle('ss-placeholder', !opts[0].value);
      } else {
        selText.textContent = 'Select\u2026';
        selText.classList.add('ss-placeholder');
      }
    }

    function positionDropdown() {
      const rect = wrapper.getBoundingClientRect();
      dropdown.style.top   = (rect.bottom + 4) + 'px';
      dropdown.style.left  = rect.left + 'px';
      dropdown.style.width = rect.width + 'px';
    }

    function renderOptions(query) {
      optList.innerHTML = '';
      const q = (query || '').toLowerCase().trim();
      let count = 0;

      getOptions().forEach(function (opt) {
        if (opt.disabled) return;
        const text = opt.text.trim();
        const val  = opt.value;
        if (q && text.toLowerCase().indexOf(q) === -1 && val.toLowerCase().indexOf(q) === -1) return;

        const item = document.createElement('div');
        item.className = 'ss-option' + (val === select.value ? ' ss-selected' : '');
        item.textContent = text;
        item.dataset.value = val;
        item.setAttribute('role', 'option');

        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          select.value = val;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          setDisplayText();
          renderOptions('');
          close();
        });

        optList.appendChild(item);
        count++;
      });

      if (count === 0) {
        const empty = document.createElement('div');
        empty.className = 'ss-no-results';
        empty.textContent = 'No results found';
        optList.appendChild(empty);
      }
    }

    function open() {
      /* Close any other open dropdowns */
      document.querySelectorAll('.ss-wrapper.ss-active').forEach(function (w) {
        if (w !== wrapper) w.classList.remove('ss-active');
      });

      wrapper.classList.add('ss-active');
      display.setAttribute('aria-expanded', 'true');
      positionDropdown();
      search.value = '';
      renderOptions('');
      search.focus();
    }

    function close() {
      wrapper.classList.remove('ss-active');
      display.setAttribute('aria-expanded', 'false');
    }

    /* ── Event listeners ─────────────────────────────────────────────────── */
    display.addEventListener('click', function () {
      wrapper.classList.contains('ss-active') ? close() : open();
    });

    display.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      if (e.key === 'Escape') close();
    });

    search.addEventListener('input', function () { renderOptions(this.value); });

    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });

    /* Reposition on scroll / resize */
    window.addEventListener('scroll', function () {
      if (wrapper.classList.contains('ss-active')) positionDropdown();
    }, true);

    window.addEventListener('resize', function () {
      if (wrapper.classList.contains('ss-active')) positionDropdown();
    });

    /* Close on outside click */
    document.addEventListener('mousedown', function (e) {
      if (!wrapper.contains(e.target) && !dropdown.contains(e.target)) close();
    });

    /* ── Watch for dynamic option changes (e.g. template selects) ─────────── */
    const observer = new MutationObserver(function () {
      setDisplayText();
      if (wrapper.classList.contains('ss-active')) renderOptions(search.value);
    });
    observer.observe(select, { childList: true });

    /* ── Watch for programmatic value changes ────────────────────────────── */
    const origValueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (origValueDescriptor && origValueDescriptor.set) {
      const origSet = origValueDescriptor.set;
      Object.defineProperty(select, 'value', {
        get: function () { return origValueDescriptor.get.call(this); },
        set: function (v) {
          origSet.call(this, v);
          setDisplayText();
        },
      });
    }

    /* ── Initial state ───────────────────────────────────────────────────── */
    setDisplayText();
    wrapper._ssDropdown  = dropdown;
    wrapper._ssObserver  = observer;

    return wrapper;
  }

  /* ── Init / refresh a single select ────────────────────────────────────── */
  function initSelect(select) {
    select.style.cssText += ';display:none!important;';
    const wrapper = buildWidget(select);
    select.parentNode.insertBefore(wrapper, select);
    select.dataset.searchable = 'done';
    select._ssWrapper = wrapper;
  }

  function refreshSelect(select) {
    if (select._ssWrapper) {
      if (select._ssWrapper._ssObserver)  select._ssWrapper._ssObserver.disconnect();
      if (select._ssWrapper._ssDropdown)  select._ssWrapper._ssDropdown.remove();
      select._ssWrapper.remove();
      delete select._ssWrapper;
    }
    select.dataset.searchable = '';
    initSelect(select);
  }

  /* ── Public API ─────────────────────────────────────────────────────────── */
  window.initSearchableSelects = function () {
    document.querySelectorAll('select.agzit-select').forEach(function (select) {
      if (select.dataset.searchable === 'done') {
        /* Refresh if option count changed (dynamic population) */
        const wrapperOptCount = select._ssWrapper
          ? select._ssWrapper._ssDropdown.querySelectorAll('.ss-option').length
          : -1;
        if (select.options.length !== wrapperOptCount) refreshSelect(select);
        return;
      }
      initSelect(select);
    });
  };

  /* ── Auto-init on DOM ready ─────────────────────────────────────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.initSearchableSelects);
  } else {
    window.initSearchableSelects();
  }
}());
