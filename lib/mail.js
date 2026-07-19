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

// Whether real delivery is possible (Brevo configured). Callers that must not
// silently black-hole a message into the in-memory outbox — the contact form
// (#224) fails loud in production when this is false — check it before sending.
function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
}

// `replyTo` (optional) sets the Reply-To header so the operator can answer the
// original sender directly — used by the contact form (#224) to route replies
// to the visitor. Ignored by the account flows, which don't pass it.
async function send({ to, subject, text, replyTo }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    // Only record replyTo when set, so an entry without it still deep-equals
    // { to, subject, text } (test/mail.test.js relies on the exact shape).
    outbox.push({ to, subject, text, ...(replyTo ? { replyTo } : {}) });
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
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`mail_send_failed: HTTP ${res.status}`);
  return { delivered: true };
}

module.exports = { send, isConfigured, outbox };
