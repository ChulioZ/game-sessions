'use strict';

/*
 * Shared request-body validation (issue #213). Runs a zod schema against a
 * request body and, on failure, replies with the app's existing
 * `{ error: <message> }` 400 shape — English server-side per CLAUDE.md's i18n
 * convention (client-side validation stays localized). The message is the first
 * zod issue's `message`, so schemas carry the exact strings the routes used to
 * emit by hand (e.g. `'Title is missing'`, `'invalid_email'`).
 *
 * Returns the parsed/normalized data on success, or `null` after having sent
 * the 400 — so handlers stay thin and read like the old inline checks:
 *
 *   const body = validateBody(schema, req, res);
 *   if (!body) return;                 // 400 already sent
 *   // ...use body.title, body.minPlayers, ...
 *
 * All bodies here parse to plain objects, so a `null` return is unambiguous.
 * Colocate the schema in the router file (one router per resource, CLAUDE.md).
 */
function validateBody(schema, req, res) {
  const result = schema.safeParse(req.body || {});
  if (result.success) return result.data;
  res.status(400).json({ error: result.error.issues[0].message });
  return null;
}

module.exports = { validateBody };
