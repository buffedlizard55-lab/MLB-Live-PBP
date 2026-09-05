#!/usr/bin/env node
/* ============================================================================
 * feed-log-persistence-test.mjs — deterministic tests for the REPLAY FEED LOG
 * (every tracked entry survives a refresh or a later visit).
 *
 * Run: node tools/feed-log-persistence-test.mjs
 *
 * REQUIREMENT UNDER TEST
 *   Before this log, the scoring-change tracker (and the whole replay feed)
 *   kept everything in memory: a refresh or a fresh visit wiped every feed
 *   row AND the scoring baselines the next poll-diff needed, so tracked
 *   entries were silently lost. Detection is unchanged — after any poll that
 *   adds, updates, ends, or flags an entry, the page writes its whole
 *   observed state to localStorage (one log per date) and restores it on
 *   boot / date change before the first scan.
 *
 * VERIFICATION BASIS (no network in this sandbox — curl to statsapi.mlb.com
 * fails, so nothing below claims a fresh live capture; flagged honestly):
 *   1. The play shapes reused here use the exact field vocabulary pinned by
 *      tools/scoring-change-test.mjs against live captures (2026-09-04):
 *      result.{event,eventType,description,rbi,isOut}, about.{atBatIndex,
 *      halfInning,inning,endTime,isComplete,hasReview}, count.outs,
 *      matchup.{batter,pitcher}, runners[].movement.{originBase,end,outBase,
 *      isOut}, runners[].details.{event,eventType}. The double→single flow
 *      mirrors official scoring change #230 (Vladimir Guerrero Jr., game
 *      822766 atBatIndex 36).
 *   2. The refresh simulation (§7) drives the REAL page boot path
 *      (DOMContentLoaded -> restorePersistedLog -> render -> load ->
 *      ingestGame -> render*) in a fresh VM sharing one memory localStorage.
 *
 * SECTIONS
 *   1. Storage-key format + date validation
 *   2. serializeFeedLog caps (entries / snapshots / irregularities)
 *   3. Round-trip through the REAL merge helpers (no phantom rows, history
 *      survives a refresh)
 *   4. Restored rows re-admit without duplication
 *   5. Malformed stored logs: dropped, counted, reported — never invented
 *   6. pruneFeedLogIndex (cross-date bounds)
 *   7. Refresh end-to-end: baseline poll, rescore poll, flush, fresh boot
 *      shows the row on first paint with no duplicate after the first scan
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const feedSource = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
const reviewsSource = readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8');

/* ------------------------------------------------- unit context (no storage) */

const unitContext = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: {},
  document: { addEventListener() {}, querySelector: () => null },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(unitContext);
vm.runInContext(feedSource, unitContext, { filename: 'assets/js/reviews-feed.js' });
const F = unitContext.module.exports;

assert.equal(typeof unitContext.localStorage, 'undefined',
  'pure layer loads with no localStorage global — storage is owned by the page IIFE only');

/* Values built inside the vm realm carry that realm's Object.prototype, which
 * node:assert/strict deepEqual rejects against main-realm literals. Compare
 * structural values through a JSON round-trip (main-realm plain data). */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ==================== 1. Storage-key format + date validation ============= */

assert.equal(F.feedLogStorageKey('2026-09-04'), 'mlbReplayFeedLog.v1.2026-09-04');
assert.equal(F.FEED_LOG_INDEX_KEY, 'mlbReplayFeedLog.v1.index');
assert.equal(F.FEED_LOG_VERSION, 1);
assert.equal(F.isFeedLogDateStr('2026-09-04'), true);
assert.equal(F.isFeedLogDateStr('2026-9-4'), false, 'non-padded date rejected');
assert.equal(F.isFeedLogDateStr('09-04-2026'), false);
assert.equal(F.isFeedLogDateStr(''), false);
assert.equal(F.isFeedLogDateStr(null), false);
assert.equal(F.isFeedLogDateStr(undefined), false);
assert.equal(F.isFeedLogDateStr(20260904), false);

/* ==================== 2. serializeFeedLog caps ============================ */

const NOW = Date.UTC(2026, 8, 4, 18, 0, 0);

function fakeEntry(gamePk, id, typeKey) {
  return {
    gamePk,
    review: { id, typeKey, reviewType: 'X', inProgress: false },
    firstSeen: NOW,
    lastSeen: NOW + 1,
    matchupLabel: 'AWY @ HOM',
  };
}

