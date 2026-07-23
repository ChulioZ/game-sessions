/* Spielwirbel – in-app feedback widget (issue #260): the top-bar button and the
   sheet behind it. Part of the frontend's shared global scope; load order: see
   index.html.

   Its own small file rather than a block inside core.js/a view, per
   .claude/rules/token-friendly-source-files.md — it is an independent concern,
   editable without touching anything else.

   Cross-file references (closeSheet/activeSheet from views-round-detail.js,
   isLoggedIn from account.js) are all resolved at CALL time, inside the handlers
   below — never at load time — so this file is safe to load before them
   (.claude/rules/frontend-script-load-order.md). */

'use strict';

// Keep in sync with MESSAGE_MAX in routes/feedback.js. The client caps first so
// an over-long message never round-trips; the server is the backstop.
const FEEDBACK_MESSAGE_MAX = 2000;

// The sheet. Anonymous by default: the identity checkbox is only rendered when
// there is an account to attach at all, and it starts unchecked — attaching is
// always a deliberate act, never the default (issue #260).
function showFeedback() {
  const canAttach = isLoggedIn();
  const backdrop = h(`<div class="sheet-backdrop sheet-backdrop--center">
      <div class="sheet sheet--dialog" role="dialog" aria-modal="true" aria-label="${esc(t('feedback.title'))}">
        <div class="sheet__head">
          <h2>${esc(t('feedback.title'))}</h2>
          <button class="sheet__close" aria-label="${esc(t('common.close'))}"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>
        <p class="muted">${esc(t('feedback.sub'))}</p>
        <div class="field">
          <label for="feedbackMessage">${esc(t('feedback.label'))}</label>
          <textarea id="feedbackMessage" class="input feedback__text" rows="5"
            maxlength="${FEEDBACK_MESSAGE_MAX}"
            placeholder="${esc(t('feedback.placeholder'))}"></textarea>
        </div>
        ${canAttach ? `<div class="field">
          <label class="feedback__opt">
            <input type="checkbox" id="feedbackAttach" />
            <span>${esc(t('feedback.attachIdentity'))}</span>
          </label>
          <div class="muted field__hint">${esc(t('feedback.attachHint'))}</div>
        </div>` : ''}
        <!-- Honeypot: off-screen and aria-hidden, so no human ever fills it in.
             Anything in it marks the submission as a bot (routes/feedback.js). -->
        <input type="text" id="feedbackWebsite" class="feedback__hp" tabindex="-1"
          autocomplete="off" aria-hidden="true" />
        <button class="btn btn--primary btn--block" id="feedbackSend">${esc(t('feedback.submit'))}</button>
      </div>
    </div>`);
  const sheet = backdrop.querySelector('.sheet');
  document.body.appendChild(backdrop);

  const onKey = (e) => { if (e.key === 'Escape') closeSheet(); };
  document.addEventListener('keydown', onKey, true);
  openSheet(backdrop, onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) closeSheet(); });
  sheet.querySelector('.sheet__close').addEventListener('click', closeSheet);

  const text = sheet.querySelector('#feedbackMessage');
  const send = sheet.querySelector('#feedbackSend');
  text.focus();

  send.addEventListener('click', async () => {
    const message = text.value.trim();
    if (!message) return toast(t('feedback.toast.needMessage'));

    // Disabled for the whole round trip so a double-click can't file it twice.
    send.disabled = true;
    try {
      await api('POST', '/api/feedback', {
        message,
        path: location.pathname,
        locale: getLocale(),
        attachIdentity: canAttach && sheet.querySelector('#feedbackAttach').checked,
        website: sheet.querySelector('#feedbackWebsite').value,
      });
      closeSheet();
      toast(t('feedback.toast.sent'));
    } catch (err) {
      // api() throws the server's error code; the low per-window cap is the one
      // an ordinary user can realistically hit, so name it rather than showing
      // the generic failure.
      toast(t(err.message === 'rate_limited' ? 'feedback.toast.rateLimited' : 'feedback.toast.error'));
      send.disabled = false;
    }
  });
}

// Wire the top-bar button. An arrow, not a direct reference: showFeedback is
// defined above but closeSheet/isLoggedIn are not loaded yet at this point —
// deferring the whole call to click time is the established pattern (core.js
// does the same for the home button).
function setupFeedbackUi() {
  const btn = document.getElementById('feedbackBtn');
  if (btn) btn.addEventListener('click', () => showFeedback());
}

setupFeedbackUi();
