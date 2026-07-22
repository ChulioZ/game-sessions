/* Spielwirbel – "Support Spielwirbel" donation link (issue #173): the top-bar
   heart button and the sheet behind it. Part of the frontend's shared global
   scope; load order: see index.html.

   The button exists only when GET /api/config reports a donateUrl (initSupport
   is called from initFooter's config fetch in core.js) — an instance without
   DONATE_URL never shows it. The sheet renders ONE outbound anchor and nothing
   else: no payment code, no third-party widget/script (that would need a CSP
   widening and leak every visitor's IP on page load rather than only on click).

   Cross-file references (closeSheet/openSheet from views-round-detail.js) are
   resolved at CALL time, inside the handlers below — never at load time — so
   this file is safe to load before them
   (.claude/rules/frontend-script-load-order.md). */

'use strict';

// The donation page URL, from /api/config at boot. Module state rather than a
// data attribute so the URL never sits in the DOM before the sheet opens.
let supportUrl = null;

// The sheet: short friendly copy plus one primary CTA — a plain anchor, so the
// click is an ordinary navigation the browser (and its blockers) fully control.
function showSupport() {
  if (!supportUrl) return;
  closeSheet();
  const backdrop = h(`<div class="sheet-backdrop sheet-backdrop--center">
      <div class="sheet sheet--dialog" role="dialog" aria-modal="true" aria-label="${esc(t('support.title'))}">
        <div class="sheet__head">
          <h2>${esc(t('support.title'))}</h2>
          <button class="sheet__close" aria-label="${esc(t('common.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <p class="muted">${esc(t('support.body'))}</p>
        <p class="muted">${esc(t('support.hint'))}</p>
        <a class="btn btn--primary btn--block" id="supportCta" href="${esc(supportUrl)}"
          target="_blank" rel="noopener noreferrer">
          <i class="ti ti-heart" aria-hidden="true"></i> ${esc(t('support.cta'))}
        </a>
      </div>
    </div>`);
  const sheet = backdrop.querySelector('.sheet');
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', onKey, true);
  openSheet(backdrop, onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeSheet(); });
  sheet.querySelector('.sheet__close').addEventListener('click', closeSheet);

  const cta = sheet.querySelector('#supportCta');
  cta.focus();
  // The donation page opens in a new tab; the sheet has done its job.
  cta.addEventListener('click', () => closeSheet());
}

// Called from initFooter (core.js) once /api/config answered with a URL.
// Unhides the button; the click handler is already wired below.
function initSupport(url) {
  supportUrl = url;
  const btn = document.getElementById('supportBtn');
  if (btn) btn.hidden = false;
}

// Wire the top-bar button. An arrow, not a direct reference: showSupport is
// defined above but closeSheet/openSheet are not loaded yet at this point —
// deferring the whole call to click time is the established pattern
// (feedback.js does the same).
function setupSupportUi() {
  const btn = document.getElementById('supportBtn');
  if (btn) btn.addEventListener('click', () => showSupport());
}

setupSupportUi();