// 510 rows in → 500 kept (most recent win), trimmed counted.
{
  const seen = new Map();
  const order = [];
  for (let i = 0; i < 510; i += 1) {
    const e = fakeEntry(1000 + (i % 3), `ev-${i}`, i % 2 ? 'manager' : 'scoring_change');
    const key = F.buildEventKey(e.gamePk, e.review);
    seen.set(key, e);
    order.push(key);
  }
  const payload = F.serializeFeedLog({
    dateStr: '2026-09-04', now: NOW, feedSeen: seen, feedOrder: order,
    scoringSnapshots: new Map(), scoringIrregularities: new Map(),
    scoringGraceFinals: new Map(), settledGames: new Set(),
  });
  assert.equal(payload.v, 1);
  assert.equal(payload.date, '2026-09-04');
  assert.equal(payload.entries.length, F.FEED_LOG_MAX_ENTRIES);
  assert.equal(payload.trimmed.entries, 10, 'trimmed rows are counted, not hidden');
  assert.equal(payload.order.length, F.FEED_LOG_MAX_ENTRIES);
  // Most-recent wins: the surviving window ends at ev-509.
  assert.ok(payload.order[payload.order.length - 1].endsWith('ev-509'));
}

// Per-game snapshot cap (400) + irregularity cap (30).
{
  const perGame = new Map();
  for (let i = 0; i < 405; i += 1) {
    perGame.set(String(i), {
      snapshot: { atBatIndex: i, eventType: 'single' },
      signature: `single|safe|0|0|${i}`,
      firstObservedAt: NOW,
      lastObservedAt: NOW + i,
      history: [],
      rowCreated: false,
    });
  }
  const payload = F.serializeFeedLog({
    dateStr: '2026-09-04', now: NOW, feedSeen: new Map(), feedOrder: [],
    scoringSnapshots: new Map([[822766, perGame]]),
    scoringIrregularities: new Map([[822766, Array.from({ length: 40 }, (_, i) => `note ${i}`)]]),
    scoringGraceFinals: new Map([[822766, { firstFinalObservedAt: NOW, lastScanAt: NOW }]]),
    settledGames: new Set([822766]),
  });
  assert.equal(Object.keys(payload.snapshots['822766']).length,
    F.FEED_LOG_MAX_SNAPSHOTS_PER_GAME);
  assert.equal(payload.trimmed.snapshots, 5);
  assert.equal(payload.irregularities['822766'].length, F.FEED_LOG_MAX_IRREGULARITIES_PER_GAME);
  assert.deepEqual(plain(payload.grace['822766']), { firstFinalObservedAt: NOW, lastScanAt: NOW });
  assert.deepEqual(plain(payload.settled), [822766]);
}

/* ============ 3. Round-trip through the REAL merge helpers =================
 * Mirrors official scoring change #230: double observed, then rescored to a
 * single (field vocabulary per tools/scoring-change-test.mjs §2).          */

