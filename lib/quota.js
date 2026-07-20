'use strict';

/*
 * Per-tenant quotas & abuse controls (issue #139).
 *
 * Bounds abuse once public multi-tenant sign-up opens (#219). Three state caps:
 *   - rounds per tenant          (checked in routes/rounds.js)
 *   - games per round            (checked in routes/games.js)
 *   - tags per round             (checked in routes/tags.js, #238)
 *
 * (A fourth cap once bounded the billed buy-next recommendation spend per
 * tenant/month; it went away with the feature itself in #264.)
 *
 * Enforced ONLY in the public multi-tenant mode (accounts.accountsEnabled()).
 * With accounts off — today's single-tenant production behind the shared-password
 * gate, where every caller is the one 'default' tenant — the caps are inert, so
 * that instance is byte-for-byte unchanged and an existing group already past a
 * cap is never suddenly blocked. This mirrors how tenancy (#136) and onboarding
 * (#138) gate their behaviour, and it turns quotas on exactly when public sign-up
 * does.
 *
 * The caps are checked against current data — count the tenant's rounds / a
 * round's games / a round's tags and refuse the create at the ceiling. Deleting
 * frees the quota, which is correct for a state cap.
 *
 * All ceilings are env-overridable so a deploy can tune them without a code
 * change, and are read per call so a test — or a live re-tune — picks up the
 * current env (matches the rate-limit ceilings in lib/app.js; see
 * .claude/rules/security-middleware.md).
 */

const accounts = require('./accounts');

const DEFAULT_ROUNDS_PER_TENANT = 10;
const DEFAULT_GAMES_PER_ROUND = 1000;
const DEFAULT_TAGS_PER_ROUND = 30;

// Quotas apply only in the public multi-tenant mode; inert otherwise.
function enforced() {
  return accounts.accountsEnabled();
}

// Max rounds one tenant may own (MAX_ROUNDS_PER_TENANT, default 10).
function roundsPerTenant() {
  return Number(process.env.MAX_ROUNDS_PER_TENANT) || DEFAULT_ROUNDS_PER_TENANT;
}

// Max games (active + retired — both hold a row and a possible cover) one round
// may hold (MAX_GAMES_PER_ROUND, default 1000).
function gamesPerRound() {
  return Number(process.env.MAX_GAMES_PER_ROUND) || DEFAULT_GAMES_PER_ROUND;
}

// Max tags one round may define (MAX_TAGS_PER_ROUND, default 30).
function tagsPerRound() {
  return Number(process.env.MAX_TAGS_PER_ROUND) || DEFAULT_TAGS_PER_ROUND;
}

module.exports = {
  enforced,
  roundsPerTenant,
  gamesPerRound,
  tagsPerRound,
  DEFAULT_ROUNDS_PER_TENANT,
  DEFAULT_GAMES_PER_ROUND,
  DEFAULT_TAGS_PER_ROUND,
};
