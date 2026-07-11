'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

// The palette shared with the frontend (public/js/core.js / routes/members.js).
const A_VALID_COLOR = '#7f77dd';

test('PATCH member updates the name', async () => {
  const round = await createRound(request);
  const member = round.members[0];
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/members/${member.id}`)
    .send({ name: '  Alicia  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Alicia'); // trimmed

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(detail.body.members.find((m) => m.id === member.id).name, 'Alicia');
});

test('PATCH member updates the color to a palette value', async () => {
  const round = await createRound(request);
  const member = round.members[0];
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/members/${member.id}`)
    .send({ color: A_VALID_COLOR });
  assert.equal(res.status, 200);
  assert.equal(res.body.color, A_VALID_COLOR);

  const detail = await request(app).get(`/api/rounds/${round.id}`);
  assert.equal(detail.body.members.find((m) => m.id === member.id).color, A_VALID_COLOR);
});

test('PATCH member accepts name and color together', async () => {
  const round = await createRound(request);
  const member = round.members[0];
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/members/${member.id}`)
    .send({ name: 'Bo', color: A_VALID_COLOR });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Bo');
  assert.equal(res.body.color, A_VALID_COLOR);
});

test('PATCH member rejects an empty name', async () => {
  const round = await createRound(request);
  const member = round.members[0];
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/members/${member.id}`)
    .send({ name: '   ' });
  assert.equal(res.status, 400);
});

test('PATCH member rejects a color outside the palette', async () => {
  const round = await createRound(request);
  const member = round.members[0];
  const res = await request(app)
    .patch(`/api/rounds/${round.id}/members/${member.id}`)
    .send({ color: '#123456' });
  assert.equal(res.status, 400);
});

test('PATCH member 404s for an unknown round or member', async () => {
  const round = await createRound(request);
  assert.equal(
    (await request(app).patch(`/api/rounds/nope/members/x`).send({ name: 'X' })).status,
    404
  );
  assert.equal(
    (await request(app).patch(`/api/rounds/${round.id}/members/nope`).send({ name: 'X' })).status,
    404
  );
});
