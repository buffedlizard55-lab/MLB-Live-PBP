#!/usr/bin/env node
/* ============================================================================
 * official-scoring-test.mjs — deterministic tests for the OFFICIAL SCORER
 * PENDING RULING tracker (hit vs. error vs. fielder's choice undecided).
 *
 * Run: node tools/official-scoring-test.mjs
 *
 * VERIFICATION BASIS (what this file checks against):
 *   - The ONLY accepted signal is the official MLB StatsAPI event-type
 *     registry, GET /api/v1/eventTypes (statsapi.mlb.com, fetched live
 *     2026-08-30):
 *        {"plateAppearance":true,  "code":"os_ruling_pending_primary",
 *         "description":"Official Scorer Ruling Pending", ...}
 *        {"plateAppearance":false, "code":"os_ruling_pending_prior",
 *         "baseRunningEvent":true,
 *         "description":"Official Scorer Ruling Pending", ...}
 *     No other code has that description.
 *   - The surrounding play shape (playEvents / details / about / result /
 *     matchup) mirrors LIVE game 822688 (MIA @ WSH, 2026-08-30) captured via
 *     GET /api/v1/game/822688/playByPlay — the field paths on which
 *     action event-type codes are observed (e.g. details.eventType ===
 *     "game_advisory" / "batter_timeout" / "passed_ball").
 *   - The pending marker itself is applied to the same field path. It is a
 *     test fixture: no REAL pending ruling had occurred in game 822688 by the
 *     time these tests were written (verified by polling allPlays/currentPlay:
 *     no os_ruling_pending_* value present).
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const reviewsSource = readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8');
const feedSource = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');

/* ------------------------------------------------------- load reviews.js */

const reviewsContext = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Math, Number, String, Object, Array,
  MLB: {
    ordinal: (n) => `${n}${['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10] || 'th'}`,
  },
  UI: {
    el: (tag, cls, text) => ({ tag, cls, text, children: [], appendChild(c) { this.children.push(c); return c; } }),
    clear: (node) => { if (node) node.children = []; return node; },
  },
  window: {},
};
vm.createContext(reviewsContext);
vm.runInContext(reviewsSource, reviewsContext, { filename: 'assets/js/reviews.js' });
const MLBReviews = reviewsContext.MLBReviews || reviewsContext.window.MLBReviews;

/* ---------------------------------------------------- load reviews-feed.js */

const feedContext = {
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
vm.createContext(feedContext);
vm.runInContext(feedSource, feedContext, { filename: 'assets/js/reviews-feed.js' });
const {
  mergeFeedEvents, completePendingScoringReview,
  shouldAlertForReview, visibleInAllFeed,
  runsRemovableFromReview,
} = feedContext.module.exports;

assert.ok(MLBReviews, 'MLBReviews module should load');

/* -------------------------------------------- 1. Registry constants (exact) */

assert.deepEqual([...MLBReviews.OFFICIAL_SCORER_PENDING_TYPES].sort(), [
  'os_ruling_pending_primary',
  'os_ruling_pending_prior',
], 'only the two registered os_ruling_pending_* codes are accepted');
assert.equal(MLBReviews.OFFICIAL_SCORER_PENDING_TEXT,
  'Official Scorer Ruling Pending', 'exact registry description');

/* ------------------------------------------- 2. Marker detection (exact) */

// Accepted: exact code at details.eventType (the verified action-event field).
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { eventType: 'os_ruling_pending_primary', event: 'Official Scorer Ruling Pending' },
  index: 4, isPitch: false, type: 'action',
}), true, 'primary code on details.eventType');

assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { eventType: 'os_ruling_pending_prior', description: 'Official Scorer Ruling Pending' },
  index: 5, isPitch: false, type: 'action',
}), true, 'prior code on details.eventType');

// Accepted: exact code at play.result (defensive variant).
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  result: { eventType: 'os_ruling_pending_primary', event: 'Official Scorer Ruling Pending' },
}), true, 'result-level marker');

