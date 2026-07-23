'use strict';

/*
 * The data-access-layer contract (issue #127), as a backend-parameterized suite.
 * Both backends must satisfy it identically: test/repo.test.js runs it against
 * the JSON backend, test/repo.postgres.test.js against PostgreSQL. Keeping it in
 * one place is what proves the Postgres backend is a faithful drop-in — the same
 * assertions, same expected shapes, against each implementation.
 *
 * Tenancy (#136): every round-scoped method takes the caller's tenant first.
 * The suite runs everything as tenant T (deliberately not 'default', so nothing
 * passes by accident of the schema default) and probes isolation as OTHER — a
 * wrong-tenant call must look exactly like not-found.
 *
 * Exported as a function taking the repo module (so it doesn't pick a backend
 * itself). It is under test/ so `node --test` may load it standalone; it
 * registers no tests until called, so that run is a harmless no-op.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// A fresh identifier per call, so a suite run against a PERSISTENT database
// can't collide with an earlier run's rows. Uses crypto rather than
// Math.random(): these feed account fields (e-mail, username), and CodeQL
// rightly flags `js/insecure-randomness` when a weak source reaches one — the
// randomness is not load-bearing here, but a scanner cannot know that, and a
// secure source costs nothing.
const uniq = () => `u${crypto.randomBytes(6).toString('hex')}`;

const T = 'tenant-a';
const OTHER = 'tenant-b';

module.exports = function repoContract(repo) {
  async function freshRound(over = {}) {
    return repo.createRound(T, { name: 'R', members: ['Alice', 'Bob'], importFromRoundId: null, ...over });
  }

  const gameFields = (over = {}) => ({
    title: 'A', minPlayers: 1, maxPlayers: 4, image: null, source: null, ...over,
  });

  test('createRound mints ids and getRound round-trips it', async () => {
    const created = await repo.createRound(T, { name: 'Spielrunde', members: ['Ann', 'Bo'] });
    assert.match(created.id, /^[0-9a-f]{16}$/);
    assert.equal(created.members.length, 2);
    assert.ok(created.members.every((m) => /^[0-9a-f]{16}$/.test(m.id)));
    assert.deepEqual(created.games, []);
    assert.equal(created.background, null);
    // The tenant is scoping metadata, not payload.
    assert.equal('tenantId' in created, false);

    const fetched = await repo.getRound(T, created.id);
    assert.deepEqual(fetched, created);
  });

  test('getRound returns a snapshot: mutating it does not change the store', async () => {
    const round = await freshRound();
    const snap = await repo.getRound(T, round.id);
    snap.name = 'HACKED';
    snap.members.push({ id: 'x', name: 'Injected' });

    const again = await repo.getRound(T, round.id);
    assert.equal(again.name, 'R');
    assert.equal(again.members.length, 2);
  });

  test('getRoundMeta carries identity/members/config but no games or sessions', async () => {
    const round = await freshRound({ name: 'Meta' });
    await repo.createGame(T, round.id, gameFields());
    await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: ['x'], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });

    const meta = await repo.getRoundMeta(T, round.id);
    assert.equal(meta.name, 'Meta');
    assert.deepEqual(meta.members.map((m) => m.name), ['Alice', 'Bob']);
    assert.equal(meta.background, null);
    // The whole point: the heavy collections are NOT part of the read.
    assert.equal('games' in meta, false);
    assert.equal('sessions' in meta, false);
    // Absent-key parity with getRound: config keys appear only once written.
    assert.equal('tags' in meta, false);
    assert.equal('providers' in meta, false);
    await repo.addTag(T, round.id, 'Koop', null);
    await repo.setProviders(T, round.id, ['bgg']);
    const again = await repo.getRoundMeta(T, round.id);
    assert.equal(again.tags.length, 1);
    assert.deepEqual(again.providers, ['bgg']);

    // Snapshot semantics + isolation, like every other read.
    again.members.push({ id: 'x', name: 'Injected' });
    assert.equal((await repo.getRoundMeta(T, round.id)).members.length, 2);
    assert.equal(await repo.getRoundMeta(OTHER, round.id), null);
    assert.equal(await repo.getRoundMeta(T, 'missing'), null);
  });

  test('getSession/getGame fetch one entity; wrong round or tenant is not-found', async () => {
    const round = await freshRound();
    const decoy = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ title: 'Solo' }));
    const session = await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [game.id], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });

    const s = await repo.getSession(T, round.id, session.id);
    assert.deepEqual(s.gameIds, [game.id]);
    const g = await repo.getGame(T, round.id, game.id);
    assert.equal(g.title, 'Solo');

    // A guessed id under the WRONG round (or tenant) must read as missing —
    // the routes' 404 distinction depends on it.
    assert.equal(await repo.getSession(T, decoy.id, session.id), null);
    assert.equal(await repo.getGame(T, decoy.id, game.id), null);
    assert.equal(await repo.getSession(OTHER, round.id, session.id), null);
    assert.equal(await repo.getGame(OTHER, round.id, game.id), null);
    assert.equal(await repo.getSession(T, round.id, 'missing'), null);
    assert.equal(await repo.getGame(T, round.id, 'missing'), null);

    // Snapshots: mutating the returned entity never touches the store.
    s.gameIds.push('hacked');
    assert.deepEqual((await repo.getSession(T, round.id, session.id)).gameIds, [game.id]);
  });

  test('getRound returns null for a missing round; deleteRound reports found/again', async () => {
    assert.equal(await repo.getRound(T, 'nope'), null);
    const round = await freshRound();
    assert.deepEqual(await repo.deleteRound(T, round.id), { images: [] });
    assert.equal(await repo.deleteRound(T, round.id), null);
    assert.equal(await repo.getRound(T, round.id), null);
  });

  // #280: the games cascade away with the round, so their cover paths are only
  // knowable here — an unreported one is an object nothing can ever reach again.
  test('deleteRound reports its games\' cover images, deduped', async () => {
    const round = await freshRound();
    await repo.createGame(T, round.id, gameFields({ title: 'A', image: '/uploads/a.jpg' }));
    await repo.createGame(T, round.id, gameFields({ title: 'B', image: '/uploads/b.jpg' }));
    // A second game on the same cover (as an imported round produces) must be
    // reported once, so the route deletes the object once.
    await repo.createGame(T, round.id, gameFields({ title: 'C', image: '/uploads/a.jpg' }));
    await repo.createGame(T, round.id, gameFields({ title: 'D' })); // no cover
    // Retired games hold a cover too — they must not be missed.
    const retired = await repo.createGame(T, round.id, gameFields({ title: 'E', image: '/uploads/e.jpg' }));
    await repo.retireGame(T, round.id, retired.id, true);

    const out = await repo.deleteRound(T, round.id);
    assert.deepEqual(
      [...out.images].sort(),
      ['/uploads/a.jpg', '/uploads/b.jpg', '/uploads/e.jpg']
    );
  });

  test('listRoundSummaries computes the home-screen shape without child payloads', async () => {
    const round = await freshRound({ name: 'Sommerrunde' });
    const [alice, bob] = round.members;
    const active = await repo.createGame(T, round.id, gameFields({ title: 'Catan' }));
    await repo.createGame(T, round.id, gameFields({ title: 'Azul' }));
    // Both archives are excluded from gameCount (#250) — it must match what a
    // createRound import would copy.
    const retired = await repo.createGame(T, round.id, gameFields({ title: 'Old' }));
    await repo.retireGame(T, round.id, retired.id, true);
    const done = await repo.createGame(T, round.id, gameFields({ title: 'Done' }));
    await repo.completeGame(T, round.id, done.id, true);

    await repo.createSession(T, round.id, {
      createdAt: '2026-01-01T10:00:00.000Z', gameIds: [active.id], votes: {},
      chosenGameId: active.id, chosenAt: 't', finished: true, finishedAt: 't',
      winnerIds: [bob.id, alice.id, 'ghost'], cancelled: false, cancelledAt: null, done: true,
    });
    await repo.createSession(T, round.id, {
      createdAt: '2026-01-02T10:00:00.000Z', gameIds: [active.id], votes: {},
      chosenGameId: null, chosenAt: null, finished: false, finishedAt: null,
      winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });

    const summaries = await repo.listRoundSummaries(T);
    const s = summaries.find((x) => x.id === round.id);
    assert.deepEqual(s, {
      id: round.id,
      name: 'Sommerrunde',
      members: [
        { id: alice.id, name: 'Alice' },
        { id: bob.id, name: 'Bob' },
      ],
      memberCount: 2,
      gameCount: 2,
      sessionCount: 2,
      playedCount: 1,
      background: null,
      lastPlayed: {
        gameTitle: 'Catan',
        // winnerIds order preserved; the unknown id is dropped, not blanked.
        winnerNames: ['Bob', 'Alice'],
        at: '2026-01-01T10:00:00.000Z',
      },
    });
    // Counts must be real numbers on both backends (the Postgres count()
    // bigint-as-string trap, #288).
    assert.equal(typeof s.gameCount, 'number');
    assert.equal(typeof s.playedCount, 'number');
    // Absent-key parity: no member ever had a color written, so the key is
    // absent (not null/undefined) — a color set later must then appear.
    assert.equal('color' in s.members[0], false);
    await repo.updateMember(T, round.id, alice.id, { color: '#d85a30' });
    const again = (await repo.listRoundSummaries(T)).find((x) => x.id === round.id);
    assert.deepEqual(again.members[0], { id: alice.id, name: 'Alice', color: '#d85a30' });
  });

  test('listRoundSummaries: lastPlayed picks the newest finished session by createdAt and follows the design', async () => {
    const round = await freshRound();
    const a = await repo.createGame(T, round.id, gameFields({ title: 'First' }));
    const b = await repo.createGame(T, round.id, gameFields({ title: 'Second' }));
    const mkSession = (createdAt, game) => repo.createSession(T, round.id, {
      createdAt, gameIds: [game.id], votes: {}, chosenGameId: game.id, chosenAt: createdAt,
      finished: true, finishedAt: createdAt, winnerIds: [], cancelled: false, cancelledAt: null, done: true,
    });
    // Inserted newest-first on purpose: the pick must order by createdAt (when
    // the session was played), not by insertion or finish time.
    await mkSession('2026-02-02T10:00:00.000Z', b);
    await mkSession('2026-01-01T10:00:00.000Z', a);
    await repo.setBackground(T, round.id, { type: 'theme', page: '#fff', accent: '#c2410c' });

    const s = (await repo.listRoundSummaries(T)).find((x) => x.id === round.id);
    assert.equal(s.lastPlayed.gameTitle, 'Second');
    assert.deepEqual(s.lastPlayed.winnerNames, []);
    assert.deepEqual(s.background, { type: 'theme', page: '#fff', accent: '#c2410c' });
    // No sessions finished -> no highlight (null, not absent).
    const bare = await freshRound();
    const bareSummary = (await repo.listRoundSummaries(T)).find((x) => x.id === bare.id);
    assert.equal(bareSummary.lastPlayed, null);
  });

  test('listRoundSummaries is tenant-scoped and returns snapshots', async () => {
    const round = await freshRound();
    await repo.setBackground(T, round.id, { type: 'theme', page: '#eee', accent: '#111111' });
    const other = await repo.listRoundSummaries(OTHER);
    assert.equal(other.some((x) => x.id === round.id), false);

    const s = (await repo.listRoundSummaries(T)).find((x) => x.id === round.id);
    s.background.page = 'HACKED';
    const again = (await repo.listRoundSummaries(T)).find((x) => x.id === round.id);
    assert.equal(again.background.page, '#eee');
  });

  test('deleteRound is refused across tenants and frees nothing', async () => {
    const round = await freshRound();
    await repo.createGame(T, round.id, gameFields({ image: '/uploads/kept-280.jpg' }));
    assert.equal(await repo.deleteRound(OTHER, round.id), null);
    assert.ok(await repo.getRound(T, round.id));
    assert.equal(await repo.isImageReferenced(T, '/uploads/kept-280.jpg'), true);
  });

  test('createRound import copies only active games (title/image) + logs them', async () => {
    const src = await freshRound();
    const active = await repo.createGame(T, src.id, gameFields({ title: 'Catan', minPlayers: 3, image: '/uploads/a.jpg' }));
    const retired = await repo.createGame(T, src.id, gameFields({ title: 'Old', minPlayers: 2, maxPlayers: 2 }));
    await repo.retireGame(T, src.id, retired.id, true);
    // Completed games are archived too (#250) — the import must skip them just
    // like retired ones, not only filter on `retired`.
    const done = await repo.createGame(T, src.id, gameFields({ title: 'Campaign' }));
    await repo.completeGame(T, src.id, done.id, true);

    const copy = await repo.createRound(T, { name: 'Copy', members: ['Z'], importFromRoundId: src.id });
    assert.equal(copy.games.length, 1);
    const g = copy.games[0];
    assert.equal(g.title, 'Catan');
    assert.equal(g.image, '/uploads/a.jpg');
    assert.equal(g.retired, false);
    assert.notEqual(g.id, active.id); // a fresh id, not the source game's
    // players are intentionally NOT carried over by import.
    assert.equal(g.minPlayers, undefined);
    const feed = await repo.listActivities(T, copy.id);
    assert.equal(feed.filter((a) => a.type === 'game_added').length, 1);
  });

  test('updateGame applies only the given patch; unknown round/game -> null', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ minPlayers: 2, maxPlayers: 2 }));
    const updated = await repo.updateGame(T, round.id, game.id, { title: 'B', minPlayers: 3 });
    assert.equal(updated.title, 'B');
    assert.equal(updated.minPlayers, 3);
    assert.equal(updated.maxPlayers, 2); // untouched
    assert.equal(await repo.updateGame(T, round.id, 'missing', { title: 'X' }), null);
    assert.equal(await repo.updateGame(T, 'missing', game.id, { title: 'X' }), null);
  });

  // Unlinking a game (#282) patches source/image to null rather than removing
  // the keys. Both backends must round-trip that as a PRESENT null: the JSON
  // one via Object.assign, Postgres via jsonb `||` (which sets JSON null, it
  // does not delete the key). A backend that dropped the key instead would
  // still satisfy the route's `if (!game.source)` check, so only asserting the
  // shape here catches a divergence.
  test('updateGame patches a field to a present null (unlink shape)', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({
      image: 'https://cf.geekdo-images.com/x/pic.jpg',
      source: { provider: 'bgg', externalId: '13', url: 'https://boardgamegeek.com/boardgame/13' },
    }));
    assert.equal(game.source.provider, 'bgg');

    const cleared = await repo.updateGame(T, round.id, game.id, { source: null, image: null });
    assert.equal(cleared.source, null);
    assert.equal(cleared.image, null);
    assert.equal('source' in cleared, true, 'the key stays present, holding null');
    assert.equal('image' in cleared, true);

    // and it survives a re-read, not just the returning clause
    const reread = (await repo.getRound(T, round.id)).games.find((g) => g.id === game.id);
    assert.equal(reread.source, null);
    assert.equal(reread.image, null);
  });

  // #250: Active / Retired / Completed are mutually exclusive, and the data
  // layer — not just the UI — is what enforces it, so a client that calls both
  // endpoints can never produce a game that is in two archives at once.
  test('completeGame archives a game and clears any retired state (and vice versa)', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ title: 'Pandemic Legacy' }));
    assert.equal(game.completed, false);
    assert.equal(game.completedAt, null);

    const done = await repo.completeGame(T, round.id, game.id, true);
    assert.equal(done.completed, true);
    assert.ok(done.completedAt, 'a completion timestamp is stamped');
    assert.ok((await repo.listActivities(T, round.id)).some((a) => a.type === 'game_completed'));

    // Retiring a completed game moves it across, it does not stack.
    const retired = await repo.retireGame(T, round.id, game.id, true);
    assert.equal(retired.retired, true);
    assert.equal(retired.completed, false);
    assert.equal(retired.completedAt, null);

    // ...and back the other way.
    const again = await repo.completeGame(T, round.id, game.id, true);
    assert.equal(again.completed, true);
    assert.equal(again.retired, false);
    assert.equal(again.retiredAt, null);

    // Un-completing returns it to the active collection.
    const active = await repo.completeGame(T, round.id, game.id, false);
    assert.equal(active.completed, false);
    assert.equal(active.completedAt, null);
    assert.equal(active.retired, false);
    assert.ok((await repo.listActivities(T, round.id)).some((a) => a.type === 'game_uncompleted'));

    assert.equal(await repo.completeGame(T, round.id, 'missing', true), null);
    assert.equal(await repo.completeGame(T, 'missing', game.id, true), null);
  });

  // A completed game is deletable exactly like a retired one — the delete guard
  // covers both archives, not just `retired`.
  test('deleteGame accepts a completed game', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ title: 'Done', image: '/uploads/d.png' }));
    assert.equal(await repo.deleteGame(T, round.id, game.id), 'not_archived');
    await repo.completeGame(T, round.id, game.id, true);
    assert.deepEqual(await repo.deleteGame(T, round.id, game.id), { image: '/uploads/d.png' });
    assert.equal((await repo.getRound(T, round.id)).games.length, 0);
  });

  test('deleteGame refuses active games, scrubs retired ones from sessions', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ image: '/uploads/x.png' }));
    const keep = await repo.createGame(T, round.id, gameFields({ title: 'B' }));
    const session = await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [game.id, keep.id], votes: { m1: { [game.id]: { rating: 5 } } },
      chosenGameId: game.id, chosenAt: 't', finished: true, finishedAt: 't', winnerIds: ['m1'],
      cancelled: false, cancelledAt: null, done: true,
    });

    assert.equal(await repo.deleteGame(T, round.id, game.id), 'not_archived');
    await repo.retireGame(T, round.id, game.id, true);
    const result = await repo.deleteGame(T, round.id, game.id);
    assert.deepEqual(result, { image: '/uploads/x.png' });

    const after = await repo.getRound(T, round.id);
    assert.equal(after.games.length, 1);
    const s = after.sessions.find((x) => x.id === session.id);
    assert.deepEqual(s.gameIds, [keep.id]); // scrubbed
    assert.equal(s.chosenGameId, null); // reset because the chosen game was deleted
    assert.equal(s.votes.m1[game.id], undefined);
    assert.ok((await repo.listActivities(T, round.id)).some((a) => a.type === 'game_deleted'));
    assert.equal(await repo.deleteGame(T, round.id, 'gone'), null);
  });

  test('isImageReferenced sees images across the tenant\'s rounds, not other tenants\'', async () => {
    const round = await freshRound();
    await repo.createGame(T, round.id, gameFields({ image: '/uploads/shared.jpg' }));
    assert.equal(await repo.isImageReferenced(T, '/uploads/shared.jpg'), true);
    assert.equal(await repo.isImageReferenced(T, '/uploads/none.jpg'), false);
    // Image files never cross tenants, so neither does the reference check.
    assert.equal(await repo.isImageReferenced(OTHER, '/uploads/shared.jpg'), false);
  });

  test('createSession stores the draw-flow filter preset on the round (#252)', async () => {
    const round = await freshRound();
    const g = await repo.createGame(T, round.id, gameFields());
    const base = {
      createdAt: 't', gameIds: [g.id], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    };

    // Absent until a draw-flow session has ever run — both backends omit the
    // key entirely rather than emitting null.
    assert.equal('lastSessionFilters' in (await repo.getRound(T, round.id)), false);
    assert.equal('lastSessionFilters' in (await repo.listRounds(T)).find((r) => r.id === round.id), false);

    const filters = { tagIds: ['t1'], excludeTagIds: ['t2'], count: 4 };
    await repo.createSession(T, round.id, base, filters);
    assert.deepEqual((await repo.getRound(T, round.id)).lastSessionFilters, filters);
    assert.deepEqual(
      (await repo.listRounds(T)).find((r) => r.id === round.id).lastSessionFilters, filters);

    // Omitting the argument (direct-pick) leaves the stored preset untouched.
    await repo.createSession(T, round.id, base);
    assert.deepEqual((await repo.getRound(T, round.id)).lastSessionFilters, filters);

    const next = { tagIds: [], excludeTagIds: [], count: 1 };
    await repo.createSession(T, round.id, base, next);
    assert.deepEqual((await repo.getRound(T, round.id)).lastSessionFilters, next);
  });

  test('session mutators persist through getRound', async () => {
    const round = await freshRound();
    const g = await repo.createGame(T, round.id, gameFields());
    const session = await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [g.id], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });
    assert.match(session.id, /^[0-9a-f]{16}$/);

    await repo.setSessionChoice(T, round.id, session.id, g.id);
    await repo.finishSession(T, round.id, session.id, { finished: true, winnerIds: ['m1'] });
    const after = (await repo.getRound(T, round.id)).sessions[0];
    assert.equal(after.chosenGameId, g.id);
    assert.equal(after.finished, true);
    assert.deepEqual(after.winnerIds, ['m1']);

    assert.equal(await repo.deleteSession(T, round.id, session.id), true);
    assert.equal(await repo.deleteSession(T, round.id, session.id), false);
  });

  test('setBackground returns the previous design and stores the new one', async () => {
    const round = await freshRound();
    const first = await repo.setBackground(T, round.id, { type: 'theme', page: 'p', accent: 'a' });
    assert.equal(first.previous, null);
    const second = await repo.setBackground(T, round.id, { type: 'none' });
    assert.deepEqual(second.previous, { type: 'theme', page: 'p', accent: 'a' });
    assert.deepEqual((await repo.getRound(T, round.id)).background, { type: 'none' });
    assert.equal(await repo.setBackground(T, 'missing', { type: 'none' }), null);
  });

  test('addTag creates and dedupes; deleteTag unassigns from every game (#238)', async () => {
    const round = await freshRound();
    assert.equal('tags' in round, false); // absent until the first tag is created

    const first = await repo.addTag(T, round.id, 'Outside');
    assert.match(first.id, /^[0-9a-f]{16}$/);
    assert.equal(first.name, 'Outside');
    // A name matching case-insensitively reuses the existing tag.
    const dup = await repo.addTag(T, round.id, 'oUTSIDE');
    assert.deepEqual(dup, first);
    const second = await repo.addTag(T, round.id, 'Movement');
    assert.deepEqual((await repo.getRound(T, round.id)).tags, [first, second]);

    // createGame stores tagIds; updateGame replaces the assignment.
    const tagged = await repo.createGame(T, round.id, gameFields({ tagIds: [first.id, second.id] }));
    assert.deepEqual(tagged.tagIds, [first.id, second.id]);
    const plain = await repo.createGame(T, round.id, gameFields({ title: 'B' }));
    assert.equal('tagIds' in plain, false); // absent when created without tags
    const patched = await repo.updateGame(T, round.id, plain.id, { tagIds: [second.id] });
    assert.deepEqual(patched.tagIds, [second.id]);

    // Deleting a tag removes it from the round AND from every game that had it.
    assert.equal(await repo.deleteTag(T, round.id, second.id), true);
    assert.equal(await repo.deleteTag(T, round.id, second.id), false);
    const after = await repo.getRound(T, round.id);
    assert.deepEqual(after.tags, [first]);
    assert.deepEqual(after.games.find((g) => g.id === tagged.id).tagIds, [first.id]);
    assert.deepEqual(after.games.find((g) => g.id === plain.id).tagIds, []);

    assert.equal(await repo.addTag(T, 'missing', 'X'), null);
  });

  test('tag icons: absent by default, set on create, patchable, clearable (#255)', async () => {
    const round = await freshRound();

    // Absent-key parity: a tag created without an icon carries no `icon` key at
    // all in either backend, so old tags and new plain ones look identical.
    const plain = await repo.addTag(T, round.id, 'Plain');
    assert.equal('icon' in plain, false);

    const withIcon = await repo.addTag(T, round.id, 'Puzzles', 'puzzle');
    assert.equal(withIcon.icon, 'puzzle');
    assert.deepEqual((await repo.getRound(T, round.id)).tags, [plain, withIcon]);

    // A duplicate name reuses the existing tag and must NOT adopt the icon —
    // creating a tag may never silently restyle one the round already has.
    const dup = await repo.addTag(T, round.id, 'plain', 'rocket');
    assert.deepEqual(dup, plain);

    // setTagIcon sets…
    const set = await repo.setTagIcon(T, round.id, plain.id, 'brain');
    assert.equal(set.icon, 'brain');
    assert.equal(set.name, 'Plain'); // name untouched — renaming stays unsupported
    assert.equal((await repo.getRound(T, round.id)).tags[0].icon, 'brain');

    // …and clears back to the absent key, not an empty string.
    const cleared = await repo.setTagIcon(T, round.id, plain.id, null);
    assert.equal('icon' in cleared, false);
    assert.equal('icon' in (await repo.getRound(T, round.id)).tags[0], false);

    // A missing round and a missing tag both read as not-found.
    assert.equal(await repo.setTagIcon(T, round.id, 'nope', 'star'), null);
    assert.equal(await repo.setTagIcon(T, 'missing', plain.id, 'star'), null);
  });

  test('setProviders: absent by default, empty list distinct from absent (#294)', async () => {
    const round = await freshRound();

    // Absent-key parity: a round that was never configured must not grow a
    // `providers` key, because absent is what means "all providers enabled".
    // Give it a default and every existing round silently changes behaviour.
    assert.equal('providers' in round, false);
    assert.equal('providers' in (await repo.getRound(T, round.id)), false);

    const saved = await repo.setProviders(T, round.id, ['bgg', 'steam']);
    assert.deepEqual(saved, ['bgg', 'steam']);
    assert.deepEqual((await repo.getRound(T, round.id)).providers, ['bgg', 'steam']);

    // An empty list is a real, distinct setting ("query nothing"), so it must
    // round-trip as [] and NOT collapse back to the absent key.
    assert.deepEqual(await repo.setProviders(T, round.id, []), []);
    const cleared = await repo.getRound(T, round.id);
    assert.equal('providers' in cleared, true);
    assert.deepEqual(cleared.providers, []);

    // It also survives the list read, not just the single-round read.
    const listed = (await repo.listRounds(T)).find((r) => r.id === round.id);
    assert.deepEqual(listed.providers, []);

    assert.equal(await repo.setProviders(T, 'missing', ['bgg']), null);
  });

  test('moveGames reparents every game and merges tags by name (#253)', async () => {
    const src = await freshRound({ name: 'Source' });
    const dst = await freshRound({ name: 'Target' });

    const outside = await repo.addTag(T, src.id, 'Outside', 'tent');
    const party = await repo.addTag(T, src.id, 'Party', 'confetti');
    const unused = await repo.addTag(T, src.id, 'Unused');
    // Same tag by name (different case + padding) already on the target: reused,
    // not duplicated. 'Party' has no match there, so it is created.
    const dstOutside = await repo.addTag(T, dst.id, '  oUTSIDE  '.trim());

    const tagged = await repo.createGame(T, src.id, gameFields({ title: 'Tagged', tagIds: [outside.id, party.id] }));
    const plain = await repo.createGame(T, src.id, gameFields({ title: 'Plain', image: '/uploads/a.jpg' }));
    const archived = await repo.createGame(T, src.id, gameFields({ title: 'Archived' }));
    await repo.retireGame(T, src.id, archived.id, true);
    await repo.createGame(T, dst.id, gameFields({ title: 'Keeper' }));

    const result = await repo.moveGames(T, src.id, dst.id);
    assert.deepEqual(result, { movedGames: 3, mergedTags: 1, createdTags: 1 });

    const after = await repo.getRound(T, src.id);
    const target = await repo.getRound(T, dst.id);
    assert.deepEqual(after.games, []); // source left in place, now empty
    assert.equal(after.name, 'Source');
    // Moved games are APPENDED, keeping their order, after the target's own.
    assert.deepEqual(target.games.map((g) => g.title), ['Keeper', 'Tagged', 'Plain', 'Archived']);

    // A true reparent: ids, covers and archived state survive.
    assert.equal(target.games.find((g) => g.title === 'Plain').id, plain.id);
    assert.equal(target.games.find((g) => g.title === 'Plain').image, '/uploads/a.jpg');
    assert.equal(target.games.find((g) => g.title === 'Archived').retired, true);

    // The reused tag keeps the TARGET's id AND its own spelling — matching is
    // case-insensitive, but the target round is never renamed by the move. The
    // unmatched source tag becomes a fresh tag there; the unused one is skipped.
    assert.deepEqual(target.tags.map((tg) => tg.name), ['oUTSIDE', 'Party']);
    const created = target.tags.find((tg) => tg.name === 'Party');
    assert.equal(target.tags[0].id, dstOutside.id);
    assert.notEqual(created.id, party.id);
    assert.deepEqual(target.games.find((g) => g.id === tagged.id).tagIds, [dstOutside.id, created.id]);

    // An icon rides along with a newly created tag, but a REUSED one is never
    // restyled — same rule addTag applies to a duplicate name (#255). ('Outside'
    // carries 'tent' in the source; the target's same-named tag has no icon.)
    assert.equal(created.icon, 'confetti');
    assert.equal('icon' in target.tags[0], false);
    // The source keeps its own tag list, including the one no moved game used —
    // an unused round tag is not invalid and is never cleaned up here.
    assert.deepEqual((await repo.getRound(T, src.id)).tags.map((tg) => tg.id), [outside.id, party.id, unused.id]);

    // One bulk entry per round, not one per game.
    const outFeed = await repo.listActivities(T, src.id);
    const inFeed = await repo.listActivities(T, dst.id);
    const movedOut = outFeed.filter((a) => a.type === 'games_moved_out');
    const movedIn = inFeed.filter((a) => a.type === 'games_moved_in');
    assert.equal(movedOut.length, 1);
    assert.equal(movedIn.length, 1);
    assert.equal(movedOut[0].count, 3);
    assert.equal(movedOut[0].roundId, dst.id);
    assert.equal(movedOut[0].roundName, 'Target');
    assert.equal(movedIn[0].roundName, 'Source');
  });

  test('moveGames scrubs the source round\'s sessions and leaves the target\'s alone', async () => {
    const src = await freshRound();
    const dst = await freshRound();
    const moved = await repo.createGame(T, src.id, gameFields({ title: 'Moved' }));
    const stays = await repo.createGame(T, dst.id, gameFields({ title: 'Stays' }));
    const mid = src.members[0].id;

    const session = await repo.createSession(T, src.id, {
      createdAt: 't', gameIds: [moved.id], votes: { [mid]: { [moved.id]: 5 } },
      chosenGameId: moved.id, chosenAt: 't', finished: true, finishedAt: 't',
      winnerIds: [mid], cancelled: false, cancelledAt: null, done: true,
    });
    const kept = await repo.createSession(T, dst.id, {
      createdAt: 't', gameIds: [stays.id], votes: { [dst.members[0].id]: { [stays.id]: 4 } },
      chosenGameId: stays.id, chosenAt: 't', finished: true, finishedAt: 't',
      winnerIds: [], cancelled: false, cancelledAt: null, done: true,
    });

    await repo.moveGames(T, src.id, dst.id);

    // The session held only the moved game, so it is dropped outright — exactly
    // what deleteGame does with a session left holding nothing.
    const after = await repo.getRound(T, src.id);
    assert.deepEqual(after.sessions, []);
    assert.equal(session.gameIds.length, 1); // it really did hold just the one

    // The target's own history is untouched by the move.
    const target = await repo.getRound(T, dst.id);
    const survivor = target.sessions.find((s) => s.id === kept.id);
    assert.deepEqual(survivor.gameIds, [stays.id]);
    assert.equal(survivor.chosenGameId, stays.id);
    assert.equal(survivor.finished, true);
  });

  test('moveGames partially scrubs a session that keeps another game', async () => {
    const src = await freshRound();
    const dst = await freshRound();
    // A session referencing an id that isn't a game of this round ('ghost' —
    // the shape a session can be left in) survives the move, so this exercises
    // the scrub path rather than the drop-the-session path above.
    const a = await repo.createGame(T, src.id, gameFields({ title: 'A' }));
    const mid = src.members[0].id;
    await repo.createSession(T, src.id, {
      createdAt: 't', gameIds: [a.id, 'ghost'], votes: { [mid]: { [a.id]: 3, ghost: 2 } },
      chosenGameId: a.id, chosenAt: 't', finished: true, finishedAt: 't',
      winnerIds: [mid], cancelled: false, cancelledAt: null, done: true,
    });

    await repo.moveGames(T, src.id, dst.id);

    // 'ghost' keeps the session alive, so it is scrubbed rather than dropped:
    // the moved game leaves gameIds and every vote map, and the choice + finish
    // state it carried is reset.
    const [session] = (await repo.getRound(T, src.id)).sessions;
    assert.deepEqual(session.gameIds, ['ghost']);
    assert.deepEqual(session.votes[mid], { ghost: 2 });
    assert.equal(session.chosenGameId, null);
    assert.equal(session.chosenAt, null);
    assert.equal(session.finished, false);
    assert.equal(session.finishedAt, null);
    assert.deepEqual(session.winnerIds, []);
  });

  test('moveGames refuses a missing, identical or over-quota target', async () => {
    const src = await freshRound();
    const dst = await freshRound();

    assert.equal(await repo.moveGames(T, 'missing', dst.id), null);
    assert.equal(await repo.moveGames(T, src.id, 'missing'), null);
    assert.equal(await repo.moveGames(T, src.id, src.id), 'same_round');
    // Identity is decided BEFORE the round lookup, so a missing id answers the
    // same either way — the two backends check in that order or they diverge.
    assert.equal(await repo.moveGames(T, 'missing', 'missing'), 'same_round');

    const tag = await repo.addTag(T, src.id, 'Solo');
    await repo.createGame(T, src.id, gameFields({ title: 'One', tagIds: [tag.id] }));
    await repo.createGame(T, src.id, gameFields({ title: 'Two' }));

    // Both caps refuse ATOMICALLY — nothing moves, no tag is created.
    assert.equal(await repo.moveGames(T, src.id, dst.id, { maxGames: 1, maxTags: 99 }), 'quota_games');
    assert.equal(await repo.moveGames(T, src.id, dst.id, { maxGames: 99, maxTags: 0 }), 'quota_tags');
    const untouched = await repo.getRound(T, dst.id);
    assert.deepEqual(untouched.games, []);
    assert.equal('tags' in untouched, false); // still absent, not an empty array
    assert.equal((await repo.getRound(T, src.id)).games.length, 2);

    // Within the caps it goes through.
    const ok = await repo.moveGames(T, src.id, dst.id, { maxGames: 2, maxTags: 1 });
    assert.deepEqual(ok, { movedGames: 2, mergedTags: 0, createdTags: 1 });
  });

  test('moveGames on an empty source round is a no-op with no feed entry', async () => {
    const src = await freshRound();
    const dst = await freshRound();
    const result = await repo.moveGames(T, src.id, dst.id);
    assert.deepEqual(result, { movedGames: 0, mergedTags: 0, createdTags: 0 });
    assert.deepEqual(await repo.listActivities(T, src.id), []);
    assert.deepEqual(await repo.listActivities(T, dst.id), []);
  });

  test('listActivities serves the feed; rounds no longer embed it', async () => {
    const round = await freshRound();
    assert.equal('activities' in round, false); // not on the created round…
    await repo.createGame(T, round.id, gameFields());
    assert.equal('activities' in (await repo.getRound(T, round.id)), false); // …nor on getRound
    const feed = await repo.listActivities(T, round.id);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].type, 'game_added');
    assert.match(feed[0].id, /^[0-9a-f]{16}$/);
    assert.equal(await repo.listActivities(T, 'missing'), null);
  });

  test('deleteActivity removes a feed entry by id', async () => {
    const round = await freshRound();
    await repo.createGame(T, round.id, gameFields());
    const aid = (await repo.listActivities(T, round.id))[0].id;
    assert.equal(await repo.deleteActivity(T, round.id, aid), true);
    assert.equal(await repo.deleteActivity(T, round.id, aid), false);
    assert.equal((await repo.listActivities(T, round.id)).length, 0);
  });

  test('listRounds returns every round of the tenant assembled, in creation order', async () => {
    const a = await repo.createRound(T, { name: 'L-A', members: ['x'] });
    const b = await repo.createRound(T, { name: 'L-B', members: ['y', 'z'] });
    await repo.createGame(T, a.id, gameFields({ title: 'G', maxPlayers: 2 }));

    const all = await repo.listRounds(T);
    const byId = new Map(all.map((r) => [r.id, r]));
    assert.equal(byId.get(a.id).name, 'L-A');
    assert.equal(byId.get(a.id).games.length, 1); // children are assembled
    assert.equal(byId.get(a.id).background, null);
    assert.equal(byId.get(b.id).members.length, 2);
    // Creation order is preserved (a was created before b).
    assert.ok(all.findIndex((r) => r.id === a.id) < all.findIndex((r) => r.id === b.id));
  });

  test('updateMember applies a validated patch or reports missing', async () => {
    const round = await freshRound();
    const mid = round.members[0].id;
    const m = await repo.updateMember(T, round.id, mid, { name: 'Renamed', color: '#1d9e75' });
    assert.equal(m.name, 'Renamed');
    assert.equal(m.color, '#1d9e75');
    assert.equal(await repo.updateMember(T, round.id, 'nobody', { name: 'X' }), null);
    assert.equal(await repo.updateMember(T, 'nowhere', mid, { name: 'X' }), null);
  });

  /* ---------------------------- Tenant isolation (#136) ---------------------- */

  test('another tenant cannot read a round — every lookup is not-found', async () => {
    const round = await freshRound();
    await repo.createGame(T, round.id, gameFields());

    assert.equal(await repo.getRound(OTHER, round.id), null);
    assert.equal(await repo.listActivities(OTHER, round.id), null);
    assert.ok(!(await repo.listRounds(OTHER)).some((r) => r.id === round.id));
  });

  test('another tenant cannot mutate a round — every mutator is not-found', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields());
    const mid = round.members[0].id;
    const session = await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [game.id], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });

    assert.equal(await repo.createGame(OTHER, round.id, gameFields({ title: 'evil' })), null);
    assert.equal(await repo.updateGame(OTHER, round.id, game.id, { title: 'evil' }), null);
    assert.equal(await repo.retireGame(OTHER, round.id, game.id, true), null);
    assert.equal(await repo.deleteGame(OTHER, round.id, game.id), null);
    assert.equal(await repo.moveGames(OTHER, round.id, 'anywhere', null), null);
    assert.equal(await repo.updateMember(OTHER, round.id, mid, { name: 'evil' }), null);
    assert.equal(await repo.createSession(OTHER, round.id, { createdAt: 't', gameIds: [game.id], votes: {} }), null);
    assert.equal(await repo.setSessionChoice(OTHER, round.id, session.id, game.id), null);
    assert.equal(await repo.finishSession(OTHER, round.id, session.id, { finished: true, winnerIds: [] }), null);
    assert.equal(await repo.cancelSession(OTHER, round.id, session.id, true), null);
    assert.equal(await repo.removeSessionGame(OTHER, round.id, session.id, game.id), null);
    assert.equal(await repo.saveSessionResults(OTHER, round.id, session.id, {}), null);
    assert.equal(await repo.deleteSession(OTHER, round.id, session.id), false);
    assert.equal(await repo.setBackground(OTHER, round.id, { type: 'none' }), null);
    assert.equal(await repo.addTag(OTHER, round.id, 'evil'), null);
    assert.equal(await repo.deleteTag(OTHER, round.id, 'any'), false);
    assert.equal(await repo.deleteActivity(OTHER, round.id, 'any'), false);
    assert.equal(await repo.deleteRound(OTHER, round.id), null);

    // The round is fully intact for its own tenant after all of that.
    const intact = await repo.getRound(T, round.id);
    assert.equal(intact.games.length, 1);
    assert.equal(intact.games[0].title, 'A');
    assert.equal(intact.sessions.length, 1);
    assert.equal(intact.members.find((m) => m.id === mid).name, 'Alice');
  });

  test('createRound cannot import games from another tenant\'s round', async () => {
    const src = await freshRound();
    await repo.createGame(T, src.id, gameFields({ title: 'Mine' }));
    const copy = await repo.createRound(OTHER, { name: 'C', members: ['m'], importFromRoundId: src.id });
    assert.deepEqual(copy.games, []);
  });

  test('tenants list only their own rounds', async () => {
    const mine = await repo.createRound(T, { name: 'Mine', members: ['x'] });
    const theirs = await repo.createRound(OTHER, { name: 'Theirs', members: ['y'] });
    const ofT = await repo.listRounds(T);
    const ofOther = await repo.listRounds(OTHER);
    assert.ok(ofT.some((r) => r.id === mine.id));
    assert.ok(!ofT.some((r) => r.id === theirs.id));
    assert.ok(ofOther.some((r) => r.id === theirs.id));
    assert.ok(!ofOther.some((r) => r.id === mine.id));
  });

  /* -------------------------------- Users (#135) ----------------------------- */

  // Route-shaped user fields: every key present (null when unset) so both
  // backends round-trip identically — see .claude/rules/postgres-backend.md.
  // tenantId rides along since #136 (minted at registration).
  function userFields(over = {}) {
    return {
      email: `${uniq()}@example.com`,
      username: uniq(), // the app-wide public handle (#320), unique per call

      createdAt: '2026-07-18T00:00:00.000Z',
      tenantId: 'tenant-of-user',
      emailVerified: false,
      identities: [{ type: 'password', hash: 'argon2-hash' }],
      verification: { tokenHash: 'vh', expiresAt: '2027-01-01T00:00:00.000Z' },
      reset: null,
      refreshTokens: [],
      ...over,
    };
  }

  test('createUser mints an id, round-trips by id and email, enforces unique email', async () => {
    const fields = userFields();
    const user = await repo.createUser(fields);
    assert.match(user.id, /^[0-9a-f]{16}$/);
    assert.deepEqual(user, { id: user.id, ...fields });
    assert.deepEqual(await repo.getUserById(user.id), user);
    assert.deepEqual(await repo.getUserByEmail(fields.email), user);
    assert.equal(await repo.createUser(userFields({ email: fields.email })), 'email_taken');
    assert.equal(await repo.getUserById('nope'), null);
    assert.equal(await repo.getUserByEmail('nope@example.com'), null);
  });

  test('the username is app-wide unique case-insensitively and resolves either casing', async () => {
    const fields = userFields({ username: 'Anna_91' });
    const user = await repo.createUser(fields);
    assert.equal(user.username, 'Anna_91'); // stored exactly as typed

    // Matched case-insensitively in BOTH directions: the stored casing does not
    // decide what a lookup must spell.
    assert.deepEqual(await repo.getUserByUsername('Anna_91'), user);
    assert.deepEqual(await repo.getUserByUsername('anna_91'), user);
    assert.deepEqual(await repo.getUserByUsername('ANNA_91'), user);
    assert.equal(await repo.getUserByUsername('anna_9'), null);
    assert.equal(await repo.getUserByUsername(''), null);

    // A different casing is the SAME handle, so it is refused.
    assert.equal(await repo.createUser(userFields({ username: 'anna_91' })), 'username_taken');
    assert.equal(await repo.createUser(userFields({ username: 'ANNA_91' })), 'username_taken');
  });

  test('a taken username outranks a taken e-mail, so the open error cannot probe the hidden one', async () => {
    // routes/account.js answers username_taken openly (a public handle) but hides
    // email_taken behind { ok: true }. If a row colliding on BOTH reported the
    // e-mail, an attacker holding one taken username could ask "does this address
    // exist?" and read the answer off which error came back. The repo therefore
    // checks the username first — in both backends, whatever order the database's
    // own unique indexes would happen to fire in.
    const first = await repo.createUser(userFields());
    assert.equal(
      await repo.createUser(userFields({ email: first.email, username: first.username })),
      'username_taken',
    );
    // ...and a fresh username with that same e-mail still reports the e-mail.
    assert.equal(await repo.createUser(userFields({ email: first.email })), 'email_taken');
  });

  test('a forced rename (#320) replaces the username and frees the old one', async () => {
    const user = await repo.createUser(userFields({ username: 'Slur42' }));
    const neutral = `user-${user.id}`;
    await repo.updateUser(user.id, { username: neutral });

    assert.equal(await repo.getUserByUsername('slur42'), null); // released
    assert.equal((await repo.getUserByUsername(neutral)).id, user.id);
    // Releasing it must actually free it for someone else — a unique index that
    // kept the old value would make the rename a one-way loss of a handle.
    const other = await repo.createUser(userFields({ username: 'Slur42' }));
    assert.equal(other.username, 'Slur42');
  });

  test('updateUser replaces whole top-level keys; deleteUser reports found/again', async () => {
    const user = await repo.createUser(userFields());
    const tokens = [{ tokenHash: 'th', createdAt: 't', expiresAt: '2027-01-01T00:00:00.000Z' }];
    const updated = await repo.updateUser(user.id, {
      emailVerified: true, verification: null, refreshTokens: tokens,
    });
    assert.equal(updated.emailVerified, true);
    assert.equal(updated.verification, null);
    assert.deepEqual(updated.refreshTokens, tokens);
    assert.equal(updated.email, user.email); // untouched keys stay
    assert.equal(updated.tenantId, 'tenant-of-user'); // untouched keys stay
    assert.deepEqual(await repo.getUserById(user.id), updated);
    assert.equal(await repo.updateUser('nope', { emailVerified: true }), null);

    assert.equal(await repo.deleteUser(user.id), true);
    assert.equal(await repo.deleteUser(user.id), false);
    assert.equal(await repo.getUserById(user.id), null);
  });

  test('getUserById returns a snapshot: mutating it does not change the store', async () => {
    const user = await repo.createUser(userFields());
    const snap = await repo.getUserById(user.id);
    snap.emailVerified = true;
    snap.refreshTokens.push({ tokenHash: 'injected' });
    const again = await repo.getUserById(user.id);
    assert.equal(again.emailVerified, false);
    assert.deepEqual(again.refreshTokens, []);
  });

  /* --------------------------------- Inbox ---------------------------------- */
  /*
   * The per-user notification inbox (#207). Global and un-scoped like `users`,
   * but keyed by the RECIPIENT account id and reached from user-facing routes, so
   * every method must scope to that id — the isolation assertions below are the
   * point: user B's items are invisible to A, and A can neither mark nor dismiss
   * one of B's. (Contrast the moderation methods, which deliberately cross.)
   */

  const ALICE = 'user-alice';
  const BOB = 'user-bob';

  test('inbox: add mints the item; list returns the caller\'s items newest-first', async () => {
    const first = await repo.addInboxItem(ALICE, { type: 'round_invitation', payload: { roundName: 'Spieleabend' } });
    assert.match(first.id, /^[0-9a-f]{16}$/);
    assert.equal(first.userId, ALICE);
    assert.equal(first.type, 'round_invitation');
    assert.deepEqual(first.payload, { roundName: 'Spieleabend' });
    assert.equal(first.read, false);
    assert.match(first.createdAt, /^\d{4}-\d\d-\d\dT.*Z$/);

    const second = await repo.addInboxItem(ALICE, { type: 'friend_request', payload: { from: 'bob' } });
    assert.deepEqual((await repo.listInbox(ALICE)).map((i) => i.id), [second.id, first.id]); // newest first

    // A missing payload defaults to an empty object, never undefined.
    assert.deepEqual((await repo.addInboxItem(ALICE, { type: 'x' })).payload, {});
  });

  test('inbox: mark-read and dismiss operate on the caller\'s own item', async () => {
    const item = await repo.addInboxItem(ALICE, { type: 'round_invitation', payload: {} });

    const read = await repo.markInboxRead(ALICE, item.id);
    assert.equal(read.read, true);
    assert.equal((await repo.listInbox(ALICE)).find((i) => i.id === item.id).read, true);

    const removed = await repo.dismissInboxItem(ALICE, item.id);
    assert.equal(removed.id, item.id);
    assert.equal((await repo.listInbox(ALICE)).find((i) => i.id === item.id), undefined);

    // Gone now: both operations report not-found (null).
    assert.equal(await repo.markInboxRead(ALICE, item.id), null);
    assert.equal(await repo.dismissInboxItem(ALICE, item.id), null);
  });

  test('inbox: a user can never see, mark or dismiss another user\'s items', async () => {
    const mine = await repo.addInboxItem(ALICE, { type: 'round_invitation', payload: {} });
    await repo.addInboxItem(BOB, { type: 'round_invitation', payload: {} });

    const bobList = await repo.listInbox(BOB);
    assert.equal(bobList.every((i) => i.userId === BOB), true);
    assert.equal(bobList.some((i) => i.id === mine.id), false);

    // Bob cannot touch Alice's item — indistinguishable from not-found...
    assert.equal(await repo.markInboxRead(BOB, mine.id), null);
    assert.equal(await repo.dismissInboxItem(BOB, mine.id), null);
    // ...and Alice's item is untouched by the attempts.
    assert.equal((await repo.listInbox(ALICE)).find((i) => i.id === mine.id).read, false);
  });

  test('inbox: the per-user cap prunes the oldest on write (env MAX_INBOX_ITEMS)', async () => {
    const CAP = 'user-cap';
    const prev = process.env.MAX_INBOX_ITEMS;
    process.env.MAX_INBOX_ITEMS = '3';
    try {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await repo.addInboxItem(CAP, { type: 'x', payload: { i } })).id);
      // Only the newest 3 survive, newest first.
      assert.deepEqual((await repo.listInbox(CAP)).map((i) => i.id), [ids[4], ids[3], ids[2]]);
    } finally {
      if (prev === undefined) delete process.env.MAX_INBOX_ITEMS;
      else process.env.MAX_INBOX_ITEMS = prev;
    }
  });

  /* ------------------------------- Moderation ------------------------------- */
  /*
   * The operator methods (#268) are the one deliberately CROSS-TENANT read path:
   * an abuse notice names an image, not a tenant. So unlike every other case in
   * this suite, these assert that a lookup DOES see tenant OTHER's row — that is
   * the feature, and on Postgres it is what proves the read-only RLS admin
   * escape (migration 20260720140000) actually works under FORCE RLS.
   */

  test('findImageOwner resolves an image to its game/round/tenant, across tenants', async () => {
    const mine = await freshRound();
    await repo.createGame(T, mine.id, gameFields({ title: 'Mine', image: '/uploads/mine.jpg' }));

    const theirs = await repo.createRound(OTHER, { name: 'Their round', members: ['Zoe'] });
    await repo.createGame(OTHER, theirs.id, gameFields({ title: 'Theirs', image: '/uploads/theirs.jpg' }));

    const own = await repo.findImageOwner('/uploads/mine.jpg');
    assert.equal(own.tenantId, T);
    assert.equal(own.roundId, mine.id);
    assert.equal(own.roundName, 'R');
    assert.equal(own.gameTitle, 'Mine');
    assert.equal(own.image, '/uploads/mine.jpg');

    // The point of the operator lookup: another tenant's object resolves too.
    const other = await repo.findImageOwner('/uploads/theirs.jpg');
    assert.equal(other.tenantId, OTHER);
    assert.equal(other.gameTitle, 'Theirs');

    assert.equal(await repo.findImageOwner('/uploads/nobody.jpg'), null);
  });

  test('takedownImage clears the cover across tenants and reports the count', async () => {
    const mine = await freshRound();
    const g1 = await repo.createGame(T, mine.id, gameFields({ title: 'One', image: '/uploads/bad.jpg' }));
    const theirs = await repo.createRound(OTHER, { name: 'Their round', members: ['Zoe'] });
    await repo.createGame(OTHER, theirs.id, gameFields({ title: 'Two', image: '/uploads/bad.jpg' }));
    // An unrelated cover must survive.
    const keep = await repo.createGame(T, mine.id, gameFields({ title: 'Keep', image: '/uploads/ok.jpg' }));

    assert.equal(await repo.takedownImage('/uploads/bad.jpg'), 2);

    const after = await repo.getRound(T, mine.id);
    assert.equal(after.games.find((g) => g.id === g1.id).image, null);
    assert.equal(after.games.find((g) => g.id === keep.id).image, '/uploads/ok.jpg');
    const afterOther = await repo.getRound(OTHER, theirs.id);
    assert.equal(afterOther.games[0].image, null);

    // Nothing references it any more, so a repeat is an honest no-op.
    assert.equal(await repo.takedownImage('/uploads/bad.jpg'), 0);
    assert.equal(await repo.findImageOwner('/uploads/bad.jpg'), null);
    // The takedown must not have widened writes: the untouched game is intact.
    assert.equal(await repo.isImageReferenced(T, '/uploads/ok.jpg'), true);
  });

  /* ------------------- Broader lookup & redaction (#275) -------------------- */
  /*
   * Cross-tenant like the #268 methods above, and for the same reason: a notice
   * names a round link or an e-mail address, not a tenant. Note what these
   * assertions can and cannot prove on Postgres — the suite connects as a
   * SUPERUSER, which bypasses RLS entirely, so "the redaction landed" here does
   * not prove it would land on a hardened deploy. That is what the plain-role
   * probe in test/repo.postgres.test.js exists for.
   */

  test('findRoundOwner resolves a round to its tenant, across tenants', async () => {
    const mine = await freshRound({ name: 'Mine' });
    const theirs = await repo.createRound(OTHER, { name: 'Theirs', members: ['Zoe'] });

    const own = await repo.findRoundOwner(mine.id);
    assert.deepEqual(own, { roundId: mine.id, roundName: 'Mine', tenantId: T });

    // The point of the operator lookup: another tenant's round resolves too.
    const other = await repo.findRoundOwner(theirs.id);
    assert.equal(other.tenantId, OTHER);
    assert.equal(other.roundName, 'Theirs');

    assert.equal(await repo.findRoundOwner('nosuchround'), null);
  });

  test('tenantSummary counts what a tenant holds and collects its cover paths', async () => {
    const round = await freshRound({ name: 'Summary' });
    await repo.createGame(T, round.id, gameFields({ title: 'Active', image: '/uploads/s1.jpg' }));
    const gone = await repo.createGame(T, round.id, gameFields({ title: 'Gone', image: '/uploads/s2.jpg' }));
    // A second reference to an already-collected path: an imported round shares
    // the path rather than the file, so `images` must be deduped.
    await repo.createGame(T, round.id, gameFields({ title: 'Dup', image: '/uploads/s1.jpg' }));
    await repo.retireGame(T, round.id, gone.id, true);
    await repo.addTag(T, round.id, 'Koop', null);
    await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });

    const summary = await repo.tenantSummary(T);
    const row = summary.rounds.find((r) => r.id === round.id);
    assert.equal(row.name, 'Summary');
    assert.equal(row.games, 3);
    // An archived game still holds a row and a cover, so it counts here — but
    // not as ACTIVE (.claude/rules/active-games-filter-sites.md).
    assert.equal(row.activeGames, 2);
    assert.equal(row.members, 2);
    assert.equal(row.sessions, 1);
    assert.equal(row.tags, 1);

    // Counts must be real numbers on both backends: Postgres count() is a
    // bigint that pg hands back as a STRING, which would make the totals below
    // concatenate instead of add (#288's lesson, applied to new counts).
    for (const key of ['rounds', 'games', 'activeGames', 'sessions', 'members', 'tags']) {
      assert.equal(typeof summary.totals[key], 'number', key);
    }
    assert.equal(summary.totals.rounds, summary.rounds.length);
    assert.equal(
      summary.totals.games,
      summary.rounds.reduce((n, r) => n + r.games, 0),
    );

    // Deduped, and scoped to this tenant.
    assert.equal(summary.images.filter((i) => i === '/uploads/s1.jpg').length, 1);
    assert.ok(summary.images.includes('/uploads/s2.jpg'));

    // A tenant with nothing is an empty summary, not null — the operator asked
    // about a real account and gets a real (empty) answer.
    const empty = await repo.tenantSummary('tenant-with-no-rounds');
    assert.deepEqual(empty.rounds, []);
    assert.equal(empty.totals.rounds, 0);
    assert.deepEqual(empty.images, []);
  });

  test('roundContent lists a round\'s user-authored text', async () => {
    const round = await freshRound({ name: 'Content' });
    const game = await repo.createGame(T, round.id, gameFields({ title: 'Catan' }));
    const tag = await repo.addTag(T, round.id, 'Koop', null);

    const content = await repo.roundContent(round.id);
    assert.equal(content.roundId, round.id);
    assert.equal(content.roundName, 'Content');
    assert.equal(content.tenantId, T);
    assert.deepEqual(content.members.map((m) => m.name), ['Alice', 'Bob']);
    assert.deepEqual(content.games, [{ id: game.id, title: 'Catan' }]);
    assert.deepEqual(content.tags, [{ id: tag.id, name: 'Koop' }]);

    assert.equal(await repo.roundContent('nosuchround'), null);
  });

  test('redactText blanks one text field and returns what was there', async () => {
    const round = await freshRound({ name: 'Bad round name' });
    const game = await repo.createGame(T, round.id, gameFields({ title: 'Bad title' }));
    const tag = await repo.addTag(T, round.id, 'Bad tag', null);
    await repo.updateGame(T, round.id, game.id, { tagIds: [tag.id] });
    const before = await repo.getRound(T, round.id);
    const member = before.members[0];

    const r = await repo.redactText({ kind: 'round', roundId: round.id, id: round.id }, '[x]');
    assert.equal(r.previous, 'Bad round name');
    assert.equal(r.tenantId, T);
    assert.equal((await repo.getRound(T, round.id)).name, '[x]');

    const g = await repo.redactText({ kind: 'game', roundId: round.id, id: game.id }, '[x]');
    assert.equal(g.previous, 'Bad title');
    const m = await repo.redactText({ kind: 'member', roundId: round.id, id: member.id }, '[x]');
    assert.equal(m.previous, member.name);
    const tg = await repo.redactText({ kind: 'tag', roundId: round.id, id: tag.id }, '[x]');
    assert.equal(tg.previous, 'Bad tag');

    const after = await repo.getRound(T, round.id);
    assert.equal(after.games[0].title, '[x]');
    assert.equal(after.members[0].name, '[x]');
    assert.equal(after.tags[0].name, '[x]');
    // Redaction blanks TEXT and never deletes a row: the tag keeps its id, so
    // the game that carries it does not silently lose a tag as a side effect.
    assert.equal(after.tags[0].id, tag.id);
    assert.deepEqual(after.games[0].tagIds, [tag.id]);

    // Unknown targets are not-found, never a silent success.
    assert.equal(await repo.redactText({ kind: 'game', roundId: round.id, id: 'nope' }, '[x]'), null);
    assert.equal(await repo.redactText({ kind: 'round', roundId: 'nope', id: 'nope' }, '[x]'), null);
    assert.equal(await repo.redactText({ kind: 'tag', roundId: round.id, id: 'nope' }, '[x]'), null);

    // An unknown KIND is not-found too, on both backends. The route's z.enum
    // makes this unreachable today, but a `kind === 'game' ? games : members`
    // dispatch would quietly make members the fallback for anything it did not
    // recognise — so pin the refusal down rather than the enum.
    assert.equal(await repo.redactText({ kind: 'password', roundId: round.id, id: member.id }, '[x]'), null);
    assert.equal((await repo.getRound(T, round.id)).members[0].name, '[x]'); // unchanged by the above

    // A game id from ANOTHER round is not-found even though the id exists: the
    // read and the write are scoped to the named round on both backends.
    const other = await freshRound({ name: 'Elsewhere' });
    const elsewhere = await repo.createGame(T, other.id, gameFields({ title: 'Not yours' }));
    assert.equal(await repo.redactText({ kind: 'game', roundId: round.id, id: elsewhere.id }, '[x]'), null);
    assert.equal((await repo.getRound(T, other.id)).games[0].title, 'Not yours');
  });

  test('logModeration appends and listModeration returns newest first', async () => {
    const a = await repo.logModeration({ action: 'takedown', target: '/uploads/a.jpg', reason: 'notice 1', at: '2026-07-20T10:00:00.000Z' });
    assert.match(a.id, /^[0-9a-f]{16}$/);
    await repo.logModeration({ action: 'user_disabled', target: 'u1', reason: 'notice 2', at: '2026-07-20T11:00:00.000Z' });

    const log = await repo.listModeration(10);
    assert.equal(log.length, 2);
    assert.equal(log[0].action, 'user_disabled'); // newest first
    assert.equal(log[1].action, 'takedown');
    assert.equal(log[1].reason, 'notice 1');

    assert.equal((await repo.listModeration(1)).length, 1);
  });

  // Paging (#288). The two backends page from opposite ends internally — JSON
  // reverses an append-ordered array, Postgres runs orderBy('seq','desc') — so
  // an offset applied to the wrong end is exactly the kind of split only a
  // contract test catches. Asserted on identifiable entries, not just lengths.
  // This suite shares state across its cases, so everything below is relative to
  // the count on entry rather than an absolute total.
  test('listModeration pages backwards through history with (limit, offset)', async () => {
    const before = await repo.countModeration();
    for (const n of [1, 2, 3]) {
      await repo.logModeration({
        action: 'takedown', target: `/uploads/p${n}.jpg`, reason: `page ${n}`,
        at: `2026-07-20T1${n}:00:00.000Z`,
      });
    }
    assert.equal(await repo.countModeration(), before + 3);

    // The three newest are ours, newest first.
    assert.deepEqual((await repo.listModeration(2, 0)).map((e) => e.reason), ['page 3', 'page 2']);
    assert.equal((await repo.listModeration(1, 2))[0].reason, 'page 1');

    // Offsetting past the end is an empty page — not an error, and not a
    // wrapped-around one.
    assert.deepEqual(await repo.listModeration(2, before + 3), []);

    // Paging must partition: walking the whole log a page at a time yields every
    // entry exactly once, in the same order one big read gives.
    const whole = await repo.listModeration(before + 3, 0);
    const walked = [];
    for (let off = 0; off < before + 3; off += 2) walked.push(...await repo.listModeration(2, off));
    assert.deepEqual(walked.map((e) => e.id), whole.map((e) => e.id));
  });

  // Filtering (#275). The two backends implement it very differently — a JS
  // predicate over an array vs. `data->>'…'` SQL — so a disagreement about what
  // a filter MEANS (especially the inclusive date bounds) is exactly the split
  // only a shared contract catches.
  test('listModeration and countModeration narrow to a tenant, action and date range', async () => {
    const marker = 'filter-fixture';
    for (const [action, tenantId, at] of [
      ['takedown', 'f-tenant-1', '2026-07-18T09:00:00.000Z'],
      ['redact_game', 'f-tenant-1', '2026-07-19T09:00:00.000Z'],
      ['redact_game', 'f-tenant-2', '2026-07-20T09:00:00.000Z'],
      ['user_disabled', 'f-tenant-1', '2026-07-21T09:00:00.000Z'],
    ]) {
      await repo.logModeration({
        action, target: marker, reason: marker, at, tenantId,
      });
    }

    const reasons = async (filters) => (await repo.listModeration(100, 0, filters)).map((e) => e.at);

    // One tenant.
    const byTenant = { tenantId: 'f-tenant-1' };
    assert.equal(await repo.countModeration(byTenant), 3);
    assert.equal((await repo.listModeration(100, 0, byTenant)).every((e) => e.tenantId === 'f-tenant-1'), true);

    // One action, across tenants.
    assert.equal(await repo.countModeration({ action: 'redact_game' }), 2);

    // Combined filters are AND, not OR.
    assert.equal(await repo.countModeration({ action: 'redact_game', tenantId: 'f-tenant-2' }), 1);

    // Date bounds are INCLUSIVE at both ends — an entry exactly on the boundary
    // instant must be inside the range, not silently dropped from the record.
    const range = { from: '2026-07-19T00:00:00.000Z', to: '2026-07-20T23:59:59.999Z' };
    assert.deepEqual(await reasons({ ...range, action: 'redact_game' }), [
      '2026-07-20T09:00:00.000Z', '2026-07-19T09:00:00.000Z',
    ]);
    assert.equal(
      await repo.countModeration({ from: '2026-07-20T09:00:00.000Z', to: '2026-07-20T09:00:00.000Z', target: null }),
      1,
    );

    // The count must agree with the list, or the panel's "n von m" lies about
    // what the "Mehr laden" button can still reach.
    const combined = { tenantId: 'f-tenant-1', from: '2026-07-19T00:00:00.000Z' };
    assert.equal(await repo.countModeration(combined), (await repo.listModeration(100, 0, combined)).length);

    // Paging still partitions once a filter is on.
    assert.deepEqual(
      (await repo.listModeration(1, 1, byTenant)).map((e) => e.at),
      [(await repo.listModeration(100, 0, byTenant))[1].at],
    );

    // No filter (and an all-empty filter) means everything — the pre-#275 call.
    const all = await repo.countModeration();
    assert.equal(await repo.countModeration({}), all);
    assert.equal(await repo.countModeration({ tenantId: null, action: null, from: null, to: null }), all);
  });

  test('moderationActions lists the distinct action names present', async () => {
    await repo.logModeration({
      action: 'redact_member', target: 't', reason: 'r', at: '2026-07-21T12:00:00.000Z', tenantId: T,
    });
    const actions = await repo.moderationActions();
    assert.ok(actions.includes('redact_member'));
    // Distinct and sorted, so the panel's select has no duplicate options.
    assert.deepEqual(actions, [...new Set(actions)].sort());
  });

  // Feedback (#260) is global and un-scoped like the moderation log, so it is
  // covered here rather than among the tenant-isolation cases — there is no
  // tenant argument to isolate on. The submitter's tenant rides along inside
  // `context` as ordinary metadata.
  test('createFeedback appends and listFeedback returns newest first', async () => {
    const first = await repo.createFeedback({
      message: 'first note',
      context: { path: '/', locale: 'en', tenantId: T },
      createdAt: '2026-07-20T10:00:00.000Z',
    });
    assert.match(first.id, /^[0-9a-f]{16}$/);
    await repo.createFeedback({
      message: 'second note',
      context: { path: '/round/x', locale: 'de', tenantId: 'tenant-b', email: 'who@example.com' },
      createdAt: '2026-07-20T11:00:00.000Z',
    });

    const entries = await repo.listFeedback(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message, 'second note'); // newest first
    // Both tenants' feedback comes back from one un-scoped read — that IS the
    // contract here, the opposite of every round-scoped method above.
    assert.equal(entries[0].context.tenantId, 'tenant-b');
    assert.equal(entries[0].context.email, 'who@example.com');
    assert.equal(entries[1].message, 'first note');
    assert.equal(entries[1].context.tenantId, T);
    // An anonymous entry round-trips with the key genuinely absent, not as null
    // — both backends must agree (.claude/rules/postgres-backend.md).
    assert.equal(entries[1].context.email, undefined);

    assert.equal((await repo.listFeedback(1)).length, 1);
  });

  test('listFeedback pages and countFeedback totals the whole set (#288)', async () => {
    const before = await repo.countFeedback();
    for (const n of [1, 2, 3]) {
      await repo.createFeedback({
        message: `paged ${n}`,
        context: { path: '/', locale: 'de', tenantId: T },
        createdAt: `2026-07-20T1${n}:00:00.000Z`,
      });
    }
    assert.equal(await repo.countFeedback(), before + 3);

    assert.deepEqual((await repo.listFeedback(2, 0)).map((f) => f.message), ['paged 3', 'paged 2']);
    assert.equal((await repo.listFeedback(1, 2))[0].message, 'paged 1');
    assert.deepEqual(await repo.listFeedback(2, before + 3), []);

    // A count is a plain JS number on both backends — Postgres count() is a
    // bigint that pg returns as a string, so a missing coercion would split the
    // backends here rather than anywhere visible.
    assert.equal(typeof (await repo.countFeedback()), 'number');
  });

  // Contact notices (#272) follow the feedback pattern: global, un-scoped,
  // newest-first — the store behind POST /api/contact and the panel's
  // Meldungen inbox.
  test('createContactNotice appends; list pages newest first; count is a number', async () => {
    const first = await repo.createContactNotice({
      createdAt: '2026-07-21T10:00:00.000Z',
      name: 'Reporter',
      email: 'reporter@example.com',
      subject: null,
      message: 'That cover is mine',
      category: 'copyright',
      url: '/uploads/stolen.jpg',
      goodFaith: true,
      status: 'open',
      decidedAt: null,
      decisionNote: null,
      decisionSentAt: null,
    });
    assert.match(first.id, /^[0-9a-f]{16}$/);
    await repo.createContactNotice({
      createdAt: '2026-07-21T11:00:00.000Z',
      name: null,
      email: 'hi@example.com',
      subject: 'Frage',
      message: 'Just a question',
      category: null,
      url: null,
      goodFaith: null,
      status: 'open',
      decidedAt: null,
      decisionNote: null,
      decisionSentAt: null,
    });

    const entries = await repo.listContactNotices(10);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message, 'Just a question'); // newest first
    assert.equal(entries[1].category, 'copyright');
    // null round-trips as null on both backends (the always-present-keys shape
    // the users rows established — .claude/rules/postgres-backend.md).
    assert.equal(entries[0].category, null);
    assert.equal(entries[1].url, '/uploads/stolen.jpg');

    assert.equal((await repo.listContactNotices(1)).length, 1);
    assert.equal((await repo.listContactNotices(1, 1))[0].id, first.id);
    assert.equal(typeof (await repo.countContactNotices()), 'number');
    assert.equal(await repo.countContactNotices(), 2);
  });

  test('setContactNoticeStatus applies the decision fields; unknown id is null', async () => {
    const notice = (await repo.listContactNotices(10)).find((n) => n.category === 'copyright');
    const updated = await repo.setContactNoticeStatus(notice.id, {
      status: 'actioned',
      decidedAt: '2026-07-21T12:00:00.000Z',
      decisionNote: 'Cover entfernt',
      decisionSentAt: '2026-07-21T12:00:00.000Z',
    });
    assert.equal(updated.status, 'actioned');
    assert.equal(updated.decisionNote, 'Cover entfernt');
    // The untouched submission fields survive the patch.
    assert.equal(updated.message, 'That cover is mine');

    const reread = await repo.getContactNotice(notice.id);
    assert.equal(reread.status, 'actioned');
    assert.equal(reread.decidedAt, '2026-07-21T12:00:00.000Z');

    assert.equal(await repo.setContactNoticeStatus('doesnotexist', { status: 'rejected' }), null);
    assert.equal(await repo.getContactNotice('doesnotexist'), null);
  });

  // The Art. 17 statement flow (#272): load one entry, mark its statement sent.
  test('getModeration and markModerationStatement round-trip one log entry', async () => {
    const entry = await repo.logModeration({
      action: 'takedown', target: '/uploads/x.jpg', reason: 'NB §5', at: '2026-07-21T12:30:00.000Z',
      tenantId: T, gameTitle: 'Bad Game',
    });
    const loaded = await repo.getModeration(entry.id);
    assert.equal(loaded.gameTitle, 'Bad Game');
    // Not sent yet: the key is genuinely absent, not null — both backends agree.
    assert.equal(loaded.statementSentAt, undefined);

    const marked = await repo.markModerationStatement(entry.id, '2026-07-21T13:00:00.000Z');
    assert.equal(marked.statementSentAt, '2026-07-21T13:00:00.000Z');
    assert.equal(marked.reason, 'NB §5'); // the rest of the entry is untouched
    assert.equal((await repo.getModeration(entry.id)).statementSentAt, '2026-07-21T13:00:00.000Z');

    assert.equal(await repo.getModeration('doesnotexist'), null);
    assert.equal(await repo.markModerationStatement('doesnotexist', 'now'), null);
  });

  // The operator panel's "did this deploy migrate?" field (#274). Both backends
  // must answer in ONE shape, so the panel renders the same card either way —
  // the JSON backend has no schema, and says so, rather than throwing or
  // returning null and forcing a special case into the view.
  // Sits AFTER the feedback cases rather than with the other #275 ones on
  // purpose: this suite shares one dataset, and those cases assert absolute
  // feedback counts, so creating an entry before them would break them.
  test('redactText reaches another tenant\'s round and one feedback message', async () => {
    // Cross-tenant IS the contract for an operator method — a notice about
    // another tenant's round has to be actionable.
    const theirs = await repo.createRound(OTHER, { name: 'Their bad name', members: ['Zoe'] });
    const done = await repo.redactText({ kind: 'round', roundId: theirs.id, id: theirs.id }, '[x]');
    assert.equal(done.previous, 'Their bad name');
    assert.equal(done.tenantId, OTHER);
    assert.equal((await repo.getRound(OTHER, theirs.id)).name, '[x]');

    const fb = await repo.createFeedback({
      message: 'illegal text',
      context: { path: '/', locale: 'de', tenantId: OTHER },
      createdAt: '2026-07-21T10:00:00.000Z',
    });
    const red = await repo.redactText({ kind: 'feedback', roundId: null, id: fb.id }, '[x]');
    assert.equal(red.previous, 'illegal text');
    // Feedback is global, so its tenant comes off the stored context.
    assert.equal(red.tenantId, OTHER);
    assert.equal(red.roundId, null);

    const stored = (await repo.listFeedback(50)).find((f) => f.id === fb.id);
    assert.equal(stored.message, '[x]');
    // The rest of the entry is untouched — the redaction is one field, not the row.
    assert.equal(stored.context.path, '/');

    assert.equal(await repo.redactText({ kind: 'feedback', roundId: null, id: 'nope' }, '[x]'), null);
  });

  test('migrationStatus reports the schema state in a backend-agnostic shape', async () => {
    const status = await repo.migrationStatus();
    assert.ok(['json', 'postgres'].includes(status.backend));
    assert.equal(typeof status.pending, 'number');
    // A freshly initialised store is fully migrated either way.
    assert.equal(status.pending, 0);
    if (status.backend === 'json') {
      assert.equal(status.latest, null);
    } else {
      // init() ran migrate.latest(), so a real migration name must be recorded.
      assert.match(status.latest, /^\d+_/);
    }
  });

  // The suite shares one store across cases, so assert on the delta, not on an
  // absolute count — other tests have already created users by now.
  test('listUsers returns every user for the operator account list', async () => {
    const before = await repo.listUsers();
    // userFields() mints a random e-mail; don't hardcode one, or a re-run
    // against a persistent database hits 'email_taken' and silently inserts
    // nothing.
    const u1 = await repo.createUser(userFields());
    const u2 = await repo.createUser(userFields());
    const after = await repo.listUsers();
    assert.equal(after.length, before.length + 2);
    const ids = after.map((u) => u.id);
    assert.ok(ids.includes(u1.id) && ids.includes(u2.id));
    // Full stored shape, so the route knows what it must strip before responding.
    assert.deepEqual(after.find((u) => u.id === u1.id), u1);
  });

  /* ---------------------- Erasure & export (#273) ---------------------------- */
  /*
   * These use their own throwaway tenants rather than T: eraseAccount deletes
   * EVERY round of a tenant, which would pull the shared fixtures out from under
   * the rest of the suite.
   */

  test('exportTenant returns the tenant\'s rounds INCLUDING the activity feed', async () => {
    const tenant = `exp-${Math.random().toString(16).slice(2)}`;
    const round = await repo.createRound(tenant, { name: 'Exported', members: ['Ann'] });
    await repo.createGame(tenant, round.id, gameFields({ title: 'A game' }));

    const out = await repo.exportTenant(tenant);
    assert.equal(out.tenantId, tenant);
    assert.equal(out.rounds.length, 1);
    assert.equal(out.rounds[0].name, 'Exported');
    assert.equal(out.rounds[0].members[0].name, 'Ann');
    assert.equal(out.rounds[0].games[0].title, 'A game');
    // The whole point of the export vs. a snapshot: the feed is held data, so an
    // Art. 15 answer has to include it (getRound deliberately omits it, #197).
    assert.ok(Array.isArray(out.rounds[0].activities));
    assert.equal(out.rounds[0].activities.some((a) => a.type === 'game_added'), true);
    // Scoping metadata is ours, not the subject's.
    assert.equal('tenantId' in out.rounds[0], false);

    // Another tenant's rounds never ride along.
    const other = await repo.createRound(`${tenant}-x`, { name: 'Not theirs', members: ['Zoe'] });
    assert.equal((await repo.exportTenant(tenant)).rounds.some((r) => r.id === other.id), false);

    // An account with no tenant exports nothing rather than throwing.
    assert.deepEqual(await repo.exportTenant(null), { tenantId: null, rounds: [] });
  });

  test('eraseAccount removes the user, cascades the tenant and reports freed images', async () => {
    const tenant = `era-${Math.random().toString(16).slice(2)}`;
    const user = await repo.createUser(userFields({ tenantId: tenant }));
    const round = await repo.createRound(tenant, { name: 'Erased', members: ['Ann'] });
    await repo.createGame(tenant, round.id, gameFields({ title: 'With cover', image: '/uploads/era1.jpg' }));
    await repo.createGame(tenant, round.id, gameFields({ title: 'No cover', image: null }));
    // A second round of the same tenant, so the cascade is proven to be
    // tenant-wide and not just "the one round".
    const second = await repo.createRound(tenant, { name: 'Also erased', members: ['Bo'] });
    await repo.createGame(tenant, second.id, gameFields({ title: 'Another', image: '/uploads/era2.jpg' }));

    // A neighbouring tenant that must survive untouched.
    const keep = `${tenant}-keep`;
    const kept = await repo.createRound(keep, { name: 'Kept', members: ['Zoe'] });

    const out = await repo.eraseAccount(user.id);
    assert.equal(out.tenantId, tenant);
    assert.equal(out.rounds, 2);
    assert.deepEqual([...out.images].sort(), ['/uploads/era1.jpg', '/uploads/era2.jpg']);

    // The identity row and every round of that tenant are gone…
    assert.equal(await repo.getUserById(user.id), null);
    assert.deepEqual(await repo.listRounds(tenant), []);
    assert.equal(await repo.getRound(tenant, round.id), null);
    // …and the children went with them (the image is no longer referenced
    // anywhere, which is what makes deleting the object safe).
    assert.equal(await repo.findImageOwner('/uploads/era1.jpg'), null);
    // …while the neighbouring tenant is untouched.
    assert.equal((await repo.getRound(keep, kept.id)).name, 'Kept');

    // Erasing again is a plain not-found, never a second cascade.
    assert.equal(await repo.eraseAccount(user.id), null);
    assert.equal(await repo.eraseAccount('nope'), null);
  });

  test('eraseAccount refuses when a second account shares the tenant', async () => {
    const tenant = `shared-${Math.random().toString(16).slice(2)}`;
    const a = await repo.createUser(userFields({ tenantId: tenant }));
    const b = await repo.createUser(userFields({ tenantId: tenant }));
    const round = await repo.createRound(tenant, { name: 'Shared data', members: ['Ann'] });

    // Refusing is the point: the round data is partly the co-tenant's, and
    // cascading it would be an unrequested deletion of a third party's data.
    assert.equal(await repo.eraseAccount(a.id), 'tenant_shared');
    assert.ok(await repo.getUserById(a.id), 'the refusal must not have deleted the user');
    assert.equal((await repo.getRound(tenant, round.id)).name, 'Shared data');

    // Once the co-tenant is gone, the same call goes through.
    await repo.deleteUser(b.id);
    const out = await repo.eraseAccount(a.id);
    assert.equal(out.rounds, 1);
  });

  test('eraseAccount deletes an account that has no tenant data at all', async () => {
    const user = await repo.createUser(userFields({ tenantId: null }));
    const out = await repo.eraseAccount(user.id);
    assert.deepEqual(out, { tenantId: null, rounds: 0, images: [] });
    assert.equal(await repo.getUserById(user.id), null);
  });

  test('updateMember links and unlinks a user', async () => {
    const user = await repo.createUser(userFields({ email: 'fixed@example.com' }));

    const round = await freshRound();
    const mid = round.members[0].id;
    const linked = await repo.updateMember(T, round.id, mid, { userId: user.id });
    assert.equal(linked.userId, user.id);
    const unlinked = await repo.updateMember(T, round.id, mid, { userId: null });
    assert.equal(unlinked.userId, null);
  });
};
