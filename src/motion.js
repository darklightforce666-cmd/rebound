/* Motion preferences never read or modify wallet or reward state. */
(() => {
  'use strict';
  const preferenceKey = 'rebound.motion.paused';
  const systemPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const rain = document.querySelector('.sol-rain');
  const lanes = [5,17,29,42,54,67,79,93,12,86];
  if (rain) lanes.forEach((x, index) => {
    const piece = document.createElement('span');
    piece.className = 'sol-fragment';
    piece.style.cssText = `--x:${x}%;--duration:${24 + index % 4 * 5}s;--delay:-${index * 5.7 + 3}s;--size:${18 + index % 3 * 8}px;--drift:${index % 2 ? -32 : 26}px;--turn:${index % 2 ? 25 : -35}deg`;
    piece.innerHTML = '<svg viewBox="0 0 32 28" focusable="false"><use href="#sol-symbol"/></svg>';
    rain.append(piece);
  });
  let paused = false;
  try { paused = localStorage.getItem(preferenceKey) === 'true'; } catch {}
  const footerLinks = document.querySelector('.footer-top>div');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'text-button motion-toggle';
  function update() {
    const disabled = paused || systemPreference.matches;
    document.body.dataset.motion = disabled ? 'paused' : 'playing';
    toggle.textContent = disabled ? 'Motion paused' : 'Pause motion';
    toggle.setAttribute('aria-pressed', String(disabled));
    toggle.setAttribute('aria-label', systemPreference.matches ? 'Motion paused by your device settings' : paused ? 'Resume background motion' : 'Pause background motion');
    toggle.disabled = systemPreference.matches;
  }
  toggle.addEventListener('click', () => {
    paused = !paused;
    try { localStorage.setItem(preferenceKey, String(paused)); } catch {}
    update();
  });
  footerLinks?.append(toggle);
  systemPreference.addEventListener('change', update);
  function visibility() { document.body.toggleAttribute('data-motion-idle', document.hidden); }
  document.addEventListener('visibilitychange', visibility);
  visibility();
  update();
  // Pause decorative hero layers once they leave the viewport.
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting);
    });
    function observeHero() {
      observer.disconnect();
      const hero = document.querySelector('.hero');
      if (hero) observer.observe(hero);
    }
    observeHero();
    const main = document.querySelector('#main');
    if (main) new MutationObserver(observeHero).observe(main, { childList: true });
  }
})();