// Accepted: exact registry description at details.description.
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { description: 'Official Scorer Ruling Pending' },
}), true, 'exact description text');

// Rejected: normal event codes / partial or paraphrased text — NEVER match.
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { eventType: 'field_error', event: 'Field Error', description: 'Amed Rosario reaches on a throwing error.' },
}), false, 'field_error is not a pending ruling');
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { eventType: 'single', event: 'Single', description: 'singles on a line drive' },
}), false, 'single is not a pending ruling');
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { description: 'Scoring pending' } }), false, 'paraphrase is rejected');
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { description: 'Official scoring pending' } }), false, 'case/paraphrase variant rejected');
assert.equal(MLBReviews.isOfficialScoringPendingEvent({
  details: { eventType: 'os_ruling_pending' } }), false, 'partial code rejected');
assert.equal(MLBReviews.isOfficialScoringPendingEvent(null), false);
assert.equal(MLBReviews.isOfficialScoringPendingEvent(undefined), false);

/* ------------------------------------ 3. findOfficialScoringPendingPlay */

// Negative control: a REAL completed play from live game 822688 (2026-08-30),
// field_out groundout — no pending marker, must return null.
const realGroundoutPlay = {
  result: {
    type: 'atBat', event: 'Groundout', eventType: 'field_out',
    description: 'Andrés Chaparro grounds out, third baseman Javier Sanoja to first baseman Leo Jiménez.',
    rbi: 0, awayScore: 0, homeScore: 0, isOut: true,
  },
  about: {
    atBatIndex: 6, halfInning: 'bottom', isTopInning: false, inning: 1,
    startTime: '2026-08-30T16:29:27.548Z', endTime: '2026-08-30T16:30:22.211Z',
    isComplete: true, hasOut: true,
  },
  count: { balls: 0, strikes: 1, outs: 3 },
  playEvents: [
    { details: { description: 'Swinging Strike', type: { description: 'Curveball' } }, index: 0, isPitch: true, type: 'pitch' },
    { details: { description: 'In play, out(s)', type: { description: 'Sweeper' } }, index: 1, isPitch: true, type: 'pitch' },
  ],
};
assert.equal(MLBReviews.findOfficialScoringPendingPlay(realGroundoutPlay), null,
  'a real non-pending play yields no pending ruling');

// Positive: same live-shape play, marker action appended (fixture — marker
// fields are the registry values; shape is the live playByPlay shape).
const pendingPrimaryPlay = {
  result: { type: 'atBat', rbi: 0, awayScore: 0, homeScore: 0, isOut: false },
  about: {
    atBatIndex: 10, halfInning: 'top', isTopInning: true, inning: 3,
    startTime: '2026-08-30T16:40:12.000Z', endTime: null, isComplete: false,
  },
  matchup: {
    batter: { id: 678011, fullName: 'Anthony Seigler', link: '/api/v1/people/678011' },
    pitcher: { id: 674841, fullName: 'Andrew Alvarez', link: '/api/v1/people/674841' },
    batSide: { code: 'R', description: 'Right' },
    pitchHand: { code: 'L', description: 'Left' },
  },
  playEvents: [
    { details: { description: 'In play, no out', type: { description: 'Sinker' } }, index: 0, isPitch: true, type: 'pitch' },
    // The official-scorer pending marker (registry values):
    {
      details: {
        description: 'Official Scorer Ruling Pending',
        event: 'Official Scorer Ruling Pending',
        eventType: 'os_ruling_pending_primary',
      },
      index: 1, isPitch: false, type: 'action',
    },
  ],
};

