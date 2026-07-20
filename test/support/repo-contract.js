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

  test('deleteGame refuses active games, scrubs retired ones from sessions', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ image: '/uploads/x.png' }));
    const keep = await repo.createGame(T, round.id, gameFields({ title: 'B' }));
    const session = await repo.createSession(T, round.id, {
      createdAt: 't', gameIds: [game.id, keep.id], votes: { m1: { [game.id]: { rating: 5 } } },
      chosenGameId: game.id, chosenAt: 't', finished: true, finishedAt: 't', winnerIds: ['m1'],
      cancelled: false, cancelledAt: null, done: true,
    });

    assert.equal(await repo.deleteGame(T, round.id, game.id), 'not_retired');
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
      email: `u${Math.random().toString(16).slice(2)}@example.com`,
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
