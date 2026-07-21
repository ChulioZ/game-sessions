'use strict';

/*
 * Standalone contact page script (issue #224). NOT part of the SPA's shared
 * global scope — wrapped in an IIFE so it declares no top-level names and needs
 * no entry in eslint.config.js's frontendGlobals (like js/login.js). Bilingual
 * in-page (DE authoritative + EN); the language follows the same `locale`
 * localStorage key the SPA uses, with an in-page DE/EN toggle. Posts JSON to the
 * public POST /api/contact endpoint and renders success/error states.
 */
(function () {
  const STR = {
    de: {
      docTitle: 'Kontakt · Spielwirbel',
      title: 'Kontakt',
      intro: 'Schreib uns über dieses Formular — wir antworten dir per E-Mail.',
      name: 'Name (optional)',
      email: 'E-Mail (für unsere Antwort)',
      subject: 'Betreff (optional)',
      message: 'Nachricht',
      submit: 'Senden',
      sending: 'Wird gesendet …',
      ok: 'Danke! Deine Nachricht wurde gesendet.',
      errValidation: 'Bitte gib eine gültige E-Mail-Adresse und eine Nachricht ein.',
      errRate: 'Zu viele Anfragen. Bitte versuche es später noch einmal.',
      errGeneric: 'Senden fehlgeschlagen. Bitte versuche es später noch einmal.',
      errFallback: 'Senden fehlgeschlagen. Du erreichst uns direkt unter {email}.',
      unavailable: 'Dieses Formular ist noch nicht freigeschaltet. Bitte versuche es später noch einmal.',
      back: '← Zur App',
    },
    en: {
      docTitle: 'Contact · Spielwirbel',
      title: 'Contact',
      intro: 'Write to us with this form — we reply by e-mail.',
      name: 'Name (optional)',
      email: 'E-mail (for our reply)',
      subject: 'Subject (optional)',
      message: 'Message',
      submit: 'Send',
      sending: 'Sending …',
      ok: 'Thanks! Your message has been sent.',
      errValidation: 'Please enter a valid e-mail address and a message.',
      errRate: 'Too many requests. Please try again later.',
      errGeneric: 'Sending failed. Please try again later.',
      errFallback: 'Sending failed. You can reach us directly at {email}.',
      unavailable: 'This form is not available yet. Please try again later.',
      back: '← Back to the app',
    },
  };

  const form = document.getElementById('contactForm');
  const okEl = document.getElementById('ok');
  const errEl = document.getElementById('err');
  const button = document.getElementById('t-submit');
  const fields = {
    name: document.getElementById('name'),
    email: document.getElementById('email'),
    subject: document.getElementById('subject'),
    message: document.getElementById('message'),
    website: document.getElementById('website'),
  };

  // Resolve the display language: saved SPA choice -> system -> DE (this legal
  // page is DE-authoritative, so it falls back to German, not English).
  function resolveLang() {
    const saved = localStorage.getItem('locale');
    if (saved === 'de' || saved === 'en') return saved;
    const sys = (navigator.language || 'de').slice(0, 2).toLowerCase();
    return sys === 'en' ? 'en' : 'de';
  }

  let lang = resolveLang();

  // Flipped by the /api/config probe below when the channel is not configured
  // yet (mail unset / Impressum address missing — the same all-or-nothing gate
  // that hides the site footer). The intro then carries the notice, so a
  // language toggle keeps showing it.
  let available = true;

  function applyLang() {
    const s = STR[lang];
    document.documentElement.lang = lang;
    document.title = s.docTitle;
    document.getElementById('t-title').textContent = s.title;
    document.getElementById('t-intro').textContent = available ? s.intro : s.unavailable;
    document.getElementById('t-name-label').textContent = s.name;
    document.getElementById('t-email-label').textContent = s.email;
    document.getElementById('t-subject-label').textContent = s.subject;
    document.getElementById('t-message-label').textContent = s.message;
    button.textContent = s.submit;
    document.getElementById('t-back').textContent = s.back;
    document.querySelectorAll('.langs button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
  }

  document.querySelectorAll('.langs button').forEach((b) => {
    b.addEventListener('click', () => {
      lang = b.dataset.lang;
      localStorage.setItem('locale', lang);
      applyLang();
    });
  });

  function showError(text) {
    okEl.hidden = true;
    errEl.textContent = text;
    errEl.hidden = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    okEl.hidden = true;
    errEl.hidden = true;
    const s = STR[lang];

    const email = fields.email.value.trim();
    const message = fields.message.value.trim();
    if (!email || !message) {
      showError(s.errValidation);
      return;
    }

    button.disabled = true;
    button.textContent = s.sending;
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fields.name.value.trim(),
          email,
          subject: fields.subject.value.trim(),
          message,
          website: fields.website.value, // honeypot (empty for real users)
        }),
      });
      if (res.ok) {
        form.reset();
        errEl.hidden = true;
        okEl.textContent = s.ok;
        okEl.hidden = false;
      } else if (res.status === 429) {
        showError(s.errRate);
      } else if (res.status === 400) {
        showError(s.errValidation);
      } else if (res.status === 502) {
        const body = await res.json().catch(() => ({}));
        showError(body.fallbackEmail ? s.errFallback.replace('{email}', body.fallbackEmail) : s.errGeneric);
      } else {
        showError(s.errGeneric);
      }
    } catch {
      showError(STR[lang].errGeneric);
    } finally {
      button.disabled = false;
      button.textContent = STR[lang].submit;
    }
  });

  applyLang();

  // Availability gate (#224): a direct visit while the channel cannot deliver
  // yet should say so up front instead of offering a form whose submit can only
  // fail. On any probe error the form stays usable — the server-side fail-loud
  // 502 still catches a genuinely broken send.
  fetch('/api/config')
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (cfg && !cfg.footer) {
        available = false;
        document.getElementById('formFields').hidden = true;
        // The legal routes 404 in this state (#134) — hide their links too.
        document.getElementById('legalLinks').hidden = true;
        applyLang();
      }
    })
    .catch(() => {});
})();
