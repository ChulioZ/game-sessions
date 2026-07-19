'use strict';

/*
 * Public contact form (issue #224): POST /api/contact emails the operator so
 * visitors have a phone-free second communication channel (§5 DDG) alongside
 * the mandatory Impressum email, and a DSA notice-and-action channel (#140).
 *
 * Mounted BEFORE the auth gate in createApp() (next to /api/auth and
 * /api/account) so it stays reachable to unauthenticated visitors, behind its
 * own low rate limiter (contactLimiter, CONTACT_RATE_LIMIT_MAX).
 *
 * Fails LOUD, unlike the account flows' sendSafe (which log-and-continue so
 * registration never 500s on a mail hiccup): a lost contact message defeats the
 * legal purpose, so a send() error returns 502 with the fallback operator email,
 * and in production with mail unconfigured the route refuses to report a fake
 * success via the in-memory outbox (which is lost on restart).
 */

const express = require('express');
const { z } = require('zod');
const mail = require('../lib/mail');
const { validateBody } = require('../lib/validate');
const { logger } = require('../lib/observability');

const router = express.Router();

// Backtracking-safe email regex (same as routes/account.js): the domain labels
// exclude '.', so the match is linear even on hostile input; the schema
// length-guards first (CodeQL js/polynomial-redos).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Message/subject/name are capped so a single POST can't ship an unbounded blob.
const contactSchema = z.object({
  name: z.string().max(200).optional(),
  email: z.string().max(254).regex(EMAIL_RE, 'invalid_email'),
  subject: z.string().max(200).optional(),
  message: z.string().trim().min(1, 'message_required').max(5000, 'message_too_long'),
});

// Where contact mail is delivered. CONTACT_TO, falling back to MAIL_FROM (the
// verified sender) so a deployment that set up account mail already has a
// destination without a second env var.
const contactTo = () => process.env.CONTACT_TO || process.env.MAIL_FROM || '';

router.post('/', async (req, res) => {
  // Honeypot: the form ships a hidden `website` field real users never fill.
  // A non-empty value means a bot — answer a fake success (no signal) and never
  // send. Checked before validation so a bot learns nothing about the schema.
  if (String((req.body || {}).website || '').trim() !== '') {
    logger.info({ event: 'contact_honeypot' });
    return res.json({ ok: true });
  }

  const body = validateBody(contactSchema, req, res);
  if (!body) return; // 400 already sent

  // Fail loud rather than black-hole into the outbox: in production, delivery
  // must actually be possible or the "reachable channel" guarantee is a lie.
  if (process.env.NODE_ENV === 'production' && !mail.isConfigured()) {
    logger.error({ event: 'contact_mail_unconfigured' });
    return res.status(502).json({ error: 'contact_unavailable', fallbackEmail: contactTo() || undefined });
  }

  const to = contactTo();
  const name = (body.name || '').trim();
  const subject = (body.subject || '').trim();
  const text = [
    `Von: ${name ? `${name} <${body.email}>` : body.email}`,
    subject ? `Betreff: ${subject}` : null,
    '',
    body.message,
  ].filter((l) => l !== null).join('\n');

  try {
    await mail.send({
      to,
      subject: subject ? `[Kontakt] ${subject}` : '[Kontakt] Neue Nachricht',
      text,
      // Reply-To the visitor so the operator answers them directly.
      replyTo: body.email,
    });
  } catch (e) {
    logger.error({ event: 'contact_mail_failed', message: e.message });
    return res.status(502).json({ error: 'contact_unavailable', fallbackEmail: to || undefined });
  }
  res.json({ ok: true });
});

module.exports = router;
