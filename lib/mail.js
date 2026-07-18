'use strict';

/*
 * Outbound transactional email (issue #135: verification, password reset;
 * later invitations, #138). Provider: Brevo (EU) via its REST API, chosen for
 * the GDPR-friendly EU processing — configured with BREVO_API_KEY + MAIL_FROM.
 *
 * Degrades gracefully when unconfigured (dev, tests, self-hosters without
 * email): send() logs the message and records it in an in-memory `outbox`
 * instead of delivering. Tests read the outbox to drive the verify/reset flows
 * — no network, no real mail, ever (the suite never sets BREVO_API_KEY).
 *
 * Uses the global fetch (like the lookup providers), so tests could also stub
 * it. Errors reject; callers decide whether delivery failure is fatal for
 * their flow (account routes log-and-continue so e.g. registration never 500s
 * on a mail hiccup).
 */

const { logger } = require('./observability');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const OUTBOX_MAX = 50;

// Dev/test capture of not-actually-sent mail (newest last, capped).
const outbox = [];

async function send({ to, subject, text }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    outbox.push({ to, subject, text });
    if (outbox.length > OUTBOX_MAX) outbox.shift();
    // Subject/recipient only — never the body, which carries tokens.
    logger.info({ event: 'mail_not_configured', to, subject });
    return { delivered: false };
  }
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM || 'no-reply@localhost', name: process.env.MAIL_FROM_NAME || 'Spieleabend' },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`mail_send_failed: HTTP ${res.status}`);
  return { delivered: true };
}

module.exports = { send, outbox };
