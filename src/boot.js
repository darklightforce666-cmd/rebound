/* Boot: the loading screen (the owner's rebound-loader.html: the mark draws itself, the word hops in,
   everything launches up), then the private-preview gate. It never touches wallet or reward state. The page
   renders underneath while it plays; a click or a key skips it. It plays on every page load (≈3.8 s); with
   reduced motion it is skipped. */
(function () {
  'use strict';
  var html = document.documentElement, loader = document.getElementById('rebound-loader');
  var entry = document.getElementById('rebound-entry'), form = document.getElementById('rebound-entry-form');
  var password = document.getElementById('rebound-entry-password'), error = document.getElementById('rebound-entry-error');
  var quick = html.classList.contains('boot-quick');
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var started = Date.now(), EXIT_AT = quick ? 150 : reduced ? 200 : 3350;
  var API = '/.netlify/functions/rewards?action=';
  var gate = null; // 'open' | 'closed'

  function get(url, ms) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms || 6000);
    return fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal, cache: 'no-store' })
      .then(function (r) { clearTimeout(t); if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw Error('unavailable'); return r.json(); });
  }
  var config = get(API + 'config', 5000);

  function unlock() {
    if (document.body.classList.contains('rebound-unlocked')) return;
    if (password) password.value = '';
    document.body.classList.add('rebound-unlocked');
    window.dispatchEvent(new Event('rebound:unlocked'));
    if (entry) entry.remove();
  }
  var finishing = false;
  function finish() {
    if (!loader || finishing || gate === null) return;
    finishing = true;
    loader.classList.add('out');
    setTimeout(function () { if (loader) loader.remove(); loader = null; if (gate === 'open') { var m = document.getElementById('main'); if (m) m.focus({ preventScroll: true }); } else if (password) password.focus(); }, quick || reduced ? 250 : 450);
  }
  // Skip: any click or key once the gate is decided.
  // Fit the 520×500 stage to small screens (never scaled up).
  var stage = loader && loader.querySelector('.rbl-stage');
  function fit() { if (stage) stage.style.transform = 'scale(' + Math.min(1, (innerWidth - 32) / 520, (innerHeight - 32) / 500) + ')'; }
  fit(); window.addEventListener('resize', fit);
  if (loader) { loader.addEventListener('click', finish); window.addEventListener('keydown', function k() { finish(); window.removeEventListener('keydown', k); }); }
  // The gate: the administrator can open the site to everyone (admin dashboard → Site access).
  var decided = new Promise(function (resolve) {
    var t = setTimeout(function () { resolve('closed'); }, 4000);
    config.then(function (c) { clearTimeout(t); resolve(c && c.siteSettings && c.siteSettings.open ? 'open' : 'closed'); },
      function () { clearTimeout(t); resolve('closed'); });
  });
  decided.then(function (g) {
    gate = g;
    if (g === 'open') unlock(); else if (entry) entry.hidden = false;
    setTimeout(finish, Math.max(0, started + EXIT_AT - Date.now()));
  });

  if (form) form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (password.value !== '1111') {
      error.textContent = 'Incorrect password. Please try again.';
      password.removeAttribute('aria-invalid'); void password.offsetWidth; password.setAttribute('aria-invalid', 'true');
      password.focus(); password.select();
      return;
    }
    unlock();
    var m = document.getElementById('main'); if (m) m.focus();
  });
  if (password) password.addEventListener('input', function () { error.textContent = ''; password.removeAttribute('aria-invalid'); });
})();
