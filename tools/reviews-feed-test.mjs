#!/usr/bin/env node
/* ============================================================================
 * reviews-feed-test.mjs — deterministic tests for the all-games replay feed
 * diff helpers (buildEventKey / mergeFeedEvents / sortFeedEntries) in
 * assets/js/reviews-feed.js.
 *
 * Run: node tools/reviews-feed-test.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: {},
  document: { addEventListener() {} },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'assets/js/reviews-feed.js' });

const {
  buildEventKey, mergeFeedEvents, sortFeedEntries, gameTeamsLabel,
  isUsableName, officialTeamName, gameSideTeam,
  pollIntervalMs, waitAfterScan, reviewFetchPriority, mapPool,
} = context.module.exports;

/* ------------------------------------------------------- 1. Stable keys */

assert.equal(buildEventKey(823341, { id: 'play-34-main' }), '823341:play-34-main');
assert.equal(buildEventKey(823342, { id: 'play-15-ev-0' }), '823342:play-15-ev-0');
assert.equal(buildEventKey(823342, { id: 'live-active-review' }), '823342:live-active-review');
// Same at-bat id in different games must not collide.
assert.notEqual(buildEventKey(1, { id: 'play-1-main' }), buildEventKey(2, { id: 'play-1-main' }));

/* --------------------------------------------------- 2. First merge = add */

const state = { seen: new Map(), order: [] };
const mk = (id, typeKey, outcome, inProgress = false) => ({
  id, typeKey, reviewType: typeKey === 'abs' ? 'ABS Challenge' : 'Manager Challenge',
  outcome, outcomeLabel: outcome === 'overturned' ? 'Call Overturned' : 'Call Stands',
  inProgress, description: 'desc ' + id, timestamp: '2026-08-19T01:00:00Z',
});
const gamePk = 823341;

const first = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(first.added.length, 1);
assert.equal(first.updated.length, 0);
assert.equal(first.ended.length, 0);
assert.equal(state.order.length, 1);

/* ------------------------------------------- 3. Same poll again = no-op */

const second = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(second.added.length, 0);
assert.equal(second.updated.length, 0);
assert.equal(second.ended.length, 0);
assert.equal(state.order.length, 1, 'no duplicate keys');

/* ------------------------------------------- 4. Outcome change = update */

const third = mergeFeedEvents(state, gamePk, [
  mk('play-34-main', 'manager', 'overturned'),
  mk('play-40-ev-0', 'abs', 'stands', true), // was in progress
]);
assert.equal(third.added.length, 1);
assert.equal(third.updated.length, 0);
const fourth = mergeFeedEvents(state, gamePk, [
  mk('play-34-main', 'manager', 'overturned'),
  mk('play-40-ev-0', 'abs', 'stands', false), // now resolved
]);
assert.equal(fourth.added.length, 0);
assert.equal(fourth.updated.length, 1, 'in-progress -> resolved should mark updated');
assert.equal(fourth.updated[0].review.inProgress, false);

/* ------------------------------------------- 5. Gone key = ended (synthetic) */

const fifth = mergeFeedEvents(state, gamePk, [mk('play-34-main', 'manager', 'overturned')]);
assert.equal(fifth.ended.length, 1, 'synthesized live-active-review entry should end when gone');
assert.equal(state.order.length, 1);

/* ------------------------------------------- 6. Multi-game isolation */

const state2 = { seen: new Map(), order: [] };
mergeFeedEvents(state2, 823341, [mk('play-34-main', 'manager', 'overturned')]);
const other = mergeFeedEvents(state2, 823342, [mk('play-15-ev-0', 'abs', 'stands')]);
assert.equal(other.added.length, 1);
assert.equal(other.ended.length, 0, 'clearing one game must not touch another game');

/* ------------------------------------------- 7. Sort newest-first */

const entries = [
  { gamePk: 1, review: { timestamp: '2026-08-19T03:00:00Z' }, firstSeen: 1 },
  { gamePk: 2, review: { timestamp: null }, firstSeen: 5 },
  { gamePk: 3, review: { timestamp: '2026-08-19T02:00:00Z' }, firstSeen: 3 },
];
const sorted = sortFeedEntries(entries);
assert.equal(sorted[0].gamePk, 1, 'real timestamp wins');
assert.equal(sorted[1].gamePk, 3, 'second by timestamp');
assert.equal(sorted[2].gamePk, 2, 'no timestamp falls back to firstSeen');

/* --------------------------- 8. Official team names, never "undefined" */

// REAL schedule shape (verified live on statsapi.mlb.com, 2026-08-19):
// teams.*.team carries ONLY { id, name, link } — there is no `abbreviation`.
// The old renderer interpolated `${team.abbreviation}` here and printed
// "undefined @ undefined" on every feed row and active-strip item.
const schedGame = {
  gamePk: 823342,
  season: '2026',
  teams: {
    away: { team: { id: 116, name: 'Detroit Tigers', link: '/api/v1/teams/116' } },
    home: { team: { id: 134, name: 'Pittsburgh Pirates', link: '/api/v1/teams/134' } },
  },
};
// Official directory as returned by MLB.getTeams() (GET /api/v1/teams).
const directory = {
  116: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET', teamName: 'Tigers' },
  134: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT', teamName: 'Pirates' },
};