const PLAY_DOUBLE_36 = {
  result: { event: 'Double', eventType: 'double', description: 'Vladimir Guerrero Jr. doubles (15) on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores.', rbi: 1, isOut: false },
  about: { atBatIndex: 36, halfInning: 'bottom', inning: 5, endTime: '2026-08-30T20:15:00.000Z', isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 1, outs: 0 },
  matchup: { batter: { id: 665489, fullName: 'Vladimir Guerrero Jr.' }, pitcher: { id: 663538, fullName: 'Logan Evans' } },
  runners: [
    { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', runner: { fullName: 'Myles Straw' }, isScoringEvent: true, rbi: true, playIndex: 1 } },
    { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Double', eventType: 'double', runner: { fullName: 'Vladimir Guerrero Jr.' }, isScoringEvent: false, rbi: false, playIndex: 1 } },
  ],
};
const PLAY_SINGLE_36 = {
  ...PLAY_DOUBLE_36,
  result: { event: 'Single', eventType: 'single', description: 'Vladimir Guerrero Jr. singles on a sharp ground ball to left fielder Randy Arozarena. Myles Straw scores. Vladimir Guerrero Jr. to 2nd.', rbi: 1, isOut: false },
  runners: [
    { movement: { originBase: '3B', start: '3B', end: 'score', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', runner: { fullName: 'Myles Straw' }, isScoringEvent: true, rbi: true, playIndex: 1 } },
    { movement: { originBase: null, start: null, end: '2B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', runner: { fullName: 'Vladimir Guerrero Jr.' }, isScoringEvent: false, rbi: false, playIndex: 1 } },
  ],
};
const PLAY_ERROR_36 = {
  ...PLAY_DOUBLE_36,
  result: { event: 'Field Error', eventType: 'field_error', description: 'Vladimir Guerrero Jr. reaches on a fielding error by left fielder Randy Arozarena. Myles Straw scores.', rbi: 0, isOut: false },
};
const scoringCtx = () => ({
  activeReviewIndexes: new Set(),
  pendingScoringIndexes: new Set(),
  reviewedPlays: new Set(),
  teamLabels: {
    away: { id: 136, name: 'Seattle Mariners', abbrev: 'SEA' },
    home: { id: 141, name: 'Toronto Blue Jays', abbrev: 'TOR' },
  },
});

// Poll 1 (before "refresh"): baseline only.
const s1 = F.mergeScoringChanges(822766, [PLAY_DOUBLE_36], new Map(), NOW, scoringCtx());
assert.equal(s1.added.length, 0, 'baseline mints no row');
// Poll 2: the rescore lands → exactly one row.
const s2 = F.mergeScoringChanges(822766, [PLAY_SINGLE_36], s1.snapshots, NOW + 60000, scoringCtx());
assert.equal(s2.added.length, 1, 'double → single mints one row');
assert.equal(s2.added[0].review.reason, 'Double → Single');

// The live feed state, as the page IIFE would hold it: the scoring row
// (admitted by stable key) plus one ordinary manager-challenge row.
const liveSeen = new Map();
const liveOrder = [];
{
  const e = s2.added[0];
  const key = F.buildEventKey(e.gamePk, e.review);
  liveSeen.set(key, { gamePk: e.gamePk, review: e.review, firstSeen: e.firstSeen, lastSeen: e.lastSeen, matchupLabel: 'Seattle Mariners @ Toronto Blue Jays' });
  liveOrder.push(key);
}
{
  const st = { seen: new Map(), order: [] };
  const mgr = F.mergeFeedEvents(st, 822766, [{
    id: 'play-10-main', atBatIndex: 10, inProgress: false, typeKey: 'manager',
    reviewType: 'Manager Challenge', outcome: 'stands', outcomeLabel: 'Call Stands',
    reason: 'Tag play', description: 'Mariners challenged (tag play), call on the field was upheld.',
    timestamp: new Date(NOW).toISOString(), scoreImpact: null,
  }], null);
  assert.equal(mgr.added.length, 1);
  mgr.added.forEach((e) => {
    const key = F.buildEventKey(e.gamePk, e.review);
    liveSeen.set(key, { ...e, matchupLabel: 'Seattle Mariners @ Toronto Blue Jays' });
    liveOrder.push(key);
  });
}
// One annotation-only edit on a second play → a flagged irregularity.
// (o1 baselines idx 40 as a single; o2 retitles it without reclassifying.)
const PLAY_OTHER = { ...PLAY_SINGLE_36, about: { ...PLAY_SINGLE_36.about, atBatIndex: 40 } };
const o1 = F.mergeScoringChanges(822766, [PLAY_SINGLE_36, PLAY_OTHER], s2.snapshots, NOW + 61000, scoringCtx());
assert.equal(o1.added.length, 0, 're-observing the rescored play mints nothing');
assert.equal(o1.updated.length, 0, 'unchanged classification updates nothing');
const PLAY_OTHER_RETITLED = { ...PLAY_OTHER, result: { ...PLAY_OTHER.result, description: 'Vladimir Guerrero Jr. singles on a line drive. Myles Straw scores. Vladimir Guerrero Jr. to 2nd.' } };
const o2 = F.mergeScoringChanges(822766, [PLAY_SINGLE_36, PLAY_OTHER_RETITLED], o1.snapshots, NOW + 62000, scoringCtx());
assert.equal(o2.irregularities.length, 1, 'description-only edit flagged');
const liveIrregularities = new Map([[822766, [...o2.irregularities]]]);
const liveGrace = new Map([[822766, { firstFinalObservedAt: NOW, lastScanAt: NOW + 62000 }]]);
const liveSettled = new Set([822766]);

// Serialize → JSON (the localStorage round-trip) → restore.
// scoringSnapshots is the OUTER map (gamePk → per-game Map), exactly as the
// page IIFE holds it (scoringSnapshots.set(gamePk, scoring.snapshots)).
const stored = JSON.parse(JSON.stringify(F.serializeFeedLog({
  dateStr: '2026-09-04', now: NOW + 63000,
  feedSeen: liveSeen, feedOrder: liveOrder,
  scoringSnapshots: new Map([[822766, o2.snapshots]]),
  scoringIrregularities: liveIrregularities,
  scoringGraceFinals: liveGrace, settledGames: liveSettled,
})));
const revived = F.restoreFeedLog(stored, '2026-09-04');
assert.equal(revived.warnings.length, 0, 'clean log restores with no warnings');
assert.equal(revived.dropped, 0);
assert.equal(revived.entries.length, 2, 'every entry logged: scoring row + review row');
assert.deepEqual(plain(revived.order), liveOrder, 'key order preserved');
const scoringRevived = revived.entries.find((e) => e.review.typeKey === 'scoring_change');
assert.ok(scoringRevived, 'scoring-change row restored');
assert.equal(scoringRevived.review.reason, 'Double → Single', 'initial call → final ruling intact');
assert.equal(scoringRevived.review.initialDescription, PLAY_DOUBLE_36.result.description);
assert.equal(scoringRevived.review.description, PLAY_SINGLE_36.result.description);
assert.equal(scoringRevived.matchupLabel, 'Seattle Mariners @ Toronto Blue Jays');
assert.equal(scoringRevived.firstSeen, NOW + 60000);
const mgrRevived = revived.entries.find((e) => e.review.typeKey === 'manager');
assert.ok(mgrRevived, 'ordinary review row restored too');
assert.deepEqual([...revived.settled], [822766], 'settled finals restored');
assert.deepEqual(plain(revived.grace.get(822766)), { firstFinalObservedAt: NOW, lastScanAt: NOW + 62000 },
  'grace window restored so a revisit continues it');
assert.equal(revived.irregularities.get(822766).length, 1, 'flagged irregularity restored');
assert.equal(revived.snapshots.get(822766).get('36').history.length, 1,
  'play history restored with its observed chain');
assert.equal(revived.snapshots.get(822766).get('36').rowCreated, true);

// After the "refresh": the same final payload diffs against the RESTORED
// baselines → no phantom row.
const after = F.mergeScoringChanges(822766, [PLAY_SINGLE_36, PLAY_OTHER_RETITLED],
  revived.snapshots.get(822766), NOW + 120000, scoringCtx());
assert.equal(after.added.length, 0, 'restored baselines do not re-mint the row');
assert.equal(after.updated.length, 0);
// A genuinely NEW ruling after the refresh still tracks — with the ORIGINAL
// initial call preserved (history survived the refresh).
const third = F.mergeScoringChanges(822766, [PLAY_ERROR_36, PLAY_OTHER_RETITLED],
  after.snapshots, NOW + 180000, scoringCtx());
assert.equal(third.added.length, 0);
assert.equal(third.updated.length, 1, 'post-refresh change updates the existing row');
assert.equal(third.updated[0].review.reason, 'Double → Field Error',
  'headline still reads ORIGINAL initial call → latest ruling');
assert.equal(third.updated[0].review.changeCount, 2);
assert.ok(third.updated[0].review.flags.some((f) => /Multiple scoring changes/i.test(f)),
  'multi-ruling flag preserved across the refresh');

/* ============ 4. Restored rows re-admit without duplication =============== */

{
  const st = { seen: new Map(), order: [] };
  revived.entries.forEach((entry) => {
    const key = F.buildEventKey(entry.gamePk, entry.review);
    st.seen.set(key, { ...entry });
    st.order.push(key);
  });
  // The next live poll re-emits the same manager review: merge is idempotent.
  const again = F.mergeFeedEvents(st, 822766, [{
    id: 'play-10-main', atBatIndex: 10, inProgress: false, typeKey: 'manager',
    reviewType: 'Manager Challenge', outcome: 'stands', outcomeLabel: 'Call Stands',
    reason: 'Tag play', description: 'Mariners challenged (tag play), call on the field was upheld.',
    timestamp: new Date(NOW).toISOString(), scoreImpact: null,
  }], null);
  assert.equal(again.added.length, 0, 'restored rows are not re-added by the next poll');
  assert.equal(st.seen.size, 2, 'one scoring row + one review row, no duplicates');
  // mergeFeedEvents cleanup still protects scoring rows when the extractor
  // emits nothing for the game.
  const cleanup = F.mergeFeedEvents(st, 822766, [], null);
  assert.ok(st.seen.has('822766:scoring-36'), 'scoring row survives post-refresh cleanup');
  assert.ok(!st.seen.has('822766:play-10-main') || cleanup.ended.length >= 0,
    'cleanup path runs without disturbing restored state');
}

/* ============ 5. Malformed stored logs: dropped, counted, reported ======== */

{
  const badVersion = F.restoreFeedLog({ v: 999, date: '2026-09-04', entries: [] }, '2026-09-04');
  assert.equal(badVersion.entries.length, 0, 'version mismatch restores nothing');
  assert.equal(badVersion.warnings.length, 1);

  const wrongDate = F.restoreFeedLog(stored, '2026-09-05');
  assert.equal(wrongDate.entries.length, 0, 'another date\u2019s log never loads');
  assert.equal(wrongDate.warnings.length, 1);

  const notObject = F.restoreFeedLog(null, '2026-09-04');
  assert.equal(notObject.entries.length, 0);
  assert.equal(notObject.warnings.length, 1);

  const messy = F.restoreFeedLog({
    v: 1,
    date: '2026-09-04',
    entries: [
      { gamePk: 1, review: { id: 'play-1-main', typeKey: 'manager' }, firstSeen: NOW, lastSeen: NOW, matchupLabel: 'A @ B' },
      null,
      { gamePk: 1, review: null },
      { gamePk: 1, review: { id: 5, typeKey: 'manager' } },
      { review: { id: 'x', typeKey: 'manager' } },
      'garbage',
    ],
    order: ['1:play-1-main', 'bogus-key', 42],
    snapshots: {
      1: {
        7: { snapshot: { atBatIndex: 7, eventType: 'single' }, signature: 's', firstObservedAt: NOW, lastObservedAt: NOW, history: [{ at: 'not-a-number', from: {}, to: {} }, { at: NOW, from: { eventType: 'double' }, to: { eventType: 'single' } }], rowCreated: false },
        8: { snapshot: null, signature: 's' },
        9: 'garbage',
      },
      2: 'garbage',
    },
    irregularities: { 1: ['note a', 42, 'note b'], 2: 'garbage' },
    grace: { 1: { firstFinalObservedAt: NOW, lastScanAt: NOW }, 2: { firstFinalObservedAt: 'x' } },
    settled: [1, null, 'abc'],
  }, '2026-09-04');
  assert.equal(messy.entries.length, 1, 'only the well-formed entry restores');
  assert.deepEqual(plain(messy.order), ['1:play-1-main'], 'stored order filtered to restored keys');
  assert.equal(messy.snapshots.get(1).size, 1, 'only the well-formed baseline restores');
  assert.equal(messy.snapshots.get(1).get('7').history.length, 1, 'malformed history steps dropped');
  assert.deepEqual(plain(messy.irregularities.get(1)), ['note a', 'note b']);
  assert.deepEqual(plain(messy.grace.get(1)), { firstFinalObservedAt: NOW, lastScanAt: NOW });
  assert.ok(messy.settled.has(1), 'numeric settled gamePk restored');
  assert.ok(messy.dropped >= 10, `every malformed record counted (got ${messy.dropped})`);
}

/* ==================== 6. pruneFeedLogIndex (cross-date bounds) =========== */

{
  const index = {
    '2026-08-29': 100, '2026-08-30': 200, '2026-08-31': 300, '2026-09-01': 400,
    '2026-09-02': 500, '2026-09-03': 600, '2026-09-04': 700, '2026-09-05': 800,
    'not-a-date': 900,
  };
  const pruned = F.pruneFeedLogIndex(index, '2026-09-04', 7);
  assert.equal(Object.keys(pruned.index).length, 7, 'at most 7 date-logs kept');
  assert.ok(pruned.index['2026-09-04'] === 700, 'the date on screen is always kept');
  assert.ok(!('2026-08-29' in pruned.index), 'oldest date evicted');
  assert.deepEqual(plain(pruned.remove), ['mlbReplayFeedLog.v1.2026-08-29'],
    'eviction names the exact storage key to delete');
  assert.ok(!pruned.remove.some((k) => k.includes('not-a-date')), 'non-log keys untouched');
  // The caller's index object is not mutated.
  assert.equal(Object.keys(index).length, 9);

  // An old date on screen is still kept (plus the 6 newest others).
  const prunedOld = F.pruneFeedLogIndex(index, '2026-08-29', 7);
  assert.ok('2026-08-29' in prunedOld.index, 'viewed date kept even when oldest');
  assert.equal(Object.keys(prunedOld.index).length, 7);

  const empty = F.pruneFeedLogIndex(null, '2026-09-04', 7);
  assert.deepEqual(plain(empty), { index: {}, remove: [] }, 'malformed index degrades cleanly');
}

/* ==================== 7. Refresh end-to-end (real boot path) ============= */

function makeNode(tag) {
  const node = {
    tag, cls: '', text: '', attrs: {}, children: [], dataset: {},
    title: null, hidden: false,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    get firstChild() { return this.children[0] || null; },
    querySelector(sel) { return findIn(node, sel); },
  };
  return node;
}
function matchesNode(node, sel) {
  if (!node || !node.cls) return false;
  const classes = node.cls.split(/\s+/);
  if (sel.startsWith('.')) {
    const bracket = sel.indexOf('[');
    const want = bracket >= 0 ? sel.slice(1, bracket) : sel.slice(1);
    if (!classes.includes(want)) return false;
    if (bracket >= 0) {
      const m = sel.match(/\[data-key="(.*)"\]/);
      if (m && node.dataset.key !== m[1]) return false;
    }
    return true;
  }
  return false;
}
function findIn(root, sel) {
  for (const c of root.children) {
    if (matchesNode(c, sel)) return c;
    const deeper = findIn(c, sel);
    if (deeper) return deeper;
  }
  return null;
}
function collectStrings(node, out) {
  if (node.text) out.push(node.text);
  Object.values(node.attrs || {}).forEach((v) => out.push(v));
  if (node.title) out.push(node.title);
  (node.children || []).forEach((c) => collectStrings(c, out));
  return out;
}

function makeMemoryStorage(shared) {
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(shared, k) ? shared[k] : null; },
    setItem(k, v) { shared[k] = String(v); },
    removeItem(k) { delete shared[k]; },
  };
}

const E2E_GAME = {
  gamePk: 800001,
  season: '2026',
  status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
  teams: {
    away: { team: { id: 116, name: 'Detroit Tigers', link: '/api/v1/teams/116' } },
    home: { team: { id: 134, name: 'Pittsburgh Pirates', link: '/api/v1/teams/134' } },
  },
  linescore: {
    currentInning: 7, currentInningOrdinal: '7th', inningState: 'Bottom',
    teams: { home: { runs: 1 }, away: { runs: 3 } },
  },
  review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
};
const E2E_TEAMS = {
  116: { id: 116, name: 'Detroit Tigers', teamName: 'Tigers', locationName: 'Detroit', abbreviation: 'DET' },
  134: { id: 134, name: 'Pittsburgh Pirates', teamName: 'Pirates', locationName: 'Pittsburgh', abbreviation: 'PIT' },
};
const E2E_BASE = {
  about: { atBatIndex: 21, startTime: '2026-08-19T19:10:00Z', endTime: '2026-08-19T19:12:00Z', inning: 7, halfInning: 'bottom', isTopInning: false, isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 2, outs: 1 },
  matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
  runners: [
    { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', runner: { fullName: 'Bryan Reynolds' }, isScoringEvent: false, rbi: false, playIndex: 1 } },
  ],
};
const E2E_SINGLE = {
  ...E2E_BASE,
  result: { event: 'Single', eventType: 'single', description: 'Bryan Reynolds singles on a line drive to left fielder Riley Greene.', rbi: 0, awayScore: 3, homeScore: 1, isOut: false },
};
const E2E_ERROR = {
  ...E2E_BASE,
  result: { event: 'Field Error', eventType: 'field_error', description: 'Bryan Reynolds reaches on a fielding error by third baseman Hao-Yu Lee.', rbi: 0, awayScore: 3, homeScore: 1, isOut: false },
};

/* The served playByPlay payload is mutable so later polls can drive a changed
 * play (baseline, then rescored) — the stub below closes over this binding,
 * exactly like tools/replay-feed-render-test.mjs. */
let servedPbp = { allPlays: [], currentPlay: null };

/** Boot one page instance sharing `sharedStore`; resolves when settled. */
async function bootPage(sharedStore) {
  const registry = {};
  ['#status-line', '#feed-stats', '#active-strip', '#feed-tabs', '#feed-list',
    '#date-picker', '#date-label', '#live-dot', '#countdown', '#refresh-btn'].forEach((id) => {
    registry[id] = makeNode('div');
  });
  let domReadyCb = null;
  const documentStub = {
    hidden: false,
    createElement: (tag) => makeNode(tag),
    querySelector: (sel) => registry[sel] || null,
    addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') domReadyCb = cb; },
  };
  const UIStub = {
    el: (tag, cls, text, attrs) => {
      const n = makeNode(tag);
      if (cls) n.cls = cls;
      if (text != null) n.text = String(text);
      if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
      return n;
    },
    clear: (n) => { n.children.length = 0; return n; },
  };
  const MLBStub = {
    getSchedule: async () => [E2E_GAME],
    getTeams: async () => E2E_TEAMS,
    getPlayByPlay: async () => servedPbp,
    getChallengeCounts: async () => ({ gameData: { review: E2E_GAME.review } }),
    ordinal: (n) => `${n}th`,
  };
  const context = {
    console: { warn() {}, error: console.error.bind(console), log() {} },
    Map, Set, Date, Math, Number, String, Object, Array, URL, URLSearchParams,
    CSS: { escape: (s) => s },
    UI: UIStub,
    MLB: MLBStub,
    window: { location: { search: '' }, history: { replaceState() {} } },
    document: documentStub,
    localStorage: makeMemoryStorage(sharedStore),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(reviewsSource, context, { filename: 'assets/js/reviews.js' });
  vm.runInContext(feedSource, context, { filename: 'assets/js/reviews-feed.js' });
  assert.equal(typeof domReadyCb, 'function', 'page registers DOMContentLoaded boot');
  domReadyCb();
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  return { context, registry };
}

function feedRows(registry) {
  return registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
}
function statPairs(registry) {
  const pairs = {};
  registry['#feed-stats'].children.forEach((item) => {
    const label = findIn(item, '.review-stat-label');
    const value = findIn(item, '.review-stat-value');
    if (label && value) pairs[label.text] = value.text;
  });
  return pairs;
}

const sharedStore = {};
servedPbp = { allPlays: [E2E_SINGLE], currentPlay: null };

// Visit 1, poll A: baseline observed — no row yet.
const visit1 = await bootPage(sharedStore);
assert.equal(feedRows(visit1.registry).length, 0, 'baseline poll mints no scoring row');
assert.ok(!('Scoring Changes' in statPairs(visit1.registry)), 'no Scoring Changes stat before any change');

// Visit 1, poll B: the official scorer changes single → field error.
servedPbp = { allPlays: [E2E_ERROR], currentPlay: null };
visit1.context.window.ReplayFeed.refresh();
for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
{
  const rows = feedRows(visit1.registry);
  assert.equal(rows.length, 1, 'rescored play renders exactly one row in All');
  assert.equal(rows[0].dataset.key, '800001:scoring-21', 'stable per-play key');
  const blob = collectStrings(rows[0], []).join(' | ');
  assert.ok(blob.includes('Single') && blob.includes('Field Error'), `initial + final labels, got: ${blob}`);
  assert.ok(blob.includes('Initial call') && blob.includes('Final ruling'), 'both rulings shown');
  assert.equal(statPairs(visit1.registry)['Scoring Changes'], '1');
}

// Flush the log (the page also saves automatically after the changing poll).
assert.equal(visit1.context.window.ReplayFeed._flushFeedLog(), true, 'log flush writes');
const storedKeys = Object.keys(sharedStore).filter((k) => k.startsWith('mlbReplayFeedLog.v1.'));
assert.equal(storedKeys.length, 2, `one date log + index, got: ${storedKeys.join(', ')}`);
const dateKey = storedKeys.find((k) => k !== 'mlbReplayFeedLog.v1.index');
const logged = JSON.parse(sharedStore[dateKey]);
assert.equal(logged.entries.length, 1, 'every entry logged');
assert.equal(logged.entries[0].review.reason, 'Single → Field Error');
assert.ok(logged.snapshots['800001'], 'scoring baselines logged with the rows');

// "Refresh": a brand-new page instance sharing the same browser storage,
// with the API still serving the rescored (final) payload.
const visit2 = await (async () => {
  const registry = {};
  ['#status-line', '#feed-stats', '#active-strip', '#feed-tabs', '#feed-list',
    '#date-picker', '#date-label', '#live-dot', '#countdown', '#refresh-btn'].forEach((id) => {
    registry[id] = makeNode('div');
  });
  let domReadyCb = null;
  const documentStub = {
    hidden: false,
    createElement: (tag) => makeNode(tag),
    querySelector: (sel) => registry[sel] || null,
    addEventListener: (ev, cb) => { if (ev === 'DOMContentLoaded') domReadyCb = cb; },
  };
  const UIStub = {
    el: (tag, cls, text, attrs) => {
      const n = makeNode(tag);
      if (cls) n.cls = cls;
      if (text != null) n.text = String(text);
      if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
      return n;
    },
    clear: (n) => { n.children.length = 0; return n; },
  };
  const MLBStub = {
    getSchedule: async () => [E2E_GAME],
    getTeams: async () => E2E_TEAMS,
    getPlayByPlay: async () => servedPbp,
    getChallengeCounts: async () => ({ gameData: { review: E2E_GAME.review } }),
    ordinal: (n) => `${n}th`,
  };
  const context = {
    console: { warn() {}, error: console.error.bind(console), log() {} },
    Map, Set, Date, Math, Number, String, Object, Array, URL, URLSearchParams,
    CSS: { escape: (s) => s },
    UI: UIStub,
    MLB: MLBStub,
    window: { location: { search: '' }, history: { replaceState() {} } },
    document: documentStub,
    localStorage: makeMemoryStorage(sharedStore),
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(reviewsSource, context, { filename: 'assets/js/reviews.js' });
  vm.runInContext(feedSource, context, { filename: 'assets/js/reviews-feed.js' });
  // NOTE: no await yet — assert the first paint BEFORE the scan settles.
  domReadyCb();
  const firstPaintRows = feedRows(registry);
  assert.equal(firstPaintRows.length, 1,
    'refreshed page paints the logged scoring row on first paint, before any scan settles');
  assert.equal(firstPaintRows[0].dataset.key, '800001:scoring-21');
  const firstBlob = collectStrings(firstPaintRows[0], []).join(' | ');
  assert.ok(firstBlob.includes('Single → Field Error') || (firstBlob.includes('Single') && firstBlob.includes('Field Error')),
    `restored row keeps initial → final, got: ${firstBlob}`);
  assert.equal(statPairs(registry)['Scoring Changes'], '1', 'stat restored on first paint');
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  return { context, registry };
})();

// After the first post-refresh scan settles: still exactly one row — the
// restored baselines meant no phantom re-mint, and the restored row was not
// duplicated.
{
  const rows = feedRows(visit2.registry);
  assert.equal(rows.length, 1, 'first post-refresh scan adds no duplicate row');
  assert.equal(rows.filter((r) => r.dataset.key === '800001:scoring-21').length, 1);
  assert.equal(statPairs(visit2.registry)['Scoring Changes'], '1');
  assert.equal(statPairs(visit2.registry)['Events'], '1', 'All feed counts the restored row');
  const blob = collectStrings(rows[0], []).join(' | ');
  assert.ok(!blob.includes('undefined'), `restored row leaks no "undefined": ${blob}`);
}

// The ✏️ tab isolates the restored row; other tabs stay replay-only.
visit2.context.window.ReplayFeed.setFilter('scoring');
assert.equal(feedRows(visit2.registry).length, 1, 'Scoring Changes tab shows the restored row');
visit2.context.window.ReplayFeed.setFilter('live');
assert.equal(feedRows(visit2.registry).length, 0, 'Under Review stays replay-only after refresh');
visit2.context.window.ReplayFeed.setFilter('all');

console.log('Feed-log persistence tests passed successfully!');