// The same play after the marker clears, with the resolved result.
// This simulates what the API returns once the scorer has ruled.
const resolvedPrimaryPlay = {
  result: {
    type: 'atBat',
    event: 'Field Error',
    eventType: 'field_error',
    description: 'Anthony Seigler reaches on a fielding error by third baseman.',
    rbi: 0, awayScore: 0, homeScore: 0, isOut: false,
  },
  about: {
    atBatIndex: 10, halfInning: 'top', isTopInning: true, inning: 3,
    startTime: '2026-08-30T16:40:12.000Z', endTime: '2026-08-30T16:42:00.000Z', isComplete: true,
  },
  matchup: {
    batter: { id: 678011, fullName: 'Anthony Seigler', link: '/api/v1/people/678011' },
    pitcher: { id: 674841, fullName: 'Andrew Alvarez', link: '/api/v1/people/674841' },
    batSide: { code: 'R', description: 'Right' },
    pitchHand: { code: 'L', description: 'Left' },
  },
  playEvents: [
    { details: { description: 'In play, no out', type: { description: 'Sinker' } }, index: 0, isPitch: true, type: 'pitch' },
    { details: { description: 'Fielding error by third baseman', type: { description: 'Field Error' } }, index: 1, isPitch: false, type: 'action' },
  ],
};
const foundPrimary = MLBReviews.findOfficialScoringPendingPlay(pendingPrimaryPlay);
assert.ok(foundPrimary, 'pending marker is detected');
assert.equal(foundPrimary.primary, true);
assert.equal(foundPrimary.prior, false);
assert.equal(foundPrimary.pendingEvents.length, 1);
assert.equal(foundPrimary.atResult, false);
assert.equal(foundPrimary.pendingEvents[0].details.eventType, 'os_ruling_pending_primary');

// Prior variant: base-running marker ONLY (plateAppearance false), same live
// play shape.
const pendingPriorPlay = {
  ...pendingPrimaryPlay,
  result: { type: 'atBat', rbi: 0, awayScore: 0, homeScore: 0, isOut: false },
  about: { ...pendingPrimaryPlay.about, atBatIndex: 11, halfInning: 'bottom', isTopInning: false },
  playEvents: [
    { details: { description: 'In play, no out', type: { description: 'Sinker' } }, index: 0, isPitch: true, type: 'pitch' },
    {
      details: {
        description: 'Official Scorer Ruling Pending',
        event: 'Official Scorer Ruling Pending',
        eventType: 'os_ruling_pending_prior',
      },
      index: 1, isPitch: false, type: 'action',
    },
  ],
};
const foundPrior = MLBReviews.findOfficialScoringPendingPlay(pendingPriorPlay);
assert.ok(foundPrior, 'prior marker is detected');
assert.equal(foundPrior.prior, true);
assert.equal(foundPrior.primary, false);
assert.equal(foundPrior.pendingCodes.length, 1);

// Result-level variant.
const foundResult = MLBReviews.findOfficialScoringPendingPlay({
  ...pendingPrimaryPlay,
  result: { ...pendingPrimaryPlay.result, event: 'Official Scorer Ruling Pending', eventType: 'os_ruling_pending_primary' },
});
assert.ok(foundResult && foundResult.atResult === true, 'result-level marker is detected');

/* ----------------------------- 4. extractReviews produces one feed entry */

