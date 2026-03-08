/* layout.js — shared nav + footer injector for app.agzit.com */
(function () {
  'use strict';

  // ── Mobile menu toggle (must be global — called from onclick in nav.html) ──
  window.agzitMobToggle = function (e) {
    if (e) e.stopPropagation();
    var menu = document.getElementById('agzit-mobile-menu');
    var btn  = document.getElementById('agzit-hamburger');
    if (!menu) return;
    var isOpen = menu.classList.toggle('open');
    if (btn) {
      btn.classList.toggle('open', isOpen);
      btn.setAttribute('aria-expanded', String(isOpen));
      btn.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
    }
    document.body.style.overflow = isOpen ? 'hidden' : '';
  };

  function mobClose() {
    var menu = document.getElementById('agzit-mobile-menu');
    var btn  = document.getElementById('agzit-hamburger');
    if (menu) { menu.classList.remove('open'); document.body.style.overflow = ''; }
    if (btn)  { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
  }

  // ── Sign-out handler ────────────────────────────────────────────────────────
  window.agzitSignOut = function () {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .finally(function () { window.location.href = 'https://agzit.com/'; });
  };

  // ── Inject HTML fragment at a position ─────────────────────────────────────
  function injectNav(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    // Insert before first child of body (nav + mobile-menu = two top-level nodes)
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    document.body.insertBefore(frag, document.body.firstChild);
  }

  function injectFooter(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    document.body.appendChild(frag);
  }

  // ── Wire up nav event handlers after DOM is ready ──────────────────────────
  function setupHandlers() {
    // Avatar button → toggle dropdown
    var avatarBtn = document.getElementById('agzit-avatar-btn');
    if (avatarBtn) {
      avatarBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var wrap   = document.getElementById('agzit-dash-wrap');
        var isOpen = wrap.classList.toggle('open');
        avatarBtn.setAttribute('aria-expanded', String(isOpen));
      });
    }

    // Sign-out buttons (desktop + mobile)
    document.querySelectorAll('.agzit-signout-btn').forEach(function (btn) {
      btn.addEventListener('click', window.agzitSignOut);
    });

    // Close dropdown on outside click
    document.addEventListener('click', function (e) {
      var dw = document.getElementById('agzit-dash-wrap');
      if (dw && !dw.contains(e.target)) {
        dw.classList.remove('open');
        var ab = document.getElementById('agzit-avatar-btn');
        if (ab) ab.setAttribute('aria-expanded', 'false');
      }
    });

    // Escape closes everything
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var dw = document.getElementById('agzit-dash-wrap');
      if (dw) dw.classList.remove('open');
      mobClose();
    });

    // Close mobile drawer when a link is tapped
    document.addEventListener('click', function (e) {
      if (e.target.closest('.agzit-mob-link, .agzit-mob-cta, .agzit-mob-sub-link')) {
        mobClose();
      }
    });
  }

  // ── Update nav DOM for a logged-in user ────────────────────────────────────
  function applyUser(user) {
    var firstName = (user.first_name || '').trim();
    if (!firstName && user.email) firstName = user.email.split('@')[0];
    firstName = firstName ? (firstName.charAt(0).toUpperCase() + firstName.slice(1)) : 'You';

    var role       = user.role || '';
    var isEmployer = role === 'dpr_employer' || role === 'verified_employer';
    var dashUrl    = isEmployer ? '/employer' : '/dashboard';
    var roleLbl    = isEmployer ? 'Employer' : 'Candidate';
    var roleColor  = isEmployer ? '#1A44C2' : '#0B7A47';
    var roleBg     = isEmployer ? '#EAF0FF' : '#E4F5EE';

    // Desktop avatar
    var initial = document.getElementById('agzit-avatar-initial');
    if (initial) initial.textContent = firstName.charAt(0).toUpperCase();

    // Desktop dropdown
    var nameEl = document.getElementById('agzit-dd-name');
    if (nameEl) nameEl.textContent = firstName;

    var badge = document.getElementById('agzit-dd-badge');
    if (badge) { badge.textContent = roleLbl; badge.style.background = roleColor === '#1A44C2' ? '#EAF0FF' : '#E4F5EE'; badge.style.color = roleColor; }

    var dashLink = document.getElementById('agzit-dd-dash');
    if (dashLink) dashLink.href = dashUrl;

    var ddIcon = document.getElementById('agzit-dd-icon');
    if (ddIcon) ddIcon.style.background = roleBg;

    // Mobile
    var mobName = document.getElementById('agzit-mob-name');
    if (mobName) mobName.textContent = firstName;

    var mobBadge = document.getElementById('agzit-mob-badge');
    if (mobBadge) { mobBadge.textContent = roleLbl; mobBadge.style.background = roleBg; mobBadge.style.color = roleColor; }

    var mobDash = document.getElementById('agzit-mob-dash');
    if (mobDash) mobDash.href = dashUrl;

    // Show logged-in UI
    var ctaOut = document.getElementById('agzit-cta-out');
    if (ctaOut) ctaOut.style.display = 'none';

    var dashWrap = document.getElementById('agzit-dash-wrap');
    if (dashWrap) dashWrap.style.display = 'block';

    var mobUserCard = document.getElementById('agzit-mob-user-card');
    if (mobUserCard) mobUserCard.style.display = 'block';

    var mobCtaOut = document.getElementById('agzit-mob-cta-out');
    if (mobCtaOut) mobCtaOut.style.display = 'none';

    var mobCtaIn = document.getElementById('agzit-mob-cta-in');
    if (mobCtaIn) mobCtaIn.style.display = '';
  }

  // ── Main init ───────────────────────────────────────────────────────────────
  function init() {
    var navFetch    = fetch('/assets/nav.html').then(function (r) { return r.text(); });
    var footerFetch = fetch('/assets/footer.html').then(function (r) { return r.text(); });

    navFetch.then(function (html) {
      injectNav(html);
      setupHandlers();

      // Auth detection — after nav is in DOM so we can update elements
      fetch('/api/auth/me', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (user) { if (user) applyUser(user); })
        .catch(function () { /* stay logged-out */ });
    });

    footerFetch.then(function (html) {
      injectFooter(html);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
