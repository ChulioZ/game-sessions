'use strict';

/*
 * Public contact form (issue #224): POST /api/contact emails the operator so
 * visitors have a phone-free second communication channel (§5 DDG) alongside
 * the mandatory Impressum email, and a DSA notice-and-action channel (#140).
 *
 * Since #272 every accepted submission is ALSO stored (repo.createContactNotice,
 * the operator panel's Meldungen inbox): a lost or filtered mail must not mean
 * there is no record a notice ever arrived — Art. 16 compliance is judged on how
 * notices were handled, which presupposes knowing they exist. The form carries
 * the Art. 16(2) elicitation fields (category, reported URL, good-faith
 * statement), and a report submission gets an automatic acknowledgement mail
 * (Art. 16(4)).
 *
 * Mounted BEFORE the auth gate in createApp() (next to /api/auth and
 * /api/account) so it stays reachable to unauthenticated visitors, behind its
 * own low rate limiter (contactLimiter, CONTACT_RATE_LIMIT_MAX).
 *
 * Delivery to the operator fails LOUD, unlike the account flows' sendSafe: a
 * send() error returns 502 with the fallback operator email (the stored notice
 * is kept — storing happens first), and in production with mail unconfigured
 * the route refuses to accept at all rather than report a success nobody will
 * be notified about. The acknowledgement, by contrast, is send-safe: its
 * failure must never fail a submission that is already stored and delivered.
 */

const express = require('express');
const { z } = require('zod');
const mail = require('../lib/mail');
const repo = require('../lib/repo');
const { validateBody } = require('../lib/validate');
const { logger } = require('../lib/observability');

const router = express.Router();

// Backtracking-safe email regex (same as routes/account.js): the domain labels
// exclude '.', so the match is linear even on hostile input; the schema
// length-guards first (CodeQL js/polynomial-redos).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// The report categories mirror the Nutzungsbedingungen §5 prohibited-content
// list — each resolved notice's Art. 17 statement of reasons points back at a
// named clause there, so the intake asks in the same terms.
const REPORT_CATEGORIES = ['copyright', 'csam', 'hate', 'defamation', 'privacy', 'other'];
// 'feedback' (#321) is a category too — the top-bar feedback button opens this
// form with it preselected — but it is NOT a report: it is stored as ordinary
// product feedback (repo.createFeedback), never as a notice and never mailed.
// An absent category is a plain contact message; a report is one of the six above.
const CATEGORIES = ['feedback', ...REPORT_CATEGORIES];

// Message/subject/name/url are capped so a single POST can't ship an unbounded
// blob. The e-mail is OPTIONAL for every category since #321 (anonymous
// submission everywhere): without it there is simply no reply, and — for a
// report — no Art. 16(4)/(5) acknowledgement or decision mail, both of which
// those duties condition on contact details being present anyway.
const contactSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.preprocess(
    (v) => (String(v || '').trim() ? String(v).trim() : undefined),
    z.string().max(254).regex(EMAIL_RE, 'invalid_email').optional(),
  ),
  subject: z.string().max(200).optional(),
  message: z.string().trim().min(1, 'message_required').max(5000, 'message_too_long'),
  // '' (the form's "general" default) folds to absent; an UNKNOWN value is a
  // 400, not a silent drop — dropping would quietly demote a report to an
  // ordinary message, losing the acknowledgement and the panel's report view.
  category: z.preprocess(
    (v) => (String(v || '').trim() ? String(v).trim() : undefined),
    z.enum(CATEGORIES, { message: 'invalid_category' }).optional(),
  ),
  url: z.preprocess(
    (v) => (String(v || '').trim() ? String(v).trim() : undefined),
    z.string().max(500, 'url_too_long').optional(),
  ),
  // The reported account's public handle (#320) — usually the only thing a
  // reporter can name, since an outsider must never learn the e-mail address.
  // Capped and '' folded to absent like `url`, but deliberately NOT validated
  // against the registration username policy: a reporter may mistype or paste a
  // near-miss, and refusing the whole notice over its shape would lose a report
  // the operator can still act on. The panel resolves it; a miss just 404s.
  reportedUsername: z.preprocess(
    (v) => (String(v || '').trim() ? String(v).trim() : undefined),
    z.string().max(60, 'reported_username_too_long').optional(),
  ),
  goodFaith: z.boolean().optional(),
  // Feedback context (#321), mirroring the retired routes/feedback.js: which SPA
  // screen the message was written on, and the UI language. Both are lenient —
  // an oversized path is truncated and an unknown locale dropped, never a 400,
  // so a metadata field can't cost the message. Ignored for every non-feedback
  // submission.
  path: z.preprocess(
    (v) => String(v || '').trim().slice(0, 200),
    z.string(),
  ).optional(),
  locale: z.preprocess(
    (v) => (['de', 'en'].includes(String(v || '').toLowerCase())
      ? String(v).toLowerCase()
      : undefined),
    z.string().optional(),
  ),
});