const pseudoFeed = {
  gameData: {
    status: { detailedState: 'In Progress', abstractGameState: 'Live' },
    teams: {
      away: { id: 146, name: 'Miami Marlins', abbreviation: 'MIA' },
      home: { id: 120, name: 'Washington Nationals', abbreviation: 'WSH' },
    },
  },
  liveData: {
    plays: { allPlays: [realGroundoutPlay], currentPlay: pendingPrimaryPlay },
    linescore: null,
  },
};
const extracted = MLBReviews.extractReviews(pseudoFeed);
const pendingEntries = (extracted.reviews || []).filter((r) => r.typeKey === 'pending_scoring');
assert.equal(pendingEntries.length, 1, 'exactly one pending entry per pending play');
const pend = pendingEntries[0];
assert.equal(pend.id, 'osp-10');
assert.equal(pend.reviewType, 'Official Scoring Pending');
assert.equal(pend.typeKey, 'pending_scoring');
assert.equal(pend.inProgress, true);
assert.equal(pend.outcome, 'in_progress');
assert.equal(pend.outcomeLabel, 'Ruling Pending');
assert.equal(pend.officialScoringPending, true);
assert.equal(pend.atBatIndex, 10);
assert.equal(pend.halfInning, 'top');
assert.equal(pend.battingSide, 'away');
assert.equal(pend.battingTeamId, 146);
assert.equal(pend.battingTeamAbbrev, 'MIA');
assert.equal(pend.battingTeamName, 'Miami Marlins');
assert.equal(pend.description, 'Official Scorer Ruling Pending');
assert.equal(pend.batter && pend.batter.fullName, 'Anthony Seigler');
assert.equal(pend.pitcher && pend.pitcher.fullName, 'Andrew Alvarez');
assert.equal(pend.teamId, null, 'no challenging team — a ruling is not a challenge');
assert.equal(pend.scoreImpact, null, 'no score-impact / run-risk model for a scorer ruling');
assert.equal(pend.pendingCodes.length, 1);
assert.equal(extracted.activeReview.inProgress, true, 'active ruling counts as in-progress for the game view');
// Game-page summary: a pending ruling is tracked separately from replay
// outcome stats — it must never inflate "Stands / Upheld" or the overturn
// rate (a scoring ruling is not a replay call outcome).
assert.equal(extracted.summary.pendingScoring, 1, 'summary tracks the pending ruling separately');
assert.equal(extracted.summary.pendingScoringActive, 1, 'summary reports the active count for the stat value');
assert.equal(extracted.summary.stands, 0, 'a pending ruling is never counted as Stands/Upheld');
assert.equal(extracted.summary.overturned, 0, 'a pending ruling is never counted as Overturned');
assert.equal(extracted.summary.inProgress, 0, '"Under Review" is a replay-review counter — the pending ruling is not mixed in');
assert.equal(extracted.summary.overturnRate, '\u2014', 'overturn rate stays empty with no replay outcomes');

// Dedupe: same at-bat in allPlays AND currentPlay → still one entry.
const duplicated = MLBReviews.extractReviews({
  ...pseudoFeed,
  liveData: { plays: { allPlays: [pendingPrimaryPlay], currentPlay: pendingPrimaryPlay }, linescore: null },
});
assert.equal((duplicated.reviews || []).filter((r) => r.typeKey === 'pending_scoring').length, 1,
  'a play in both allPlays/currentPlay is deduped by atBatIndex');

// No marker anywhere → no pending entries.
const none = MLBReviews.extractReviews({
  ...pseudoFeed,
  liveData: { plays: { allPlays: [realGroundoutPlay], currentPlay: null }, linescore: null },
});
assert.equal((none.reviews || []).filter((r) => r.typeKey === 'pending_scoring').length, 0);

// Extract with resolved play (no pending marker) → playsByAtBatIndex should
// contain the play keyed by atBatIndex 10.
const resolvedFeed = MLBReviews.extractReviews({
  ...pseudoFeed,
  liveData: { plays: { allPlays: [resolvedPrimaryPlay], currentPlay: null }, linescore: null },
});
assert.ok(resolvedFeed.playsByAtBatIndex, 'playsByAtBatIndex is returned');
assert.ok(resolvedFeed.playsByAtBatIndex instanceof Map, 'playsByAtBatIndex is a Map');
assert.equal(resolvedFeed.playsByAtBatIndex.get('10'), resolvedPrimaryPlay,
  'resolved play is indexed by atBatIndex');

/* -------------------- 5. Feed semantics: alert, visibility, no run risk */

assert.equal(shouldAlertForReview(pend), true,
  'an official-scorer pending ruling triggers the raindrop chime');