const label = gameTeamsLabel(schedGame, directory);
assert.equal(label, 'Detroit Tigers @ Pittsburgh Pirates');
assert.ok(!label.includes('undefined'), 'row headline must never contain "undefined"');

// Directory empty (its request failed): official full names still come from
// the schedule itself — the label must be identical, not degraded.
assert.equal(gameTeamsLabel(schedGame, {}), 'Detroit Tigers @ Pittsburgh Pirates');

// Missing team objects entirely -> explicit placeholders, never "undefined".
assert.equal(gameTeamsLabel({}, directory), 'AWY @ HOM');
assert.equal(gameTeamsLabel({ teams: {} }, directory), 'AWY @ HOM');

// Degenerate schedule entry with no name: fall back to the official
// directory name, then its abbreviation, then the placeholder — in order.
const noNames = { teams: { away: { team: { id: 116 } }, home: { team: { id: 134 } } } };
assert.equal(gameTeamsLabel(noNames, directory), 'Detroit Tigers @ Pittsburgh Pirates');
const abbrevOnly = { 116: { id: 116, name: null, abbreviation: 'DET' } };
assert.equal(gameTeamsLabel(noNames, abbrevOnly), 'DET @ HOM');
assert.equal(gameTeamsLabel(noNames, {}), 'AWY @ HOM');

// Literal "undefined" / "null" strings must never print.
assert.equal(isUsableName('undefined'), false);
assert.equal(isUsableName('null'), false);
assert.equal(isUsableName(''), false);
assert.equal(isUsableName(undefined), false);
assert.equal(isUsableName('Detroit Tigers'), true);
const poisoned = {
  teams: {
    away: { team: { id: 116, name: 'undefined' } },
    home: { team: { id: 134, name: 'null' } },
  },
};
assert.equal(gameTeamsLabel(poisoned, directory), 'Detroit Tigers @ Pittsburgh Pirates');
assert.ok(!gameTeamsLabel(poisoned, directory).includes('undefined'));
assert.ok(!gameTeamsLabel(poisoned, {}).includes('undefined'));
assert.equal(gameTeamsLabel(poisoned, {}), 'AWY @ HOM');

// Flattened side object (no nested .team) still resolves a name.
const flat = {
  teams: {
    away: { id: 116, name: 'Detroit Tigers' },
    home: { id: 134, locationName: 'Pittsburgh', teamName: 'Pirates' },
  },
};
assert.equal(gameSideTeam(flat, 'away').name, 'Detroit Tigers');
assert.equal(gameTeamsLabel(flat, {}), 'Detroit Tigers @ Pittsburgh Pirates');
assert.equal(officialTeamName({ id: 116 }, directory, 'AWY'), 'Detroit Tigers');

/* --------------------------- 9. Poll cadence helpers (no invented delays) */

assert.equal(pollIntervalMs({ hasLive: false, hasActiveReview: false, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 15000);
assert.equal(pollIntervalMs({ hasLive: true, hasActiveReview: false, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 2000);
assert.equal(pollIntervalMs({ hasLive: true, hasActiveReview: true, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 1000);
assert.equal(pollIntervalMs({ hasLive: false, hasActiveReview: true, liveMs: 2000, reviewMs: 1000, idleMs: 15000 }), 1000,
  'an in-progress review still uses the review cadence even if the slate is no longer Live');

assert.equal(waitAfterScan(2000, 0), 2000);
assert.equal(waitAfterScan(2000, 800), 1200, 'scan time is subtracted from the cycle');
assert.equal(waitAfterScan(2000, 2500), 0, 'over-budget scan waits 0, never negative');
assert.equal(waitAfterScan(2000, -5), 2000, 'negative elapsed is ignored, not invented');
assert.equal(waitAfterScan(NaN, 100), 0);
assert.equal(waitAfterScan(-10, 0), 0);

assert.equal(reviewFetchPriority({ status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' } }, false), 0);
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, true), 0);
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, false), 1);
assert.equal(reviewFetchPriority({ status: { detailedState: 'Final', abstractGameState: 'Final' } }, false), 2);
// "In Progress" must NOT match /review/ — that would falsely prioritize every live game.
assert.equal(reviewFetchPriority({ status: { detailedState: 'In Progress', abstractGameState: 'Live' } }, false), 1);

const seen = [];
await mapPool(['a', 'b', 'c', 'd'], 2, async (item) => { seen.push(item); });
assert.deepEqual(seen.slice().sort(), ['a', 'b', 'c', 'd'], 'mapPool visits every item');
await mapPool([], 4, async () => { throw new Error('must not run on empty'); });

console.log('Replay feed tests passed successfully!');
