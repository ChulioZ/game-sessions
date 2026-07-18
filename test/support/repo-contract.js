'use strict';

/*
 * The data-access-layer contract (issue #127), as a backend-parameterized suite.
 * Both backends must satisfy it identically: test/repo.test.js runs it against
 * the JSON backend, test/repo.postgres.test.js against PostgreSQL. Keeping it in
 * one place is what proves the Postgres backend is a faithful drop-in — the same
 * assertions, same expected shapes, against each implementation.
 *
 * Exported as a function taking the repo module (so it doesn't pick a backend
 * itself). It is under test/ so `node --test` may load it standalone; it
 * registers no tests until called, so that run is a harmless no-op.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

module.exports = function repoContract(repo) {
  async function freshRound(over = {}) {
    return repo.createRound({ name: 'R', members: ['Alice', 'Bob'], importFromRoundId: null, ...over });
  }

  test('createRound mints ids and getRound round-trips it', async () => {
    const created = await repo.createRound({ name: 'Spielrunde', members: ['Ann', 'Bo'] });
    assert.match(created.id, /^[0-9a-f]{16}$/);
    assert.equal(created.members.length, 2);
    assert.ok(created.members.every((m) => /^[0-9a-f]{16}$/.test(m.id)));
    assert.deepEqual(created.games, []);
    assert.equal(created.background, null);

    const fetched = await repo.getRound(created.id);
    assert.deepEqual(fetched, created);
  });

  test('getRound returns a snapshot: mutating it does not change the store', async () => {
    const round = await freshRound();
    const snap = await repo.getRound(round.id);
    snap.name = 'HACKED';
    snap.members.push({ id: 'x', name: 'Injected' });

    const again = await repo.getRound(round.id);
    assert.equal(again.name, 'R');
    assert.equal(again.members.length, 2);
  });

  test('getRound returns null for a missing round; deleteRound reports found/again', async () => {
    assert.equal(await repo.getRound('nope'), null);
    const round = await freshRound();
    assert.equal(await repo.deleteRound(round.id), true);
    assert.equal(await repo.deleteRound(round.id), false);
    assert.equal(await repo.getRound(round.id), null);
  });

  test('importRounds inserts full rounds preserving ids, references and shapes', async () => {
    // A whole round with fixed ids and every field kind (nested votes map, arrays,
    // background, recommendationRuns) — importRounds must round-trip it exactly.
    const round = {
      id: 'rnd_imported_1',
      name: 'Imported',
      members: [{ id: 'mem_a', name: 'A', color: '#1d9e75' }, { id: 'mem_b', name: 'B' }],
      games: [{
        id: 'game_x', title: 'X', platform: 'analog', type: 'analog', duration: 'medium',
        minPlayers: 1, maxPlayers: 4, image: '/uploads/x.jpg', retired: false, retiredAt: null,
      }],
      sessions: [{
        id: 'sess_1', createdAt: 't', gameIds: ['game_x'], votes: { mem_a: { game_x: { rating: 4 } } },
        chosenGameId: 'game_x', chosenAt: 't', finished: true, finishedAt: 't', winnerIds: ['mem_b'],
        cancelled: false, cancelledAt: null, done: true,
      }],
      activities: [{ id: 'act_1', type: 'game_added', at: 't', gameId: 'game_x', title: 'X' }],
      background: { type: 'theme', page: 'p', accent: 'a' },
      recommendationRuns: [{ id: 'run_1', items: [{ title: 'Y' }] }],
    };
    assert.equal(await repo.importRounds([round]), 1);
    // Every id, nested reference, and field kind survives the round-trip. The
    // activity feed is stored but served via listActivities, not on the round.
    const { activities, ...roundSansFeed } = round;
    assert.deepEqual(await repo.getRound('rnd_imported_1'), roundSansFeed);
    assert.deepEqual(await repo.listActivities('rnd_imported_1'), activities);
  });

  test('createRound import copies only active games (title/type/image) + logs them', async () => {
    const src = await freshRound();
    const active = await repo.createGame(src.id, {
      title: 'Catan', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 3, maxPlayers: 4, image: '/uploads/a.jpg', source: null,
    });
    const retired = await repo.createGame(src.id, {
      title: 'Old', platform: 'analog', type: 'analog', duration: 'short',
      minPlayers: 2, maxPlayers: 2, image: null, source: null,
    });
    await repo.retireGame(src.id, retired.id, true);

    const copy = await repo.createRound({ name: 'Copy', members: ['Z'], importFromRoundId: src.id });
    assert.equal(copy.games.length, 1);
    const g = copy.games[0];
    assert.equal(g.title, 'Catan');
    assert.equal(g.type, 'analog');
    assert.equal(g.image, '/uploads/a.jpg');
    assert.equal(g.retired, false);
    assert.notEqual(g.id, active.id); // a fresh id, not the source game's
    // duration/players are intentionally NOT carried over by import.
    assert.equal(g.duration, undefined);
    const feed = await repo.listActivities(copy.id);
    assert.equal(feed.filter((a) => a.type === 'game_added').length, 1);
  });

  test('updateGame applies only the given patch; unknown round/game -> null', async () => {
    const round = await freshRound();
    const game = await repo.createGame(round.id, {
      title: 'A', platform: 'ps', type: 'digital', duration: 'long',
      minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });
    const updated = await repo.updateGame(round.id, game.id, { title: 'B', duration: 'short' });
    assert.equal(updated.title, 'B');
    assert.equal(updated.duration, 'short');
    assert.equal(updated.platform, 'ps'); // untouched
    assert.equal(await repo.updateGame(round.id, 'missing', { title: 'X' }), null);
    assert.equal(await repo.updateGame('missing', game.id, { title: 'X' }), null);
  });

  test('deleteGame refuses active games, scrubs retired ones from sessions', async () => {
    const round = await freshRound();
    const game = await repo.createGame(round.id, {
      title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: '/uploads/x.png', source: null,
    });
    const keep = await repo.createGame(round.id, {
      title: 'B', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });
    const session = await repo.createSession(round.id, {
      createdAt: 't', gameIds: [game.id, keep.id], votes: { m1: { [game.id]: { rating: 5 } } },
      chosenGameId: game.id, chosenAt: 't', finished: true, finishedAt: 't', winnerIds: ['m1'],
      cancelled: false, cancelledAt: null, done: true,
    });

    assert.equal(await repo.deleteGame(round.id, game.id), 'not_retired');
    await repo.retireGame(round.id, game.id, true);
    const result = await repo.deleteGame(round.id, game.id);
    assert.deepEqual(result, { image: '/uploads/x.png' });

    const after = await repo.getRound(round.id);
    assert.equal(after.games.length, 1);
    const s = after.sessions.find((x) => x.id === session.id);
    assert.deepEqual(s.gameIds, [keep.id]); // scrubbed
    assert.equal(s.chosenGameId, null); // reset because the chosen game was deleted
    assert.equal(s.votes.m1[game.id], undefined);
    assert.ok((await repo.listActivities(round.id)).some((a) => a.type === 'game_deleted'));
    assert.equal(await repo.deleteGame(round.id, 'gone'), null);
  });

  test('isImageReferenced sees images across rounds', async () => {
    const round = await freshRound();
    await repo.createGame(round.id, {
      title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: '/uploads/shared.jpg', source: null,
    });
    assert.equal(await repo.isImageReferenced('/uploads/shared.jpg'), true);
    assert.equal(await repo.isImageReferenced('/uploads/none.jpg'), false);
  });

  test('session mutators persist through getRound', async () => {
    const round = await freshRound();
    const g = await repo.createGame(round.id, {
      title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });
    const session = await repo.createSession(round.id, {
      createdAt: 't', gameIds: [g.id], votes: {}, chosenGameId: null, chosenAt: null,
      finished: false, finishedAt: null, winnerIds: [], cancelled: false, cancelledAt: null, done: false,
    });
    assert.match(session.id, /^[0-9a-f]{16}$/);

    await repo.setSessionChoice(round.id, session.id, g.id);
    await repo.finishSession(round.id, session.id, { finished: true, winnerIds: ['m1'] });
    const after = (await repo.getRound(round.id)).sessions[0];
    assert.equal(after.chosenGameId, g.id);
    assert.equal(after.finished, true);
    assert.deepEqual(after.winnerIds, ['m1']);

    assert.equal(await repo.deleteSession(round.id, session.id), true);
    assert.equal(await repo.deleteSession(round.id, session.id), false);
  });

  test('setBackground returns the previous design and stores the new one', async () => {
    const round = await freshRound();
    const first = await repo.setBackground(round.id, { type: 'theme', page: 'p', accent: 'a' });
    assert.equal(first.previous, null);
    const second = await repo.setBackground(round.id, { type: 'none' });
    assert.deepEqual(second.previous, { type: 'theme', page: 'p', accent: 'a' });
    assert.deepEqual((await repo.getRound(round.id)).background, { type: 'none' });
    assert.equal(await repo.setBackground('missing', { type: 'none' }), null);
  });

  test('saveRecommendationRuns stores runs and retires the legacy object', async () => {
    const round = await freshRound();
    const runs = [{ id: 'r1', items: [{ title: 'X' }] }];
    const saved = await repo.saveRecommendationRuns(round.id, runs);
    assert.deepEqual(saved, runs);
    const fetched = await repo.getRound(round.id);
    assert.deepEqual(fetched.recommendationRuns, runs);
    assert.equal('recommendations' in fetched, false);
    assert.equal(await repo.saveRecommendationRuns('missing', runs), null);
  });

  test('listActivities serves the feed; rounds no longer embed it', async () => {
    const round = await freshRound();
    assert.equal('activities' in round, false); // not on the created round…
    await repo.createGame(round.id, {
      title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });
    assert.equal('activities' in (await repo.getRound(round.id)), false); // …nor on getRound
    const feed = await repo.listActivities(round.id);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].type, 'game_added');
    assert.match(feed[0].id, /^[0-9a-f]{16}$/);
    assert.equal(await repo.listActivities('missing'), null);
  });

  test('deleteActivity removes a feed entry by id', async () => {
    const round = await freshRound();
    await repo.createGame(round.id, {
      title: 'A', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 4, image: null, source: null,
    });
    const aid = (await repo.listActivities(round.id))[0].id;
    assert.equal(await repo.deleteActivity(round.id, aid), true);
    assert.equal(await repo.deleteActivity(round.id, aid), false);
    assert.equal((await repo.listActivities(round.id)).length, 0);
  });

  test('listRounds returns every round assembled, in creation order', async () => {
    const a = await repo.createRound({ name: 'L-A', members: ['x'] });
    const b = await repo.createRound({ name: 'L-B', members: ['y', 'z'] });
    await repo.createGame(a.id, {
      title: 'G', platform: 'analog', type: 'analog', duration: 'medium',
      minPlayers: 1, maxPlayers: 2, image: null, source: null,
    });

    const all = await repo.listRounds();
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
    const m = await repo.updateMember(round.id, mid, { name: 'Renamed', color: '#1d9e75' });
    assert.equal(m.name, 'Renamed');
    assert.equal(m.color, '#1d9e75');
    assert.equal(await repo.updateMember(round.id, 'nobody', { name: 'X' }), null);
    assert.equal(await repo.updateMember('nowhere', mid, { name: 'X' }), null);
  });

  /* -------------------------------- Users (#135) ----------------------------- */

  // Route-shaped user fields: every key present (null when unset) so both
  // backends round-trip identically — see .claude/rules/postgres-backend.md.
  function userFields(over = {}) {
    return {
      email: `u${Math.random().toString(16).slice(2)}@example.com`,
      createdAt: '2026-07-18T00:00:00.000Z',
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

  test('importUsers preserves ids; updateMember links and unlinks a user', async () => {
    const fixed = { id: 'usr_fixed_1', ...userFields({ email: 'fixed@example.com' }) };
    assert.equal(await repo.importUsers([fixed]), 1);
    assert.deepEqual(await repo.getUserById('usr_fixed_1'), fixed);

    const round = await freshRound();
    const mid = round.members[0].id;
    const linked = await repo.updateMember(round.id, mid, { userId: 'usr_fixed_1' });
    assert.equal(linked.userId, 'usr_fixed_1');
    const unlinked = await repo.updateMember(round.id, mid, { userId: null });
    assert.equal(unlinked.userId, null);
  });
};
