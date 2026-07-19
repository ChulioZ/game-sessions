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
}