// Where contact mail is delivered. CONTACT_TO, falling back to MAIL_FROM (the
// verified sender) so a deployment that set up account mail already has a
// destination without a second env var.
const contactTo = () => process.env.CONTACT_TO || process.env.MAIL_FROM || '';

// German labels for the operator-facing mail (the panel shares this map via its
// own copy in public/js/admin.js — the panel is German-only, #268).
const CATEGORY_LABELS = {
  copyright: 'Urheberrecht',
  csam: 'Missbrauchsdarstellungen',
  hate: 'Volksverhetzung / verbotene Kennzeichen',
  defamation: 'Beleidigung / Verleumdung',
  privacy: 'Persönlichkeitsrecht / private Daten',
  other: 'Sonstiger rechtswidriger Inhalt',
};

router.post('/', async (req, res) => {
  // Honeypot: the form ships a hidden `website` field real users never fill.
  // A non-empty value means a bot — answer a fake success (no signal), never
  // send and never store. Checked before validation so a bot learns nothing
  // about the schema.
  if (String((req.body || {}).website || '').trim() !== '') {
    logger.info({ event: 'contact_honeypot' });
    return res.json({ ok: true });
  }

  const body = validateBody(contactSchema, req, res);
  if (!body) return; // 400 already sent

  // Feedback (#321) shares this endpoint but is NOT a notice: the top-bar button
  // opens the form with this category preselected. It is stored as ordinary
  // product feedback and nothing else — no notice row, no operator mail — and so
  // handled BEFORE the production mail-unconfigured guard below (feedback never
  // needed mail to deliver). The endpoint is public/unauthenticated, so there is
  // no tenant to attribute; the e-mail is kept only when the visitor typed one.
  // Same store shape as the retired routes/feedback.js (context.path/locale),
  // minus the account identity a token-authenticated route could attach.
  if (body.category === 'feedback') {
    const entry = await repo.createFeedback({
      message: body.message,
      context: {
        path: body.path || null,
        locale: body.locale || null,
        tenantId: null,
        ...(body.email ? { email: body.email } : {}),
      },
      createdAt: new Date().toISOString(),
    });
    logger.info({ event: 'feedback_submitted', tenantId: null });
    return res.json({ ok: true, id: entry.id });
  }

  const isReport = REPORT_CATEGORIES.includes(body.category);

  // Art. 16(2)(d): a notice must carry the statement that it is made in good
  // faith and the information is accurate — the form's required checkbox. The
  // e-mail is optional for every category (see the schema comment): a report
  // without one still creates a notice and an operator mail, only without an
  // acknowledgement to send back.
  if (isReport && body.goodFaith !== true) {
    return res.status(400).json({ error: 'good_faith_required' });
  }

  // Fail loud rather than black-hole: in production, delivery must actually be
  // possible or the "reachable channel" guarantee is a lie. Checked BEFORE
  // storing — this state means the instance isn't configured yet (the form is
  // hidden client-side too), not a runtime mail hiccup.
  if (process.env.NODE_ENV === 'production' && !mail.isConfigured()) {
    logger.error({ event: 'contact_mail_unconfigured' });
    return res.status(502).json({ error: 'contact_unavailable', fallbackEmail: contactTo() || undefined });
  }

  const name = (body.name || '').trim();
  const subject = (body.subject || '').trim();

  // Store FIRST (#272): the stored row is the record that a notice arrived, so
  // a mail failure below must not lose it. Every key is present (null when
  // unset) for backend absent-key parity, like the users rows.
  const notice = await repo.createContactNotice({
    createdAt: new Date().toISOString(),
    name: name || null,
    email: body.email || null,
    subject: subject || null,
    message: body.message,
    category: body.category || null,
    url: body.url || null,
    reportedUsername: body.reportedUsername || null,
    goodFaith: isReport ? body.goodFaith === true : null,
    status: 'open',
    decidedAt: null,
    decisionNote: null,
    decisionSentAt: null,
  });

  const to = contactTo();
  const from = body.email
    ? (name ? `${name} <${body.email}>` : body.email)
    : `${name || 'anonym'} (keine E-Mail-Adresse angegeben)`;
  const text = [
    `Von: ${from}`,
    subject ? `Betreff: ${subject}` : null,
    isReport ? `Meldung: ${CATEGORY_LABELS[body.category]}` : null,
    body.url ? `Gemeldete URL: ${body.url}` : null,
    body.reportedUsername ? `Gemeldeter Nutzername: ${body.reportedUsername}` : null,
    isReport ? 'Richtigkeitserklärung (Art. 16 Abs. 2 DSA): abgegeben' : null,
    `Panel: /admin.html (Meldung ${notice.id})`,
    '',
    body.message,
  ].filter((l) => l !== null).join('\n');

  try {
    await mail.send({
      to,
      subject: `[${isReport ? 'Meldung' : 'Kontakt'}] ${subject || (isReport ? CATEGORY_LABELS[body.category] : 'Neue Nachricht')}`,
      text,
      // Reply-To the visitor so the operator answers them directly (omitted for
      // an anonymous CSAM report — there is nobody to reply to).
      ...(body.email ? { replyTo: body.email } : {}),
    });
  } catch (e) {
    // The record above survives; the visitor is still told to use the fallback
    // address so a broken mail setup can't silently swallow the channel.
    logger.error({ event: 'contact_mail_failed', message: e.message, noticeId: notice.id });
    return res.status(502).json({ error: 'contact_unavailable', fallbackEmail: to || undefined });
  }

  // Art. 16(4): confirm receipt of a notice without undue delay. Send-safe — an
  // acknowledgement failure must never fail a submission that is already stored
  // and delivered to the operator. Bilingual like the account mails: a notifier
  // can be anyone. Replies go to the operator mailbox (#307: no-reply is a real
  // alias, but the visible Reply-To keeps amendments to a notice in the loop).
  if (isReport && body.email) {
    const when = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
    await mail.send({
      to: body.email,
      subject: 'Spielwirbel: Eingangsbestätigung deiner Meldung / Confirmation of your report',
      text: `Hallo!\n\nDeine Meldung vom ${when}${body.url ? ` zu ${body.url}` : ''} ist bei uns eingegangen (Art. 16 Abs. 4 der Verordnung (EU) 2022/2065, „DSA“). Wir prüfen sie zeitnah, sorgfältig und frei von Willkür und teilen dir unsere Entscheidung mit.\n\n---\n\nHi!\n\nYour report of ${when}${body.url ? ` about ${body.url}` : ''} has been received (Art. 16(4) of Regulation (EU) 2022/2065, "DSA"). We will review it diligently and let you know our decision.\n\nSpielwirbel${to ? ` — Kontakt: ${to}` : ''}`,
      ...(to ? { replyTo: to } : {}),
    }).catch((e) => logger.warn({ event: 'contact_ack_failed', message: e.message, noticeId: notice.id }));
  }

  logger.info({ event: isReport ? 'contact_report_received' : 'contact_message_received', noticeId: notice.id });
  res.json({ ok: true });
});

module.exports = router;
