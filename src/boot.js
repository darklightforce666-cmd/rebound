/* Boot: the loading screen doubles as a health check (real reads only), then the private-preview gate.
   It never touches wallet or reward state. Timings: exit starts at 2.2 s and ends by 2.7 s; a repeat
   visit only fades (0.4 s). With reduced motion nothing moves; the same data is shown. */
(function () {
  'use strict';
  var html = document.documentElement, loader = document.getElementById('rebound-loader');
  var entry = document.getElementById('rebound-entry'), form = document.getElementById('rebound-entry-form');
  var password = document.getElementById('rebound-entry-password'), error = document.getElementById('rebound-entry-error');
  var quick = html.classList.contains('boot-quick');
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var started = Date.now(), EXIT_AT = quick ? 250 : reduced ? 1200 : 2200, REVEAL = quick || reduced ? [0, 0, 0, 0] : [500, 850, 1200, 1550];
  var API = '/.netlify/functions/rewards?action=', CHAIN = '/.netlify/functions/chain?action=';
  var gate = null; // 'open' | 'closed'
  try { localStorage.setItem('rebound.seen', '1'); } catch (e) {}

  function get(url, ms) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms || 6000);
    return fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal, cache: 'no-store' })
      .then(function (r) { clearTimeout(t); if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw Error('unavailable'); return r.json(); });
  }
  var mmss = function (s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  var ago = function (t) { var d = Math.max(0, Math.floor((Date.now() - new Date(t).getTime()) / 1000)); return d < 60 ? d + ' s ago' : d < 3600 ? Math.floor(d / 60) + ' min ago' : d < 86400 ? Math.floor(d / 3600) + ' h ago' : Math.floor(d / 86400) + ' d ago'; };

  // Each check line settles no earlier than its reveal time, with whatever the real read returned.
  function settle(name, promise) {
    var li = loader && loader.querySelector('[data-check="' + name + '"]');
    if (!li) return;
    var index = ['chain', 'tokens', 'round', 'payouts'].indexOf(name);
    var show = function (cls, text) {
      var wait = Math.max(0, started + REVEAL[index] - Date.now());
      setTimeout(function () { li.classList.add(cls); li.querySelector('.lc-val').textContent = text; }, wait);
    };
    promise.then(function (text) { show('done', text); }, function (e) { show('miss', e && e.message && e.message !== 'unavailable' ? e.message : 'unavailable'); });
  }

  var config = get(API + 'config', 5000);
  var primary = config.then(function (c) { return (c.siteSettings && c.siteSettings.primaryMint) || c.primaryMint || (window.ReboundConfig && window.ReboundConfig.mint); });
  if (loader && !quick) {
    settle('chain', primary.then(function (m) { return get(CHAIN + 'mint&address=' + encodeURIComponent(m), 6000); })
      .then(function (d) { if (!d.slot) throw Error('unavailable'); return 'slot ' + Number(d.slot).toLocaleString('en-US'); }));
    settle('tokens', get(API + 'tokens', 6000).then(function (r) {
      var n = (r.tokens || []).length; if (!n) return 'no tokens yet';
      return n + (r.next ? '+' : '') + (n === 1 ? ' token' : ' tokens') + ' listed';
    }));
    settle('round', Promise.all([config, primary.then(function (m) { return get(API + 'token&mint=' + encodeURIComponent(m), 6000); })]).then(function (x) {
      var c = x[0], r = x[1], cy = r.cycles && r.cycles[0];
      var ns = (c.namespaces || []).filter(function (n) { return n.namespace === r.token.namespace; })[0];
      if (!cy) return ns && ns.paused ? 'rounds paused' : 'no rounds yet';
      var left = Number(cy.scheduled_end) - (r.now || Math.floor(Date.now() / 1000));
      if (ns && ns.paused) return '#' + cy.cycle_number + ' · paused';
      var now = r.now || Math.floor(Date.now() / 1000), pre = ['scheduled', 'snapshotting', 'waiting_for_data'].indexOf(cy.state) >= 0;
      if (pre && now >= Number(cy.cutoff_time)) return '#' + Number(cy.cycle_number).toLocaleString('en-US') + ' · taking snapshot';
      return '#' + Number(cy.cycle_number).toLocaleString('en-US') + (left > 0 ? ' · ends in ' + mmss(left) : ' · settling');
    }));
    settle('payouts', get(API + 'payouts', 6000).then(function (r) {
      var p = r.payouts || []; if (!p.length) return 'no payouts yet';
      var last = p[0], same = p.filter(function (x) { return x.mint === last.mint && x.cycle_number === last.cycle_number; });
      return same.length + (same.length === 1 ? ' holder' : ' holders') + ' paid · ' + ago(last.paid_at);
    }));
  }

  function unlock() {
    if (document.body.classList.contains('rebound-unlocked')) return;
    if (password) password.value = '';
    document.body.classList.add('rebound-unlocked');
    window.dispatchEvent(new Event('rebound:unlocked'));
    if (entry) entry.remove();
  }
  function finish() {
    if (!loader) return;
    var go = function () {
      loader.classList.add('out');
      setTimeout(function () { loader.remove(); loader = null; if (gate === 'open') { var m = document.getElementById('main'); if (m) m.focus({ preventScroll: true }); } else if (password) password.focus(); }, quick ? 400 : 520);
    };
    if (reduced) { loader.remove(); loader = null; if (gate !== 'open' && password) password.focus(); return; }
    go();
  }
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
