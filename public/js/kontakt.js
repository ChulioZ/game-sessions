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
      reportNote: 'Auch Meldungen rechtswidriger Inhalte (Notice-and-Action, Art. 16 DSA) nimmst du über dieses Formular vor — wähle dazu unten den passenden Grund.',
      name: 'Name (optional)',
      email: 'E-Mail (für unsere Antwort)',
      emailOptional: 'E-Mail (bei dieser Meldung optional)',
      category: 'Worum geht es?',
      catGeneral: 'Allgemeine Anfrage',
      catCopyright: 'Meldung: Urheberrechtsverletzung (z. B. fremdes Cover)',
      catCsam: 'Meldung: Darstellung sexuellen Missbrauchs von Kindern',
      catHate: 'Meldung: Volksverhetzung / verbotene Kennzeichen',
      catDefamation: 'Meldung: Beleidigung / Verleumdung',
      catPrivacy: 'Meldung: Persönlichkeitsrecht / private Daten',
      catOther: 'Meldung: sonstiger rechtswidriger Inhalt',
      reportHint: 'Bitte gib möglichst die genaue Adresse (URL) des Inhalts an — oder beschreibe ihn eindeutig in der Nachricht (Konto, Runde, Spieltitel) — und begründe, warum er rechtswidrig sein soll. Den Eingang bestätigen wir per E-Mail.',
      url: 'Adresse (URL) des gemeldeten Inhalts (falls vorhanden)',
      reportedUsername: 'Nutzername des gemeldeten Kontos (falls bekannt)',
      goodFaith: 'Ich versichere in gutem Glauben, dass die Angaben in dieser Meldung nach bestem Wissen richtig und vollständig sind.',
      subject: 'Betreff (optional)',
      message: 'Nachricht',
      submit: 'Senden',
      sending: 'Wird gesendet …',
      ok: 'Danke! Deine Nachricht wurde gesendet.',
      okReport: 'Danke! Deine Meldung ist eingegangen — die Eingangsbestätigung kommt per E-Mail.',
      okReportAnon: 'Danke! Deine Meldung ist eingegangen und wird geprüft.',
      errValidation: 'Bitte gib eine gültige E-Mail-Adresse und eine Nachricht ein.',
      errGoodFaith: 'Bitte bestätige die Richtigkeit deiner Angaben.',
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
      reportNote: 'Reports of illegal content (notice and action, Art. 16 DSA) are also submitted through this form — pick the matching reason below.',
      name: 'Name (optional)',
      email: 'E-mail (for our reply)',
      emailOptional: 'E-mail (optional for this report)',
      category: 'What is this about?',
      catGeneral: 'General inquiry',
      catCopyright: 'Report: copyright infringement (e.g. someone else’s cover art)',
      catCsam: 'Report: child sexual abuse material',
      catHate: 'Report: hate speech / banned symbols',
      catDefamation: 'Report: insult / defamation',
      catPrivacy: 'Report: privacy / personal data',
      catOther: 'Report: other illegal content',
      reportHint: 'Please give the exact address (URL) of the content if possible — or describe it unambiguously in the message (account, round, game title) — and explain why you consider it illegal. We confirm receipt by e-mail.',
      url: 'Address (URL) of the reported content (if any)',
      reportedUsername: 'Username of the reported account (if known)',
      goodFaith: 'I declare in good faith that the information in this report is accurate and complete to the best of my knowledge.',
      subject: 'Subject (optional)',
      message: 'Message',
      submit: 'Send',
      sending: 'Sending …',
      ok: 'Thanks! Your message has been sent.',
      okReport: 'Thanks! Your report has been received — a confirmation is on its way by e-mail.',
      okReportAnon: 'Thanks! Your report has been received and will be reviewed.',
      errValidation: 'Please enter a valid e-mail address and a message.',
      errGoodFaith: 'Please confirm the accuracy of your report.',
      errRate: 'Too many requests. Please try again later.',
      errGeneric: 'Sending failed. Please try again later.',
      errFallback: 'Sending failed. You can reach us directly at {email}.',
      unavailable: 'This form is not available yet. Please try again later.',
      back: '← Back to the app',
    },
  };

  // Select values match the server's CATEGORIES allowlist (routes/contact.js);
  // '' is an ordinary contact message, anything else a DSA Art. 16 report.
  const CATEGORY_OPTIONS = [
    ['', 'catGeneral'],
    ['copyright', 'catCopyright'],
    ['csam', 'catCsam'],
    ['hate', 'catHate'],
    ['defamation', 'catDefamation'],
    ['privacy', 'catPrivacy'],
    ['other', 'catOther'],
  ];

  const form = document.getElementById('contactForm');
  const okEl = document.getElementById('ok');
  const errEl = document.getElementById('err');
  const button = document.getElementById('t-submit');
  const fields = {
    name: document.getElementById('name'),
    email: document.getElementById('email'),
    category: document.getElementById('category'),
    url: document.getElementById('url'),
    reportedUsername: document.getElementById('reportedUsername'),
    goodFaith: document.getElementById('goodFaith'),
    subject: document.getElementById('subject'),
    message: document.getElementById('message'),
    website: document.getElementById('website'),
  };
  const reportFields = document.getElementById('reportFields');

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

  // Reveal the Art. 16(2) report fields for a report category, and relax the
  // e-mail requirement for a CSAM report only (Art. 16(3) DSA allows those to
  // be anonymous — the server enforces the same rule).
  function applyCategory() {
    const category = fields.category.value;
    reportFields.hidden = !category;
    const anonymousOk = category === 'csam';
    fields.email.required = !anonymousOk;
    document.getElementById('t-email-label').textContent =
      anonymousOk ? STR[lang].emailOptional : STR[lang].email;
  }

  function applyLang() {
    const s = STR[lang];
    document.documentElement.lang = lang;
    document.title = s.docTitle;
    document.getElementById('t-title').textContent = s.title;
    document.getElementById('t-intro').textContent = available ? s.intro : s.unavailable;
    document.getElementById('t-report-note').textContent = available ? s.reportNote : '';
    document.getElementById('t-name-label').textContent = s.name;
    document.getElementById('t-email-label').textContent = s.email;
    document.getElementById('t-category-label').textContent = s.category;
    document.getElementById('t-report-hint').textContent = s.reportHint;
    document.getElementById('t-url-label').textContent = s.url;
    document.getElementById('t-reported-username-label').textContent = s.reportedUsername;
    document.getElementById('t-goodfaith-label').textContent = s.goodFaith;
    document.getElementById('t-subject-label').textContent = s.subject;
    document.getElementById('t-message-label').textContent = s.message;
    button.textContent = s.submit;
    document.getElementById('t-back').textContent = s.back;
    document.querySelectorAll('.langs button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    });
    // Rebuild the category options in the current language, keeping the choice.
    const chosen = fields.category.value;
    fields.category.replaceChildren();
    for (const [value, key] of CATEGORY_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = s[key];
      fields.category.appendChild(opt);
    }
    fields.category.value = chosen;
    applyCategory();
  }

  fields.category.addEventListener('change', applyCategory);

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
    const category = fields.category.value;
    // A CSAM report may be anonymous (Art. 16(3) DSA); everything else needs an
    // address — the server enforces the same pair of rules.
    if ((!email && category !== 'csam') || !message) {
      showError(s.errValidation);
      return;
    }
    if (category && !fields.goodFaith.checked) {
      showError(s.errGoodFaith);
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
          ...(category ? {
            category,
            url: fields.url.value.trim(),
            reportedUsername: fields.reportedUsername.value.trim(),
            goodFaith: fields.goodFaith.checked,
          } : {}),
          website: fields.website.value, // honeypot (empty for real users)
        }),
      });
      if (res.ok) {
        form.reset();
        applyCategory(); // reset() collapsed the category — re-hide the report fields
        errEl.hidden = true;
        okEl.textContent = category ? (email ? s.okReport : s.okReportAnon) : s.ok;
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
