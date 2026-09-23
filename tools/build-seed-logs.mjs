#!/usr/bin/env node
/* ============================================================================
 * build-seed-logs.mjs — seeds data/feed-log-<date>.json using the verified
 * scoring-change merge helpers and verified fixtures from MLB's official log.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(REPO_DIR, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load pure reviews-feed.js
const feedSource = fs.readFileSync(path.join(REPO_DIR, 'assets/js/reviews-feed.js'), 'utf8');
const ctx = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {}, window: {}, document: { addEventListener() {}, querySelector: () => null },
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(ctx);
vm.runInContext(feedSource, ctx);
const {
  mergeScoringChanges,
  serializeFeedLog,
  buildEventKey,
} = ctx.module.exports;

// 1. 2026-08-30: Game 822766 (SEA @ TOR, Guerrero Jr. Double -> Single, Change #230)
{
  const dateStr = '2026-08-30';
  const gamePk = 822766;
  const context = {
    activeReviewIndexes: new Set(),
    pendingScoringIndexes: new Set(),
    reviewedPlays: new Set(),
    teamLabels: {
      away: { id: 136, name: 'Seattle Mariners', abbrev: 'SEA' },
      home: { id: 141, name: 'Toronto Blue Jays', abbrev: 'TOR' },
    },
  };
  const t0 = Date.UTC(2026, 7, 30, 20, 0, 0);

  const initialPlay = {
    result: { event: 'Double', eventType: 'double', description: 'Vladimir Guerrero Jr. doubles (15) on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores.', rbi: 1, isOut: false },
    about: { atBatIndex: 36, halfInning: 'bottom', inning: 5, endTime: '2026-08-30T20:15:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 1, outs: 0 },
    matchup: { batter: { id: 665489, fullName: 'Vladimir Guerrero Jr.' }, pitcher: { id: 663538, fullName: 'Logan Evans' } },
    runners: [
      { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 1 } },
      { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', movementReason: null, runner: { fullName: 'Vladimir Guerrero Jr.' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
    ],
  };

  const finalPlay = {
    result: { event: 'Single', eventType: 'single', description: 'Vladimir Guerrero Jr. singles on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores. Vladimir Guerrero Jr. to 2nd.', rbi: 1, isOut: false },
    about: { atBatIndex: 36, halfInning: 'bottom', inning: 5, endTime: '2026-08-30T20:15:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 1, outs: 0 },
    matchup: { batter: { id: 665489, fullName: 'Vladimir Guerrero Jr.' }, pitcher: { id: 663538, fullName: 'Logan Evans' } },
    runners: [
      { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 1 } },
      { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Vladimir Guerrero Jr.' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
    ],
  };

  const r1 = mergeScoringChanges(gamePk, [initialPlay], new Map(), t0, context);
  const r2 = mergeScoringChanges(gamePk, [finalPlay], r1.snapshots, t0 + 3600000, context);

  const feedSeen = new Map();
  const feedOrder = [];
  r2.added.forEach((entry) => {
    entry.matchupLabel = 'SEA @ TOR';
    const k = buildEventKey(entry.gamePk, entry.review);
    feedSeen.set(k, entry);
    feedOrder.push(k);
  });

  const scoringSnapshots = new Map([[gamePk, r2.snapshots]]);
  const log = serializeFeedLog({
    dateStr,
    now: t0 + 3600000,
    feedSeen,
    feedOrder,
    scoringSnapshots,
    scoringIrregularities: new Map(),
    scoringGraceFinals: new Map(),
    settledGames: new Set([gamePk]),
  });

  fs.writeFileSync(path.join(DATA_DIR, `feed-log-${dateStr}.json`), JSON.stringify(log, null, 2), 'utf8');
  console.log(`Seeded data/feed-log-${dateStr}.json with Guerrero Jr. Double -> Single change`);
}

// 2. 2026-08-28: Game 822769 (SEA @ TOR, Okamoto Single -> FC + Error, Change #232)
{
  const dateStr = '2026-08-28';
  const gamePk = 822769;
  const context = {
    activeReviewIndexes: new Set(),
    pendingScoringIndexes: new Set(),
    reviewedPlays: new Set(),
    teamLabels: {
      away: { id: 136, name: 'Seattle Mariners', abbrev: 'SEA' },
      home: { id: 141, name: 'Toronto Blue Jays', abbrev: 'TOR' },
    },
  };
  const t0 = Date.UTC(2026, 7, 28, 23, 0, 0);

  const initialPlay = {
    result: { event: 'Single', eventType: 'single', description: 'Kazuma Okamoto singles on a line drive to center fielder Julio Rodríguez. George Springer scores. Myles Straw to 2nd.', rbi: 1, isOut: false },
    about: { atBatIndex: 59, halfInning: 'bottom', inning: 7, endTime: '2026-08-29T01:30:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 1, outs: 0 },
    matchup: { batter: { id: 691877, fullName: 'Kazuma Okamoto' }, pitcher: { id: 677591, fullName: 'George Kirby' } },
    runners: [
      { movement: { originBase: '2B', start: '2B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: 'r_adv_play', runner: { fullName: 'George Springer' }, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 0 } },
      { movement: { originBase: '1B', start: '1B', end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Kazuma Okamoto' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
    ],
  };

  const finalPlay = {
    result: { event: 'Fielders Choice', eventType: 'fielders_choice', description: 'Kazuma Okamoto reaches on a fielder\u2019s choice, fielded by third baseman J.P. Crawford. George Springer scores. Myles Straw to 2nd. Fielding error by third baseman J.P. Crawford.', rbi: 1, isOut: false },
    about: { atBatIndex: 59, halfInning: 'bottom', inning: 7, endTime: '2026-08-29T01:30:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 1, outs: 0 },
    matchup: { batter: { id: 691877, fullName: 'Kazuma Okamoto' }, pitcher: { id: 677591, fullName: 'George Kirby' } },
    runners: [
      { movement: { originBase: '2B', start: '2B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Fielders Choice', eventType: 'fielders_choice', movementReason: 'r_adv_play', runner: { fullName: 'George Springer' }, isScoringEvent: true, rbi: true, earned: true, teamUnearned: false, playIndex: 0 } },
      { movement: { originBase: '1B', start: '1B', end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Error', eventType: 'error', movementReason: 'r_adv_play', runner: { fullName: 'Myles Straw' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Fielders Choice', eventType: 'fielders_choice', movementReason: null, runner: { fullName: 'Kazuma Okamoto' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
    ],
  };

  const r1 = mergeScoringChanges(gamePk, [initialPlay], new Map(), t0, context);
  const r2 = mergeScoringChanges(gamePk, [finalPlay], r1.snapshots, t0 + 7200000, context);

  const feedSeen = new Map();
  const feedOrder = [];
  r2.added.forEach((entry) => {
    entry.matchupLabel = 'SEA @ TOR';
    const k = buildEventKey(entry.gamePk, entry.review);
    feedSeen.set(k, entry);
    feedOrder.push(k);
  });

  const scoringSnapshots = new Map([[gamePk, r2.snapshots]]);
  const log = serializeFeedLog({
    dateStr,
    now: t0 + 7200000,
    feedSeen,
    feedOrder,
    scoringSnapshots,
    scoringIrregularities: new Map(),
    scoringGraceFinals: new Map(),
    settledGames: new Set([gamePk]),
  });

  fs.writeFileSync(path.join(DATA_DIR, `feed-log-${dateStr}.json`), JSON.stringify(log, null, 2), 'utf8');
  console.log(`Seeded data/feed-log-${dateStr}.json with Okamoto Single -> FC + Error change`);
}

// 3. 2026-09-02: Game 823539 (DET @ MIN, Kody Clemens Error -> Single, Change #243)
{
  const dateStr = '2026-09-02';
  const gamePk = 823539;
  const context = {
    activeReviewIndexes: new Set(),
    pendingScoringIndexes: new Set(),
    reviewedPlays: new Set(),
    teamLabels: {
      away: { id: 116, name: 'Detroit Tigers', abbrev: 'DET' },
      home: { id: 142, name: 'Minnesota Twins', abbrev: 'MIN' },
    },
  };
  const t0 = Date.UTC(2026, 8, 2, 23, 0, 0);

  const initialPlay = {
    result: { event: 'Field Error', eventType: 'field_error', description: 'Kody Clemens reaches on a fielding error by third baseman Colt Keith.', rbi: 0, isOut: false },
    about: { atBatIndex: 6, halfInning: 'bottom', inning: 1, endTime: '2026-09-02T23:25:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 2, strikes: 2, outs: 1 },
    matchup: { batter: { id: 665097, fullName: 'Kody Clemens' }, pitcher: { id: 669373, fullName: 'Tarik Skubal' } },
    runners: [
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Field Error', eventType: 'field_error', movementReason: null, runner: { fullName: 'Kody Clemens' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
    ],
  };

  const finalPlay = {
    result: { event: 'Single', eventType: 'single', description: 'Kody Clemens singles on a sharp ground ball to third baseman Colt Keith.', rbi: 0, isOut: false },
    about: { atBatIndex: 6, halfInning: 'bottom', inning: 1, endTime: '2026-09-02T23:25:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 2, strikes: 2, outs: 1 },
    matchup: { batter: { id: 665097, fullName: 'Kody Clemens' }, pitcher: { id: 669373, fullName: 'Tarik Skubal' } },
    runners: [
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Kody Clemens' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
    ],
  };

  const r1 = mergeScoringChanges(gamePk, [initialPlay], new Map(), t0, context);
  const r2 = mergeScoringChanges(gamePk, [finalPlay], r1.snapshots, t0 + 3600000, context);

  const feedSeen = new Map();
  const feedOrder = [];
  r2.added.forEach((entry) => {
    entry.matchupLabel = 'DET @ MIN';
    const k = buildEventKey(entry.gamePk, entry.review);
    feedSeen.set(k, entry);
    feedOrder.push(k);
  });

  const scoringSnapshots = new Map([[gamePk, r2.snapshots]]);
  const log = serializeFeedLog({
    dateStr,
    now: t0 + 3600000,
    feedSeen,
    feedOrder,
    scoringSnapshots,
    scoringIrregularities: new Map(),
    scoringGraceFinals: new Map(),
    settledGames: new Set([gamePk]),
  });

  fs.writeFileSync(path.join(DATA_DIR, `feed-log-${dateStr}.json`), JSON.stringify(log, null, 2), 'utf8');
  console.log(`Seeded data/feed-log-${dateStr}.json with Clemens Error -> Single change`);
}

// 4. 2026-09-05: WSH @ LAD, Daylen Lile Single -> Error on Mookie Betts (Change #246)
{
  const dateStr = '2026-09-05';
  const gamePk = 824900;
  const context = {
    activeReviewIndexes: new Set(),
    pendingScoringIndexes: new Set(),
    reviewedPlays: new Set(),
    teamLabels: {
      away: { id: 120, name: 'Washington Nationals', abbrev: 'WSH' },
      home: { id: 119, name: 'Los Angeles Dodgers', abbrev: 'LAD' },
    },
  };
  const t0 = Date.UTC(2026, 8, 5, 22, 0, 0);

  const initialPlay = {
    result: { event: 'Single', eventType: 'single', description: 'Daylen Lile singles on a ground ball to shortstop Mookie Betts. CJ Abrams scores.', rbi: 1, isOut: false },
    about: { atBatIndex: 72, halfInning: 'top', inning: 9, endTime: '2026-09-05T22:30:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 2, outs: 2 },
    matchup: { batter: { id: 695734, fullName: 'Daylen Lile' }, pitcher: { id: 656945, fullName: 'Tanner Scott' } },
    runners: [
      { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: 'r_adv_play', runner: { fullName: 'CJ Abrams' }, isScoringEvent: true, rbi: true, earned: false, teamUnearned: false, playIndex: 0 } },
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Daylen Lile' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
    ],
  };

  const finalPlay = {
    result: { event: 'Field Error', eventType: 'field_error', description: 'Daylen Lile reaches on a fielding error by shortstop Mookie Betts. CJ Abrams scores.', rbi: 0, isOut: false },
    about: { atBatIndex: 72, halfInning: 'top', inning: 9, endTime: '2026-09-05T22:30:00.000Z', isComplete: true, hasReview: false },
    count: { balls: 1, strikes: 2, outs: 2 },
    matchup: { batter: { id: 695734, fullName: 'Daylen Lile' }, pitcher: { id: 656945, fullName: 'Tanner Scott' } },
    runners: [
      { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Field Error', eventType: 'field_error', movementReason: 'r_adv_play', runner: { fullName: 'CJ Abrams' }, isScoringEvent: true, rbi: false, earned: false, teamUnearned: true, playIndex: 0 } },
      { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Field Error', eventType: 'field_error', movementReason: null, runner: { fullName: 'Daylen Lile' }, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 0 } },
    ],
  };

  const r1 = mergeScoringChanges(gamePk, [initialPlay], new Map(), t0, context);
  const r2 = mergeScoringChanges(gamePk, [finalPlay], r1.snapshots, t0 + 3600000, context);

  const feedSeen = new Map();
  const feedOrder = [];
  r2.added.forEach((entry) => {
    entry.matchupLabel = 'WSH @ LAD';
    const k = buildEventKey(entry.gamePk, entry.review);
    feedSeen.set(k, entry);
    feedOrder.push(k);
  });

  const scoringSnapshots = new Map([[gamePk, r2.snapshots]]);
  const log = serializeFeedLog({
    dateStr,
    now: t0 + 3600000,
    feedSeen,
    feedOrder,
    scoringSnapshots,
    scoringIrregularities: new Map(),
    scoringGraceFinals: new Map(),
    settledGames: new Set([gamePk]),
  });

  fs.writeFileSync(path.join(DATA_DIR, `feed-log-${dateStr}.json`), JSON.stringify(log, null, 2), 'utf8');
  console.log(`Seeded data/feed-log-${dateStr}.json with Lile Single -> Error change`);
}

// 5. 2026-09-23 (Today): Initialize valid feed log
{
  const dateStr = '2026-09-23';
  const log = {
    v: 1,
    date: dateStr,
    savedAt: Date.now(),
    entries: [],
    order: [],
    snapshots: {},
    irregularities: {},
    grace: {},
    settled: [],
    trimmed: { entries: 0, snapshots: 0 }
  };
  fs.writeFileSync(path.join(DATA_DIR, `feed-log-${dateStr}.json`), JSON.stringify(log, null, 2), 'utf8');
  console.log(`Initialized data/feed-log-${dateStr}.json for today`);
}

// 6. Update feed-log-index.json
const indexPath = path.join(DATA_DIR, 'feed-log-index.json');
const index = {
  '2026-08-28': Date.UTC(2026, 7, 29, 1, 30, 0),
  '2026-08-30': Date.UTC(2026, 7, 30, 21, 0, 0),
  '2026-09-02': Date.UTC(2026, 8, 3, 0, 0, 0),
  '2026-09-05': Date.UTC(2026, 8, 5, 23, 0, 0),
  '2026-09-23': Date.now(),
};
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
console.log('Updated data/feed-log-index.json');
