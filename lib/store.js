'use strict';

/*
 * Tiny data layer: keeps the whole dataset in memory and persists it to a single
 * file data/data.json. Cover images are stored as files under data/uploads/;
 * data.json only holds the path.
 *
 * All user-specific data lives under one folder (data/) so it can be ignored by
 * git as a whole. Override the location with the DATA_DIR environment variable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Make sure the data + uploads folders exist (recursive creates DATA_DIR too).
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadData() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed.rounds)) parsed.rounds = [];
    if (!Array.isArray(parsed.users)) parsed.users = [];
    return parsed;
  } catch {
    // File missing or empty/corrupt -> start fresh.
    return { rounds: [], users: [] };
  }
}

// Stable reference: data is never reassigned after loading, only mutated.
const data = loadData();

// Writing is atomic (temp file first, then rename) so data.json is never left
// half-written after a crash.
function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

const id = () => crypto.randomBytes(8).toString('hex');

const findRound = (rid) => data.rounds.find((r) => r.id === rid);

// Append an activity entry to a round (for the activity feed).
function pushActivity(round, type, payload) {
  if (!Array.isArray(round.activities)) round.activities = [];
  round.activities.push({ id: id(), type, at: new Date().toISOString(), ...payload });
}

module.exports = { ROOT, DATA_DIR, DATA_FILE, UPLOAD_DIR, data, saveData, id, findRound, pushActivity };
