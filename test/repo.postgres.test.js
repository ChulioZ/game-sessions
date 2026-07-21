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
  const { execFileSync } = require('node:child_process');
  const repo = require('../lib/repo'); // DATABASE_URL is set -> Postgres backend

  before(async () => {
    await repo.init(); // ensure schema (idempotent)
    const c = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await c.connect();
    // EVERY table the contract suite writes, not just the round ones. The JSON
    // backend gets a fresh temp DATA_DIR per run, so the shared contract assumes
    // an empty store — but a Postgres database persists between runs, and
    // several contract tests assert ABSOLUTE counts.
    //
    // This is DISCOVERED, not a hand-maintained list, because the hand-written
    // one silently rotted twice: omitting `users`/`moderation_log` broke
    // "logModeration appends…" (expected 2, saw 4), and `feedback` (added later
    // by #260) was never added at all, breaking "createFeedback appends…"
    // (expected 2, saw 6). Both passed on a fresh database and failed only on a
    // re-run against the same one — and CI never noticed either, since it gets a
    // clean service container every time, so this only ever bit someone
    // iterating against a local container. A new global table would have been
    // the third repeat; now it is covered the moment its migration runs.
    //
    // knex's own bookkeeping is excluded: truncating it would make the next
    // init() re-run every migration. TRUNCATE is table-level and exempt from
    // RLS, which is why it works here at all (.claude/rules/tenancy-rls.md).
    await c.query(`
      DO $$
      DECLARE tables text;
      BEGIN
        SELECT string_agg(quote_ident(tablename), ', ') INTO tables
          FROM pg_tables
         WHERE schemaname = 'public' AND tablename NOT LIKE 'knex\\_%';
        IF tables IS NOT NULL THEN
          EXECUTE 'TRUNCATE ' || tables || ' CASCADE';
        END IF;
      END $$;`);
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
        // The summary read joins across all five patterns (lateral + scalar
        // subqueries + nested aggregation) — same embedded set_config contract.
        const sums = await probe.query(native(READ_SQL.summaries), ['rls-probe']);
        assert.deepEqual(sums.rows[0].summaries.map((s) => s.id), [round.id]);
        assert.equal(sums.rows[0].summaries[0].memberCount, 1);
        // The light validation reads follow the same embedded-set_config
        // contract as the assembled reads.
        const meta = await probe.query(native(READ_SQL.meta), ['rls-probe', round.id, round.id]);
        assert.equal(meta.rows[0].round.id, round.id);
        assert.equal(meta.rows[0].members.length, 1);
        const noSession = await probe.query(native(READ_SQL.session), ['rls-probe', 'nope', round.id]);
        assert.equal(noSession.rows[0].entity, null);
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
  // Erasure (#273) DELETEs round rows, and this file's own connection is a
  // superuser that bypasses RLS — so the shared contract suite would report a
  // green cascade even if the policy forbade it. Only a plain role proves the
  // delete actually lands on a hardened deploy.
  //
  // The specific trap: erasure must NOT be attempted under the app.admin escape,
  // which is FOR SELECT only. A DELETE there matches zero rows (DELETE is
  // governed by USING alone, and the admin policy contributes none for it), so
  // eraseAccount would silently report `rounds: 0` and erase nothing while
  // claiming success — the worst possible outcome for a legal duty. It therefore
  // runs through the ordinary tx(tenant, ...) path, which this asserts.
  test('erasure deletes tenant rows as a non-superuser under FORCE RLS', async () => {
    const assert = require('node:assert/strict');
    const tenant = `pg-erase-${Math.random().toString(16).slice(2)}`;
    const user = await repo.createUser({
      email: `${tenant}@example.com`,
      createdAt: '2026-07-20T00:00:00.000Z',
      tenantId: tenant,
      emailVerified: true,
      identities: [],
      verification: null,
      reset: null,
      refreshTokens: [],
    });
    const round = await repo.createRound(tenant, { name: 'To erase', members: ['Ann'] });
    await repo.createGame(tenant, round.id, {
      title: 'Covered', minPlayers: 1, maxPlayers: 4, image: '/uploads/pg-erase.jpg', source: null,
    });

    const admin = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await admin.connect();
    try {
      await admin.query('DROP ROLE IF EXISTS gs_erase_probe');
      await admin.query("CREATE ROLE gs_erase_probe LOGIN PASSWORD 'probe'");
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gs_erase_probe');
      await admin.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gs_erase_probe');

      const url = new URL(process.env.DATABASE_URL);
      url.username = 'gs_erase_probe';
      url.password = 'probe';
      const probe = new Client({
        connectionString: url.toString(),
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      await probe.connect();
      try {
        // A DELETE under the ADMIN escape matches nothing — the shape erasure
        // must not use, asserted so a later "simplification" onto atx() fails
        // loudly here instead of silently erasing nothing in production.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.admin', 'on', true)");
        const viaAdmin = await probe.query('DELETE FROM rounds WHERE id = $1', [round.id]);
        assert.equal(viaAdmin.rowCount, 0, 'the FOR SELECT admin escape must not delete');
        await probe.query('ROLLBACK');

        // …while the tenant-scoped path erasure actually uses does delete, and
        // the children cascade with the round.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const viaTenant = await probe.query('DELETE FROM rounds WHERE id = $1', [round.id]);
        assert.equal(viaTenant.rowCount, 1, 'the tenant-scoped path must delete');
        const games = await probe.query('SELECT count(*)::int AS n FROM games WHERE round_id = $1', [round.id]);
        assert.equal(games.rows[0].n, 0, 'children cascade with the round');
        await probe.query('ROLLBACK'); // leave the row for the repo call below
      } finally {
        await probe.end();
      }
    } finally {
      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gs_erase_probe').catch(() => {});
      await admin.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gs_erase_probe').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS gs_erase_probe').catch(() => {});
      await admin.end();
    }

    // End to end through the repo itself.
    const out = await repo.eraseAccount(user.id);
    assert.equal(out.rounds, 1);
    assert.deepEqual(out.images, ['/uploads/pg-erase.jpg']);
    assert.equal(await repo.getUserById(user.id), null);
    assert.deepEqual(await repo.listRounds(tenant), []);
  });

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

        // 4. The other half of 2b: the tenant-scoped path takedownImage
        //    actually uses DOES update. Without this, 2b alone would still pass
        //    if the policies refused the write to everyone — so the pair is what
        //    proves the escape is narrow rather than the table being read-only.
        //    Only a plain role can show it: the contract suite's connection is a
        //    superuser and bypasses RLS entirely.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.tenant_id', 'esc-a', true)");
        const scoped = await probe.query(
          "UPDATE games SET data = data || '{\"image\":null}'::jsonb WHERE data->>'image' = '/uploads/esc-a.jpg'"
        );
        assert.equal(scoped.rowCount, 1, 'the tenant-scoped write path must update');
        await probe.query('ROLLBACK');
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

  // Redaction (#275) is the third operator WRITE, after takedown (#268) and
  // erasure (#273), and it walks into the same trap as both — with a nastier
  // failure mode than either.
  //
  // The reads it needs (findRoundOwner / tenantSummary / roundContent) are
  // genuinely cross-tenant, so the tempting shape is to do the whole thing
  // inside atx(). Under that shape, on a hardened (non-superuser) deploy:
  //   - the SELECT succeeds     (the admin policy is FOR SELECT)
  //   - the UPDATE matches ZERO rows (it consults only the tenant policy, which
  //     contributes nothing when app.tenant_id is unset)
  // and because redactText derives its return value from the row it READ, it
  // would answer with a perfectly plausible { previous: 'the illegal title' },
  // the route would write a moderation-log entry, and the panel would report
  // success — while the reported content is still live for every user. A
  // takedown that did not take anything down, on the record as done.
  //
  // The contract suite cannot catch it (superuser connection, RLS bypassed), so
  // this pins the shape down through a plain role: admin-escape UPDATE = 0 rows,
  // tenant-scoped UPDATE = 1 row, and the repo method actually changes the value.
  test('redaction writes tenant-scoped, never under the read-only admin escape', async () => {
    const assert = require('node:assert/strict');
    const tenant = `pg-redact-${Math.random().toString(16).slice(2)}`;
    const round = await repo.createRound(tenant, { name: 'Illegal round name', members: ['Ann'] });
    const game = await repo.createGame(tenant, round.id, {
      title: 'Illegal title', minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });

    const admin = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    await admin.connect();
    try {
      await admin.query('DROP ROLE IF EXISTS gs_redact_probe');
      await admin.query("CREATE ROLE gs_redact_probe LOGIN PASSWORD 'probe'");
      await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gs_redact_probe');
      await admin.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gs_redact_probe');

      const url = new URL(process.env.DATABASE_URL);
      url.username = 'gs_redact_probe';
      url.password = 'probe';
      const probe = new Client({
        connectionString: url.toString(),
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      await probe.connect();
      try {
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.admin', 'on', true)");
        // The read the escape exists for still works — that is what makes the
        // wrong shape look correct in review.
        const seen = await probe.query('SELECT name FROM rounds WHERE id = $1', [round.id]);
        assert.equal(seen.rows[0].name, 'Illegal round name', 'the escape must still read');
        // …and the write silently does nothing.
        const viaAdmin = await probe.query(
          'UPDATE rounds SET name = $2 WHERE id = $1', [round.id, '[entfernt]'],
        );
        assert.equal(viaAdmin.rowCount, 0, 'the FOR SELECT admin escape must not update');
        const viaAdminGame = await probe.query(
          'UPDATE games SET data = data || \'{"title":"[entfernt]"}\'::jsonb WHERE id = $1', [game.id],
        );
        assert.equal(viaAdminGame.rowCount, 0, 'the FOR SELECT admin escape must not update games');
        await probe.query('ROLLBACK');

        // The path redactText actually uses does write.
        await probe.query('BEGIN');
        await probe.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        const viaTenant = await probe.query(
          'UPDATE rounds SET name = $2 WHERE id = $1', [round.id, '[entfernt]'],
        );
        assert.equal(viaTenant.rowCount, 1, 'the tenant-scoped path must update');
        await probe.query('ROLLBACK'); // leave the row for the repo call below
      } finally {
        await probe.end();
      }

      // The decisive step — and the reason this probe is not just the erasure
      // one again. Everything above proves the POLICY shape; none of it proves
      // redactText USES the right path, because this file's own repo connection
      // is a superuser that bypasses RLS entirely: a redactText rewritten onto
      // atx() passes every assertion above and every case in the contract suite.
      //
      // So run the method itself as the plain role, in a child process, where
      // lib/repo/postgres.js builds its knex against the probe connection. Under
      // the wrong shape the SELECT still succeeds (FOR SELECT escape) so the
      // child still prints a plausible `previous`, and the UPDATE silently
      // matches nothing — which the stored-value assertion after this block is
      // what catches. Verified by deliberately breaking redactText: this is the
      // only assertion in the file that goes red.
      const url2 = new URL(process.env.DATABASE_URL);
      url2.username = 'gs_redact_probe';
      url2.password = 'probe';
      const child = execFileSync(process.execPath, ['-e', `
        const repo = require(${JSON.stringify(require.resolve('../lib/repo/postgres'))});
        repo.redactText(${JSON.stringify({ kind: 'game', roundId: round.id, id: game.id })}, '[entfernt]')
          .then((out) => { console.log('RESULT:' + JSON.stringify(out)); return repo.end(); })
          .catch((err) => { console.error(err.stack); process.exit(1); });
      `], { env: { ...process.env, DATABASE_URL: url2.toString() }, encoding: 'utf8' });

      const line = child.split('\n').find((l) => l.startsWith('RESULT:'));
      assert.ok(line, `the probe child produced no result: ${child}`);
      assert.equal(JSON.parse(line.slice('RESULT:'.length)).previous, 'Illegal title');
    } finally {
      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gs_redact_probe').catch(() => {});
      await admin.query('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gs_redact_probe').catch(() => {});
      await admin.query('DROP ROLE IF EXISTS gs_redact_probe').catch(() => {});
      await admin.end();
    }

    // The value must actually have CHANGED, not merely been reported as changed.
    const after = await repo.getRound(tenant, round.id);
    assert.equal(after.games[0].title, '[entfernt]', 'the redaction did not land as a non-superuser');

    // The cross-tenant reads resolve without any tenant scope in hand — that is
    // the half the admin escape legitimately provides.
    assert.equal((await repo.findRoundOwner(round.id)).tenantId, tenant);
    assert.equal((await repo.tenantSummary(tenant)).totals.games, 1);
    assert.equal((await repo.roundContent(round.id)).games[0].title, '[entfernt]');
  });
}
