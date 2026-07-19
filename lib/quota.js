'use strict';

/*
 * Per-tenant quotas & abuse controls (issue #139).
 *
 * Bounds cost/abuse once public multi-tenant sign-up opens (#219). Four caps:
 *   - rounds per tenant          (state cap, checked in routes/rounds.js)
 *   - games per round            (state cap, checked in routes/games.js)
 *   - tags per round             (state cap, checked in routes/tags.js, #238)
 *   - buy-next recommendation    (rate cap, the recommendationsGuard middleware
 *     spend per tenant/month       here, mounted in lib/app.js)
 *
 * Enforced ONLY in the public multi-tenant mode (accounts.accountsEnabled()).
 * With accounts off — today's single-tenant production behind the shared-password
 * gate, where every caller is the one 'default' tenant — the caps are inert, so
 * that instance is byte-for-byte unchanged and an existing group already past a
 * cap is never suddenly blocked. This mirrors how tenancy (#136) and onboarding
 * (#138) gate their behaviour, and it turns quotas on exactly when public sign-up
 * does.
 *
 * The two state caps are checked against current data — count the tenant's rounds
 * / a round's games and refuse the create at the ceiling. Deleting frees the
 * quota, which is correct for a state cap.
 *
 * The recommendation-spend cap is a rate cap, NOT a count of kept runs: counting
 * runs would be evadable (delete old runs to reset it) and each call spends real
 * money. It's a per-tenant, in-memory counter bucketed by CALENDAR MONTH (keyed
 * by tenant id): a request is refused once the month's count is at the ceiling,
 * and only a successful (200) generation — a call that actually cost money —
 * increments it (a 502/503 for no key / upstream failure never does). Per-process
 * and reset on restart, exactly like the express-rate-limit limiters in
 * lib/app.js — a shared store is the same #215 follow-up. A month bucket (rather
 * than a rolling window) sidesteps express-rate-limit's 32-bit windowMs/timer
 * limit (~24.8 days) and gives a predictable, month-boundary reset. Counting on
 * success (not reserving up front) means an aborted request can't leak a slot and
 * wrongly block the tenant for the month; the only cost is that a burst of truly
 * concurrent calls could each slip past the check before any finishes — a
 * non-issue for a once-a-month button press.
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
const DEFAULT_RECS_MONTHLY = 1;

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

// Max successful buy-next generations per tenant per calendar month
// (RECS_TENANT_MONTHLY_MAX, default 1).
function recsMonthly() {
  return Number(process.env.RECS_TENANT_MONTHLY_MAX) || DEFAULT_RECS_MONTHLY;
}

// tenantId -> { month: 'YYYY-MM' (UTC), count } — one entry per tenant, reset in
// place when the month rolls over, so the map stays bounded by the tenant count.
const recSpend = new Map();

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function bucketFor(tenantId) {
  const month = monthKey();
  let b = recSpend.get(tenantId);
  if (!b || b.month !== month) {
    b = { month, count: 0 };
    recSpend.set(tenantId, b);
  }
  return b;
}

// Middleware for the billed buy-next call. It's mounted with app.use() on the
// recommendations path, which matches ALL methods — but only POST generates (and
// spends). GET (read the run history) and DELETE (drop a run) must stay reachable
// after the quota is spent, so only POST is capped. Runs after the tenant
// middleware, so req.tenantId is set. Inert unless quotas are enforced. Refuses
// once the month's quota is spent (429) and, on the way out, counts only a
// successful (200) generation against the tenant.
function recommendationsGuard(req, res, next) {
  if (!enforced() || req.method !== 'POST') return next();
  const bucket = bucketFor(req.tenantId || 'default');
  if (bucket.count >= recsMonthly()) {
    return res.status(429).json({ error: 'quota_recommendations' });
  }
  res.on('finish', () => {
    if (res.statusCode === 200) bucket.count += 1;
  });
  next();
}

module.exports = {
  enforced,
  roundsPerTenant,
  gamesPerRound,
  tagsPerRound,
  recsMonthly,
  recommendationsGuard,
  DEFAULT_ROUNDS_PER_TENANT,
  DEFAULT_GAMES_PER_ROUND,
  DEFAULT_TAGS_PER_ROUND,
  DEFAULT_RECS_MONTHLY,
};