assert.equal(visibleInAllFeed(pend), true,
  'pending rulings appear in the All section of the Replay Feed');
assert.equal(runsRemovableFromReview(pend), 0,
  'a scoring ruling can never put a run at risk (it charges the play, not the score)');
assert.equal(MLBReviews.runsRemovableByReview(pend), 0,
  'reviews.js mirror also excludes pending rulings from run risk');

/* --------------------- 6. mergeFeedEvents: pending → observed resolution */

// Poll 1: pending marker observed on currentPlay.
const state = { seen: new Map(), order: [] };
const poll1 = mergeFeedEvents(state, 822688, [pend]);
assert.equal(poll1.added.length, 1, 'pending ruling is added on first observation');
assert.equal(poll1.ended.length, 0);
assert.equal(state.seen.get('822688:osp-10').review.inProgress, true);

// Poll 2: the marker cleared (scorer ruled) — the play no longer carries it.
// The extraction yields no pending entry for the game.
const poll2 = mergeFeedEvents(state, 822688, []);
assert.equal(poll2.added.length, 0);
assert.equal(poll2.ended.length, 0, 'a pending ruling is NEVER deleted from the feed');
assert.equal(poll2.updated.length, 1, 'the disappearance is observed as a resolution update');
const resolved = state.seen.get('822688:osp-10').review;
assert.equal(resolved.inProgress, false);
assert.equal(resolved.outcome, 'resolved');
assert.equal(resolved.outcomeLabel, 'Ruling Complete');
assert.equal(resolved.resolvedWhenMarkerCleared, true);
assert.equal(state.order.length, 1, 'the row stays in the feed order');

// A second poll with no change must not re-alert/update.
const poll3 = mergeFeedEvents(state, 822688, []);
assert.equal(poll3.added.length + poll3.updated.length + poll3.ended.length, 0,
  'resolved pending ruling is stable');

// Re-appearance of the marker on the same at-bat flips it back to pending.
const poll4 = mergeFeedEvents(state, 822688, [pend]);
assert.equal(poll4.updated.length, 1);
assert.equal(state.seen.get('822688:osp-10').review.inProgress, true);

// Test with playsByAtBatIndex: when a pending marker clears, the resolved
// play's description should be captured.
const state2 = { seen: new Map(), order: [] };
const poll5 = mergeFeedEvents(state2, 822688, [pend], new Map([['10', resolvedPrimaryPlay]]));
assert.equal(poll5.added.length, 1, 'pending ruling is added on first observation');
// Now simulate the marker clearing: no pending entry in reviews, but playsByAtBatIndex has the resolved play.
const poll6 = mergeFeedEvents(state2, 822688, [], new Map([['10', resolvedPrimaryPlay]]));
assert.equal(poll6.updated.length, 1, 'pending ruling is marked resolved');
const resolved2 = state2.seen.get('822688:osp-10').review;
assert.equal(resolved2.inProgress, false);
assert.equal(resolved2.outcome, 'resolved');
assert.equal(resolved2.outcomeLabel, 'Ruling Complete');
assert.equal(resolved2.resolvedWhenMarkerCleared, true);
assert.equal(resolved2.resolvedDescription,
  'Anthony Seigler reaches on a fielding error by third baseman.',
  'resolved description is captured from the resolved play');

/* ----------------------- 7. completePendingScoringReview (pure helper) */

const completed = completePendingScoringReview({ ...pend });
assert.equal(completed.inProgress, false);
assert.equal(completed.outcome, 'resolved');
assert.equal(completed.outcomeLabel, 'Ruling Complete');
assert.equal(completed.resolvedWhenMarkerCleared, true);
assert.equal(completePendingScoringReview(null), null);
assert.ok(!JSON.stringify(completePendingScoringReview(pend)).includes('undefined'),
  'resolution never leaks undefined into the row');

console.log('Official scoring pending tests passed successfully!');
