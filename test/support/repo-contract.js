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
    title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
    minPlayers: 1, maxPlayers: 4, image: null, source: null, ...over,
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
    assert.equal(await repo.deleteRound(T, round.id), true);
    assert.equal(await repo.deleteRound(T, round.id), false);
    assert.equal(await repo.getRound(T, round.id), null);
  });

  test('createRound import copies only active games (title/type/image) + logs them', async () => {
    const src = await freshRound();
    const active = await repo.createGame(T, src.id, gameFields({ title: 'Catan', minPlayers: 3, image: '/uploads/a.jpg' }));
    const retired = await repo.createGame(T, src.id, gameFields({ title: 'Old', duration: 'short', minPlayers: 2, maxPlayers: 2 }));
    await repo.retireGame(T, src.id, retired.id, true);

    const copy = await repo.createRound(T, { name: 'Copy', members: ['Z'], importFromRoundId: src.id });
    assert.equal(copy.games.length, 1);
    const g = copy.games[0];
    assert.equal(g.title, 'Catan');
    assert.equal(g.type, 'analog');
    assert.equal(g.image, '/uploads/a.jpg');
    assert.equal(g.retired, false);
    assert.notEqual(g.id, active.id); // a fresh id, not the source game's
    // duration/players are intentionally NOT carried over by import.
    assert.equal(g.duration, undefined);
    const feed = await repo.listActivities(T, copy.id);
    assert.equal(feed.filter((a) => a.type === 'game_added').length, 1);
  });

  test('updateGame applies only the given patch; unknown round/game -> null', async () => {
    const round = await freshRound();
    const game = await repo.createGame(T, round.id, gameFields({ platform: 'ps', type: 'digital', duration: 'long' }));
    const updated = await repo.updateGame(T, round.id, game.id, { title: 'B', duration: 'short' });
    assert.equal(updated.title, 'B');
    assert.equal(updated.duration, 'short');
    assert.equal(updated.platform, 'ps'); // untouched
    assert.equal(await repo.updateGame(T, round.id, 'missing', { title: 'X' }), null);
    assert.equal(await repo.updateGame(T, 'missing', game.id, { title: 'X' }), null);
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

  test('saveRecommendationRuns stores runs and retires the legacy object', async () => {
    const round = await freshRound();
    const runs = [{ id: 'r1', items: [{ title: 'X' }] }];
    const saved = await repo.saveRecommendationRuns(T, round.id, runs);
    assert.deepEqual(saved, runs);
    const fetched = await repo.getRound(T, round.id);
    assert.deepEqual(fetched.recommendationRuns, runs);
    assert.equal('recommendations' in fetched, false);
    assert.equal(await repo.saveRecommendationRuns(T, 'missing', runs), null);
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
    assert.equal(await repo.saveRecommendationRuns(OTHER, round.id, []), null);
    assert.equal(await repo.deleteActivity(OTHER, round.id, 'any'), false);
    assert.equal(await repo.deleteRound(OTHER, round.id), false);

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
