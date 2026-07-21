'use strict';

/*
 * Instance status for the operator panel (issue #274).
 *
 * Two properties matter here and neither is visible by eye in the panel:
 *
 *  1. It reports the CURRENT process env, because everything is read per call.
 *     A module-load read would make the card describe the config the process
 *     booted with, which is exactly the stale answer an operator would then act
 *     on. Driven here by mutating process.env between calls.
 *  2. It never leaks a secret. The generic sweep at the bottom is the real
 *     guard: it plants recognisable values in every secret-bearing env var and
 *     asserts none of them appears anywhere in the serialized response — so a
 *     field added later that echoes a secret fails this file without anyone
 *     having to remember to extend it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('./helpers'); // isolates DATA_DIR before the store is required
const { instanceStatus } = require('../lib/status');

// Save/restore so one case can't bleed into the next.
const VARS = [
  'ACCOUNTS_ENABLED', 'SESSION_SECRET', 'AUTH_PASSWORD', 'ADMIN_PASSWORD',
  'BREVO_API_KEY', 'MAIL_FROM', 'APP_BASE_URL', 'CANONICAL_HOST', 'REDIRECT_HOSTS',
  'MAX_ROUNDS_PER_TENANT', 'MAX_GAMES_PER_ROUND', 'MAX_TAGS_PER_ROUND',
  'RAILWAY_GIT_COMMIT_SHA', 'GIT_COMMIT_SHA', 'SOURCE_COMMIT', 'NODE_ENV',
  'IMPRESSUM_ADDRESS',
];

async function withEnv(overrides, fn) {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('accounts mode reports the flag and the secret separately', async (t) => {
  await t.test('the flag alone does not enable accounts', async () => {
    // The silent misconfiguration this card exists for: ACCOUNTS_ENABLED is on,
    // SESSION_SECRET is missing, so the app quietly stays in legacy mode.
    const s = await withEnv({ ACCOUNTS_ENABLED: 'true', SESSION_SECRET: undefined }, instanceStatus);
    assert.equal(s.accounts.flagSet, true);
    assert.equal(s.accounts.enabled, false);
    assert.equal(s.accounts.sessionSecretSet, false);
  });

  await t.test('flag plus secret enables it', async () => {
    const s = await withEnv({ ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 'a-real-secret' }, instanceStatus);
    assert.equal(s.accounts.enabled, true);
    assert.equal(s.accounts.sessionSecretSet, true);
  });
});

test('a secret equal to AUTH_PASSWORD is reported as not distinct', async (t) => {
  await t.test('SESSION_SECRET reused as the shared password', async () => {
    const s = await withEnv({ AUTH_PASSWORD: 'group-pw', SESSION_SECRET: 'group-pw' }, instanceStatus);
    assert.equal(s.accounts.sessionSecretDistinct, false);
  });

  await t.test('ADMIN_PASSWORD reused as the shared password', async () => {
    const s = await withEnv({ AUTH_PASSWORD: 'group-pw', ADMIN_PASSWORD: 'group-pw' }, instanceStatus);
    assert.equal(s.admin.enabled, true);
    assert.equal(s.admin.secretDistinct, false);
  });

  await t.test('genuinely different values are distinct', async () => {
    const s = await withEnv(
      { AUTH_PASSWORD: 'group-pw', ADMIN_PASSWORD: 'operator-pw', SESSION_SECRET: 'signing-secret' },
      instanceStatus,
    );
    assert.equal(s.admin.secretDistinct, true);
    assert.equal(s.accounts.sessionSecretDistinct, true);
  });

  await t.test('with no AUTH_PASSWORD at all there is nothing to collide with', async () => {
    const s = await withEnv({ AUTH_PASSWORD: undefined, ADMIN_PASSWORD: 'operator-pw' }, instanceStatus);
    assert.equal(s.admin.secretDistinct, true);
  });

  await t.test('an unset secret is not "distinct" — it is absent', async () => {
    const s = await withEnv({ AUTH_PASSWORD: 'group-pw', ADMIN_PASSWORD: undefined }, instanceStatus);
    assert.equal(s.admin.enabled, false);
    assert.equal(s.admin.secretDistinct, false);
  });
});

test('mail reports outbox-only when unconfigured', async () => {
  const off = await withEnv({ BREVO_API_KEY: undefined, MAIL_FROM: undefined, APP_BASE_URL: undefined }, instanceStatus);
  assert.deepEqual(off.mail, { configured: false, fromSet: false, baseUrlSet: false });

  const on = await withEnv(
    { BREVO_API_KEY: 'xkeysib-abc', MAIL_FROM: 'no-reply@example.com', APP_BASE_URL: 'https://example.com' },
    instanceStatus,
  );
  assert.deepEqual(on.mail, { configured: true, fromSet: true, baseUrlSet: true });
});

test('quota ceilings are reported with whether they actually bite', async (t) => {
  await t.test('inert with accounts off, whatever the numbers say', async () => {
    const s = await withEnv(
      { ACCOUNTS_ENABLED: undefined, SESSION_SECRET: undefined, MAX_ROUNDS_PER_TENANT: '3' },
      instanceStatus,
    );
    assert.equal(s.quotas.enforced, false);
    assert.equal(s.quotas.roundsPerTenant, 3);
  });

  await t.test('enforced once accounts are on', async () => {
    const s = await withEnv({ ACCOUNTS_ENABLED: 'true', SESSION_SECRET: 's' }, instanceStatus);
    assert.equal(s.quotas.enforced, true);
  });
});

test('hosts mirror the canonical-redirect middleware, including an empty list', async () => {
  const s = await withEnv({ CANONICAL_HOST: 'Example.APP ', REDIRECT_HOSTS: 'A.de , b.com' }, instanceStatus);
  assert.equal(s.hosts.canonical, 'example.app');
  assert.deepEqual(s.hosts.redirects, ['a.de', 'b.com']);

  // An explicit empty string means "redirect nothing" — not "fall back to the
  // defaults", which is what a naive `||` would do.
  const none = await withEnv({ REDIRECT_HOSTS: '' }, instanceStatus);
  assert.deepEqual(none.hosts.redirects, []);
});

test('storage and migration state describe the running backends', async () => {
  const s = await instanceStatus();
  // The suite runs on the default backends (no S3_BUCKET, no DATABASE_URL).
  assert.equal(s.storage.images, 'disk');
  assert.equal(s.storage.data, 'json');
  assert.deepEqual(s.migrations, { backend: 'json', latest: null, pending: 0 });
});

test('assets report public/ unless a production build is actually being served', async () => {
  // NODE_ENV alone must not claim a build: the repo has no dist/ in test.
  const s = await withEnv({ NODE_ENV: 'production' }, instanceStatus);
  assert.equal(s.assets.built, false);
});

test('the commit is shortened, and absent rather than invented', async () => {
  const withSha = await withEnv({ RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' }, instanceStatus);
  assert.equal(withSha.app.commit, '0123456');

  const without = await withEnv(
    { RAILWAY_GIT_COMMIT_SHA: undefined, GIT_COMMIT_SHA: undefined, SOURCE_COMMIT: undefined },
    instanceStatus,
  );
  assert.equal(without.app.commit, null);
});

test('uptime and version are present', async () => {
  const s = await instanceStatus();
  assert.equal(typeof s.app.uptimeSeconds, 'number');
  assert.ok(s.app.uptimeSeconds >= 0);
  assert.match(s.app.version, /^\d+\.\d+\.\d+/);
});

// The guard that survives future edits: plant a unique, greppable value in every
// secret-bearing var and assert none of them reaches the response in any form.
// A field added later that echoes (or truncates, or hashes-and-shows) a secret
// fails here without anyone remembering to extend this file.
test('the Impressum address is reported as presence only (#224/#134)', async () => {
  const off = await withEnv({ IMPRESSUM_ADDRESS: undefined }, instanceStatus);
  assert.equal(off.legal.impressumAddressSet, false);
  const on = await withEnv({ IMPRESSUM_ADDRESS: 'Musterweg 1, 12345 Musterstadt' }, instanceStatus);
  assert.equal(on.legal.impressumAddressSet, true);
});

test('no secret value ever appears in the response', async () => {
  const secrets = {
    AUTH_PASSWORD: 'SECRETVALUE-auth',
    SESSION_SECRET: 'SECRETVALUE-session',
    ADMIN_PASSWORD: 'SECRETVALUE-admin',
    BREVO_API_KEY: 'SECRETVALUE-brevo',
    // Not a secret forever (it ends up in the public Impressum), but before
    // launch it must not leak early through a panel screenshot — presence only.
    IMPRESSUM_ADDRESS: 'SECRETVALUE-address',
  };
  const s = await withEnv(secrets, instanceStatus);
  const serialized = JSON.stringify(s);

  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(serialized.includes(value), false, `${name} leaked into the status response`);
    // Also catch a "safe-looking" truncation, e.g. showing the first 8 chars.
    assert.equal(serialized.includes(value.slice(0, 8)), false, `${name} leaked a prefix`);
  }
  // Nothing in the payload should be a long opaque blob either (a hash digest
  // shown to the operator would be a secret-derived value with no purpose here).
  assert.equal(/[A-Fa-f0-9]{32,}/.test(serialized), false, 'a hash-like value reached the response');
});
