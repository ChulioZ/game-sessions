'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

test('POST /api/rounds creates a round with cleaned members', async () => {
  const res = await request(app)
    .post('/api/rounds')
    .send({ name: '  The Smiths  ', members: ['Ann', '', '  Ben  '] });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'The Smiths');
  assert.deepEqual(res.body.members.map((m) => m.name), ['Ann', 'Ben']);
  assert.deepEqual(res.body.games, []);
});

test('POST /api/rounds rejects a missing name', async () => {
  const res = await request(app).post('/api/rounds').send({ members: ['Ann'] });
  assert.equal(res.status, 400);
});

test('POST /api/rounds rejects a round without members', async () => {
  const res = await request(app).post('/api/rounds').send({ name: 'Lonely' });
  assert.equal(res.status, 400);
});

test('GET /api/rounds returns a compact list counting only active games', async () => {
  const round = await createRound(request);
  await request(app)
    .post(`/api/rounds/${round.id}/games`)
    .field('title', 'Chess')
    .field('minPlayers', '2')
    .field('maxPlayers', '2');
  const res = await request(app).get('/api/rounds');
  assert.equal(res.status, 200);
  const entry = res.body.find((r) => r.id === round.id);
  assert.equal(entry.gameCount, 1);
  assert.equal(entry.memberCount, 2);
});

test('GET /api/rounds/:rid 404s for an unknown round', async () => {
  const res = await request(app).get('/api/rounds/does-not-exist');
  assert.equal(res.status, 404);
});

test('DELETE /api/rounds/:rid removes the round', async () => {
  const round = await createRound(request);
  const del = await request(app).delete(`/api/rounds/${round.id}`);
  assert.equal(del.status, 200);
  const res = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(res.status, 404);
});

test('importFromRoundId copies active games into the new round', async () => {
  const src = await createRound(request, { name: 'Source' });
  await request(app)
    .post(`/api/rounds/${src.id}/games`)
    .field('title', 'Catan')
    .field('minPlayers', '3')
    .field('maxPlayers', '4');
  const res = await request(app)
    .post('/api/rounds')
    .send({ name: 'Copy', members: ['Ann'], importFromRoundId: src.id });
  assert.equal(res.status, 201);
  assert.equal(res.body.games.length, 1);
  assert.equal(res.body.games[0].title, 'Catan');
});
