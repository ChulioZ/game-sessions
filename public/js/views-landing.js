/* Spielwirbel – logged-out landing page (issue #322): the marketing "front door"
   a cold visitor sees at GET / in accounts mode, before being asked to register.
   bootApp() (account.js) routes here for a logged-out accounts-mode visitor on
   the "/" path; every other path (deep links, /verify-email, /reset-password)
   still goes straight to the auth screens.

   Part of the frontend's shared global scope. Loads after core.js, account.js
   (showLogin/showRegister) and cover.js (coverPlaceholder), before router.js —
   see index.html. Cross-file names (showRegister/showLogin) are referenced only
   inside click handlers, i.e. at call time, per
   .claude/rules/frontend-script-load-order.md. */

'use strict';

// Feature highlight cards: [icon class, i18n key prefix]. Every icon is declared
// in the bundled tabler subset (public/fonts/tabler-icons.css) — no new codepoint
// to verify (.claude/rules/tabler-icon-codepoints.md).
const LANDING_FEATURES = [
  ['ti-cards', 'landing.features.shelf'],
  ['ti-tornado', 'landing.features.vote'],
  ['ti-trophy', 'landing.features.ratings'],
  ['ti-history', 'landing.features.chronicle'],
  ['ti-palette', 'landing.features.themes'],
  ['ti-rocket', 'landing.features.pwa'],
];

// The three how-it-works steps, numbered 1–3 in render order.
const LANDING_STEPS = ['landing.how.step1', 'landing.how.step2', 'landing.how.step3'];

// Seed strings for the decorative hero shelf. coverPlaceholder() hashes each into
// a deterministic gradient (cover.js); the strings themselves are never shown
// (the mock covers are aria-hidden and carry no title text), so these are just
// hue seeds picked from the app's own vocabulary for varied, on-theme colours.
const LANDING_SHELF = ['Spielwirbel', 'Runde', 'Session', 'Pokal', 'Chronik', 'Regal'];

// Memoized /api/config, used to gate the operator-only trust claim (below). The
// same unauthenticated endpoint initFooter() reads; cached so a language-switch
// re-render doesn't refetch.
let landingCfg = null;

// The EU-hosting claim is only true on the operator's configured public instance
// (a self-hoster on a US VPS must not publish it). Gate it on the SAME cfg.footer
// flag that reveals the legal footer links (mail + Impressum configured) — the
// element ships hidden and is revealed only when that flag is set. Degrades like
// initFooter(): any error leaves it hidden.
function landingRevealOperatorClaims(root) {
  const apply = (cfg) => {
    if (cfg && cfg.footer) {
      root.querySelectorAll('[data-operator-only]').forEach((el) => { el.hidden = false; });
    }
  };
  if (landingCfg) { apply(landingCfg); return; }
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg) landingCfg = cfg; apply(cfg); })
    .catch(() => {});
}

// The landing view. Full-screen like the auth screens (authScreen(true) hides the
// top-bar home/context/feedback; the language picker stays), but scrollable
// multi-section marketing content rather than a single centred card. Sets
// currentView so a language switch re-renders it in place (core.js langPicker).
function showLanding() {
  currentView = showLanding;
  authScreen(true);
  setContext('');
  applyBackground(null);
  app.innerHTML = '';

  const featureCards = LANDING_FEATURES.map(([icon, key]) => `
      <li class="landing-card">
        <span class="landing-card__icon"><i class="ti ${icon}" aria-hidden="true"></i></span>
        <h3 class="landing-card__title">${esc(t(key + '.title'))}</h3>
        <p class="landing-card__desc muted">${esc(t(key + '.desc'))}</p>
      </li>`).join('');

  const steps = LANDING_STEPS.map((key, i) => `
      <li class="landing-step">
        <span class="landing-step__num">${i + 1}</span>
        <div>
          <h3 class="landing-step__title">${esc(t(key + '.title'))}</h3>
          <p class="landing-step__desc muted">${esc(t(key + '.desc'))}</p>
        </div>
      </li>`).join('');

  const shelf = LANDING_SHELF.map((seed) => `
        <div class="landing-shelf__cover">${coverPlaceholder({ title: seed })}</div>`).join('');

  const view = h(`<div class="landing">
    <section class="landing-hero">
      <div class="landing-hero__text">
        <div class="landing-hero__brand">
          <i class="ti ti-tornado" aria-hidden="true"></i><span>${esc(t('app.title'))}</span>
        </div>
        <h1 class="landing-hero__title">${esc(t('landing.hero.title'))}</h1>
        <p class="landing-hero__sub">${esc(t('landing.hero.sub'))}</p>
        <div class="landing-hero__cta">
          <button class="btn btn--primary btn--lg" id="landingRegister">${esc(t('landing.hero.ctaPrimary'))}</button>
          <button class="btn btn--lg" id="landingLogin">${esc(t('landing.hero.ctaSecondary'))}</button>
        </div>
      </div>
      <div class="landing-hero__visual" aria-hidden="true">
        <div class="landing-shelf">${shelf}</div>
      </div>
    </section>

    <section class="landing-section">
      <h2 class="landing-section__title">${esc(t('landing.features.title'))}</h2>
      <ul class="landing-cards">${featureCards}</ul>
    </section>

    <section class="landing-section">
      <h2 class="landing-section__title">${esc(t('landing.how.title'))}</h2>
      <ol class="landing-steps">${steps}</ol>
    </section>

    <section class="landing-section landing-trust">
      <h2 class="landing-section__title">${esc(t('landing.trust.title'))}</h2>
      <ul class="landing-trust__chips">
        <li class="landing-chip"><i class="ti ti-heart" aria-hidden="true"></i>${esc(t('landing.trust.free'))}</li>
        <li class="landing-chip"><i class="ti ti-eye-off" aria-hidden="true"></i>${esc(t('landing.trust.noTracking'))}</li>
        <li class="landing-chip" data-operator-only hidden><i class="ti ti-shield" aria-hidden="true"></i>${esc(t('landing.trust.eu'))}</li>
      </ul>
    </section>

    <section class="landing-section landing-close">
      <h2 class="landing-section__title">${esc(t('landing.cta.title'))}</h2>
      <button class="btn btn--primary btn--lg" id="landingRegisterClose">${esc(t('landing.hero.ctaPrimary'))}</button>
    </section>
  </div>`);

  app.appendChild(view);
  view.querySelector('#landingRegister').addEventListener('click', () => showRegister());
  view.querySelector('#landingRegisterClose').addEventListener('click', () => showRegister());
  view.querySelector('#landingLogin').addEventListener('click', () => showLogin());
  landingRevealOperatorClaims(view);
}
