'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, createRound } = require('./helpers');

test('POST background stores a theme design as page + accent only', async () => {
  const round = await createRound(request);
  // A stray "pattern" (from the retired texture system) must not be stored.
  const res = await request(app)
    .post(`/api/rounds/${round.id}/background`)
    .send({ type: 'theme', page: '#eef2f7', accent: '#3a67b1', pattern: 'clouds' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.background, { type: 'theme', page: '#eef2f7', accent: '#3a67b1' });

  const list = await request(app).get('/api/rounds');
  const entry = list.body.find((r) => r.id === round.id);
  assert.deepEqual(entry.background, { type: 'theme', page: '#eef2f7', accent: '#3a67b1' });
});

test('POST background keeps the legacy plain-color form', async () => {
  const round = await createRound(request);
  const res = await request(app)
    .post(`/api/rounds/${round.id}/background`)
    .send({ type: 'color', color: '#fff7ed' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.background, { type: 'color', color: '#fff7ed' });
});

test('POST background resets to the default design with type none', async () => {
  const round = await createRound(request);
  await request(app)
    .post(`/api/rounds/${round.id}/background`)
    .send({ type: 'theme', page: '#f6ecf1', accent: '#b23a72' });
  const res = await request(app)
    .post(`/api/rounds/${round.id}/background`)
    .send({ type: 'none' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.background, { type: 'none' });
});

test('POST background rejects an unknown round', async () => {
  const res = await request(app)
    .post('/api/rounds/does-not-exist/background')
    .send({ type: 'none' });
  assert.equal(res.status, 404);
});
