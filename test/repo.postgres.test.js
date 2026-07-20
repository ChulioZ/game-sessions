'use strict';

/*
 * The data-access-layer contract against the PostgreSQL backend (issue #127).
 *
 * Runs only when DATABASE_URL is set (CI's Postgres service container, or a local
 * container) — otherwise every case is skipped, so plain `npm test` stays green
 * without a database. Selects the Postgres backend via the same DATABASE_URL the
 * app uses, ensures the schema, and starts from truncated tables so the shared
 * contract (test/support/repo-contract.js) sees a clean store.
 *
 * Run locally, e.g.:
 *   docker run -d -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres \
 *     node --test test/repo.postgres.test.js
 */

const { test, before, after } = require('node:test');

if (!process.env.DATABASE_URL) {
  test('postgres backend contract (skipped: set DATABASE_URL to run)', { skip: true }, () => {});
} else {
  const { Client } = require('pg');
  const repo = require('../lib/repo'); // DATABASE_URL is set -> Postgres backend

  before(async () => {
    await repo.init(); // ensure schema (idempotent)
    const c = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await c.connect();
    await c.query('TRUNCATE rounds, members, games, sessions, activities CASCADE');
    await c.end();
  });

  // Release the pool so the test process can exit.
  after(async () => {
    await repo.end();
  });

  require('./support/repo-contract')(repo);

  // Row-Level Security is fail-closed (#136): a NON-SUPERUSER connection that
  // has NOT set the app.tenant_id transaction setting must see ZERO rows in the
  // round tables even though rows exist — the defense-in-depth backstop behind
  // the repo's explicit tenant filters. Note superusers BYPASS RLS entirely
  // (FORCE only binds non-superuser owners), which is why this probe creates a
  // dedicated plain role instead of reusing the test connection's superuser —
  // and why production should run the app as a non-superuser
  // (docs/deploy-railway.md).
  test('RLS is enforced (fail-closed) for a non-superuser without a tenant setting', async () => {
    const assert = require('node:assert/strict');
    const round = await repo.createRound('rls-probe', { name: 'Hidden', members: ['M'] });
    assert.ok(await repo.getRound('rls-probe', round.id)); // visible through the repo

    const admin = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await admin.connect();
    try {
      // RLS is enabled AND forced on every round table (catalog-level check —
      // holds regardless of which role the app connects as).
      const flags = await admin.query(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE relname = ANY($1)`,
        [['rounds', 'members', 'games', 'sessions', 'activities']]
      );
      assert.equal(flags.rows.length, 5);
      for (const row of flags.rows) {
        assert.equal(row.relrowsecurity, true, `${row.relname} has RLS enabled`);
        assert.equal(row.relforcerowsecurity, true, `${row.relname} has RLS forced`);
      }

      // Behavior probe through a plain role (dropped again below).
      await admin.query("DROP ROLE IF EXISTS gs_rls_probe");
      await admin.query("CREATE ROLE gs_rls_probe LOGIN PASSWORD 'probe'");
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gs_rls_probe');
      await admin.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gs_rls_probe');

      const url = new URL(process.env.DATABASE_URL);
      url.username = 'gs_rls_probe';
      url.password = 'probe';
      const probe = new Client({
        connectionString: url.toString(),
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      await probe.connect();
      try {
        for (const table of ['rounds', 'members', 'games', 'sessions', 'activities']) {
          const r = await probe.query(`SELECT count(*)::int AS n FROM ${table}`);
          assert.equal(r.rows[0].n, 0, `${table} must be invisible without app.tenant_id`);
        }
        // An un-scoped INSERT is refused outright (WITH CHECK)…
        await assert.rejects(
          () => probe.query("INSERT INTO rounds(id, tenant_id, name) VALUES ('rls_x', 'rls-probe', 'X')"),
          /row-level security/
        );
        // …while a transaction that sets the tenant sees exactly that tenant.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.tenant_id', 'rls-probe', true)");
        const scoped = await probe.query('SELECT id FROM rounds');
        await probe.query('COMMIT');
        assert.deepEqual(scoped.rows.map((r) => r.id), [round.id]);

        // The single-round-trip reads (#203) embed set_config in the statement
        // itself (READ_SQL): the materialized CTE runs it and every subquery
        // correlates on its return value, so the RLS scans must see the tenant.
        // Prove that ordering under FORCE RLS as a non-superuser, with NO prior
        // setting on the connection — the exact texts the repo executes.
        const { READ_SQL } = require('../lib/repo/postgres');
        const native = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
        const list = await probe.query(native(READ_SQL.list), ['rls-probe']);
        assert.deepEqual(list.rows[0].rounds.map((r) => r.id), [round.id]);
        assert.equal(list.rows[0].members.length, 1);
        const one = await probe.query(native(READ_SQL.round), ['rls-probe', round.id, round.id, round.id, round.id]);
        assert.equal(one.rows[0].round.id, round.id);
        assert.equal(one.rows[0].members[0].data.name, 'M');
        const feed = await probe.query(native(READ_SQL.activities), ['rls-probe', round.id, round.id]);
        assert.equal(feed.rows[0].round.id, round.id);
        assert.deepEqual(feed.rows[0].acts, []);
        // The statement-embedded setting must die WITH the statement: a plain
        // follow-up on the same connection is back to fail-closed zero rows.
        const after = await probe.query('SELECT count(*)::int AS n FROM rounds');
        assert.equal(after.rows[0].n, 0);
      } finally {
        await probe.end();
      }
    } finally {
      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gs_rls_probe').catch(() => {});
      await admin.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gs_rls_probe').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS gs_rls_probe').catch(() => {});
      await admin.end();
    }
  });

  // The moderation admin escape (#268) must be probed through a PLAIN ROLE for
  // the same reason as above: this test file's own connection is a superuser and
  // bypasses RLS entirely, so the cross-tenant assertions in the shared contract
  // suite would pass even if the policy change were completely broken. Only this
  // probe can catch that — and a break would surface as "operator lookup finds
  // nothing" on a hardened deploy while CI stayed green.
  //
  // Two halves, and the second is the security-critical one:
  //   1. app.admin='on' WIDENS READS across tenants.
  //   2. It does NOT widen writes — INSERT, UPDATE *and* DELETE stay
  //      tenant-matched.
  //
  // DELETE is the one that matters most here and is easy to get wrong: Postgres
  // governs DELETE by USING **alone** (there is no WITH CHECK for DELETE), so
  // the tempting implementation — `OR app.admin` bolted onto the existing FOR
  // ALL policy's USING — would leave a cross-tenant DELETE wide open while
  // looking read-only. The migration instead adds a separate FOR SELECT policy;
  // the DELETE assertion below is what pins that down.
  test('the moderation admin escape widens reads only, never writes', async () => {
    const assert = require('node:assert/strict');
    const a = await repo.createRound('esc-a', { name: 'A round', members: ['M'] });
    await repo.createGame('esc-a', a.id, {
      title: 'A game', minPlayers: 1, maxPlayers: 2, image: '/uploads/esc-a.jpg', source: null,
    });
    const b = await repo.createRound('esc-b', { name: 'B round', members: ['N'] });
    await repo.createGame('esc-b', b.id, {
      title: 'B game', minPlayers: 1, maxPlayers: 2, image: '/uploads/esc-b.jpg', source: null,
    });

    const admin = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await admin.connect();
    try {
      await admin.query('DROP ROLE IF EXISTS gs_esc_probe');
      await admin.query("CREATE ROLE gs_esc_probe LOGIN PASSWORD 'probe'");
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gs_esc_probe');
      await admin.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gs_esc_probe');

      const url = new URL(process.env.DATABASE_URL);
      url.username = 'gs_esc_probe';
      url.password = 'probe';
      const probe = new Client({
        connectionString: url.toString(),
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      await probe.connect();
      try {
        // Baseline: still fail-closed without either setting.
        const closed = await probe.query('SELECT count(*)::int AS n FROM games');
        assert.equal(closed.rows[0].n, 0);

        // 1. With the admin flag, a cross-tenant read sees BOTH tenants' rows —
        //    this is what makes findImageOwner work on a hardened deploy.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.admin', 'on', true)");
        const seen = await probe.query(
          "SELECT tenant_id FROM games WHERE data->>'image' IN ('/uploads/esc-a.jpg', '/uploads/esc-b.jpg') ORDER BY tenant_id"
        );
        assert.deepEqual(seen.rows.map((r) => r.tenant_id), ['esc-a', 'esc-b']);

        // 2a. …but the SAME transaction may not INSERT across tenants: the
        //     tenant policy's WITH CHECK has no admin escape.
        await assert.rejects(
          () => probe.query("INSERT INTO rounds(id, tenant_id, name) VALUES ('esc_x', 'esc-a', 'X')"),
          /row-level security/,
          'the admin flag must NOT permit a cross-tenant insert'
        );
        await probe.query('ROLLBACK');

        // 2b. …and it may not DELETE across tenants either. This is the
        //     assertion that catches the USING-only mistake: a DELETE is
        //     filtered by the tenant policy alone, so with the flag set (and no
        //     app.tenant_id) it must match ZERO rows rather than every tenant's.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.admin', 'on', true)");
        const del = await probe.query("DELETE FROM games WHERE data->>'image' = '/uploads/esc-a.jpg'");
        assert.equal(del.rowCount, 0, 'the admin flag must NOT permit a cross-tenant delete');
        // Same for a cross-tenant UPDATE.
        const upd = await probe.query("UPDATE games SET data = data || '{\"image\":null}'::jsonb WHERE data->>'image' = '/uploads/esc-a.jpg'");
        assert.equal(upd.rowCount, 0, 'the admin flag must NOT permit a cross-tenant update');
        await probe.query('ROLLBACK');

        // 3. The flag is transaction-local: the next statement on the same
        //    pooled connection is back to fail-closed.
        const after = await probe.query('SELECT count(*)::int AS n FROM games');
        assert.equal(after.rows[0].n, 0);
      } finally {
        await probe.end();
      }
    } finally {
      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gs_esc_probe').catch(() => {});
      await admin.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gs_esc_probe').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS gs_esc_probe').catch(() => {});
      await admin.end();
    }
  });
}
