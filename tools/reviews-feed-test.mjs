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

/* Controllable clock: identical to the real Date while clockOffsetMs is 0.
 * The audio-alert test advances it past the 2.5s cooldown deterministically. */
let clockOffsetMs = 0;
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(Date.now() + clockOffsetMs);
  }
  static now() { return super.now() + clockOffsetMs; }
}

/* Recording stub for the Web Audio graph (filled in below, used by the
 * audio-alert section at the end of this file). */
const audioLog = { oscillators: [], edges: [], resumes: 0, ctx: null };

function stubAudioParam(events) {
  return {
    value: 0,
    setValueAtTime(v, t) { events.push({ kind: 'set', v, t }); },
    linearRampToValueAtTime(v, t) { events.push({ kind: 'lin', v, t }); },
    exponentialRampToValueAtTime(v, t) {
      // Real browsers throw on a zero target — catch that bug class here.
      assert.ok(v > 0, 'exponentialRampToValueAtTime target must be > 0 (0 throws in browsers)');
      events.push({ kind: 'exp', v, t });
    },
  };
}

function stubAudioNode(kind, extra = {}) {
  const node = {
    _kind: kind,
    ...extra,
    connect(to) { audioLog.edges.push([node, to]); return to; },
    disconnect() {},
  };
  return node;
}

class StubAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 100;
    this.destination = stubAudioNode('destination');
    audioLog.ctx = this;
  }
  resume() { audioLog.resumes += 1; return Promise.resolve(); }
  createGain() {
    const n = stubAudioNode('gain');
    n.gain = stubAudioParam((n._gainEvents = []));
    return n;
  }
  createOscillator() {
    const n = stubAudioNode('oscillator');
    n.type = null; // must be set explicitly by the code under test
    n.frequency = stubAudioParam((n._freqEvents = []));
    n.startedAt = null;
    n.stoppedAt = null;
    n.start = (t) => { n.startedAt = t; audioLog.oscillators.push(n); };
    n.stop = (t) => { n.stoppedAt = t; };
    return n;
  }
  createDelay() {
    const n = stubAudioNode('delay');
    n.delayTime = stubAudioParam((n._delayEvents = []));
    return n;
  }
  createBiquadFilter() {
    const n = stubAudioNode('filter', { type: null });
    n.frequency = stubAudioParam((n._freqEvents = []));
    return n;
  }
}

const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date: FakeDate, Math, Number, String, Object, Array, URLSearchParams, CSS: { escape: (s) => s },
  UI: { el: () => ({}), clear: () => ({}) },
  MLB: {},
  window: { AudioContext: StubAudioContext },
  document: { addEventListener() {}, querySelector: () => null },
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'assets/js/reviews-feed.js' });

const {
  buildEventKey, mergeFeedEvents, reconcileScoreImpact, reviewChanged,
  sortFeedEntries, gameTeamsLabel,
  isUsableName, officialTeamName, gameSideTeam,
  pollIntervalMs, waitAfterScan, reviewFetchPriority, mapPool,
  shouldAlertForReview, visibleInAllFeed,
  runsRemovableFromReview, shouldRunRiskAlert, diffRunRiskKeys,
  normalizeChallengeCounts, challengeCountIrregularities,
  teamSideInGame, teamChallengeLine, gameChallengeLine,
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

/* ----------------------- 4b. Observed score change across review resolution */

const riskImpact = {
  context: 'home_plate',
  scoringSide: 'away',
  runsCredited: 1,
  runsAtRisk: 1,
  runsAtRiskAtStart: 1,
  scoreAtReviewStart: { away: 6, home: 5 },
  possibleScoreAfterReview: { away: 5, home: 5 },
  officialScoreAfterReview: null,
  currentScore: { away: 6, home: 5 },
  possibleScoreIfRemoved: { away: 5, home: 5 },
  teamLabels: { away: 'NYY', home: 'BOS' },
};
const activeRisk = {
  ...mk('play-51-main', 'manager', 'in_progress', true),
  outcomeLabel: 'In Progress',
  reason: 'tag play at home',
  scoreImpact: riskImpact,
};
const activeTrackerState = { seen: new Map(), order: [] };
mergeFeedEvents(activeTrackerState, 98, [activeRisk]);
const repeatedActive = mergeFeedEvents(activeTrackerState, 98, [activeRisk]);
assert.equal(repeatedActive.updated.length, 0, 'unchanged active tracker poll is a no-op');

const activeRiskLaterPoll = reconcileScoreImpact(activeRisk, {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    scoreAtReviewStart: { away: 7, home: 5 },
    currentScore: { away: 7, home: 5 },
    possibleScoreAfterReview: { away: 6, home: 5 },
    possibleScoreIfRemoved: { away: 6, home: 5 },
  },
});
assert.equal(activeRiskLaterPoll.scoreImpact.scoreAtReviewStart.away, 6,
  'later active polls cannot rewrite the first observed score');
assert.equal(activeRiskLaterPoll.scoreImpact.possibleScoreAfterReview.away, 5,
  'the possible score remains paired with the first active snapshot');

const activeWithoutScenario = {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    runsCredited: 0,
    runsAtRisk: 0,
    runsAtRiskAtStart: 0,
    possibleScoreAfterReview: null,
    possibleScoreIfRemoved: null,
  },
};
const mismatchedLaterScenario = reconcileScoreImpact(activeWithoutScenario, {
  ...activeRisk,
  scoreImpact: {
    ...riskImpact,
    scoreAtReviewStart: { away: 7, home: 5 },
    currentScore: { away: 7, home: 5 },
    possibleScoreAfterReview: { away: 6, home: 5 },
    possibleScoreIfRemoved: { away: 6, home: 5 },
  },
});
assert.equal(mismatchedLaterScenario.scoreImpact.possibleScoreAfterReview, null,
  'a later scenario computed from a different score is not paired with the first snapshot');
assert.equal(mismatchedLaterScenario.scoreImpact.runsAtRiskAtStart, 0);
const enrichedSameScoreScenario = reconcileScoreImpact(activeWithoutScenario, activeRisk);
assert.equal(enrichedSameScoreScenario.scoreImpact.possibleScoreAfterReview.away, 5,
  'new runner details can add a scenario when its score still matches the first snapshot');
assert.equal(enrichedSameScoreScenario.scoreImpact.runsAtRiskAtStart, 1);

const finalRemoved = {
  ...mk('play-51-main', 'manager', 'overturned', false),
  reason: 'tag play at home',
  scoreImpact: {
    context: 'home_plate', scoringSide: 'away', runsCredited: 0, runsAtRisk: 0,
    runsAtRiskAtStart: 0,
    scoreAtReviewStart: null,
    possibleScoreAfterReview: null,
    officialScoreAfterReview: { away: 5, home: 5 },
    currentScore: { away: 5, home: 5 },
    possibleScoreIfRemoved: null,
    teamLabels: { away: 'NYY', home: 'BOS' },
  },
};
const scoreState = { seen: new Map(), order: [] };
mergeFeedEvents(scoreState, 99, [activeRisk]);
const resolvedScore = mergeFeedEvents(scoreState, 99, [finalRemoved]);
assert.equal(resolvedScore.updated.length, 1);
assert.equal(resolvedScore.updated[0].review.scoreImpact.actualRunsRemoved, 1,
  '6-5 active score -> 5-5 resolved score records one observed run removal');
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreBeforeReview.away, 6);
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreAfterReview.away, 5);
assert.equal(resolvedScore.updated[0].review.scoreImpact.scoreAtReviewStart.away, 6,
  'before-review snapshot is the call-on-field score first observed');
assert.equal(resolvedScore.updated[0].review.scoreImpact.possibleScoreAfterReview.away, 5,
  'conditional score survives resolution');
assert.equal(resolvedScore.updated[0].review.scoreImpact.runsAtRiskAtStart, 1,
  'the scenario retains how many credited runs were originally at risk');
assert.equal(resolvedScore.updated[0].review.scoreImpact.officialScoreAfterReview.away, 5,
  'actual-after snapshot comes from the resolved play');
const repeatedFinal = mergeFeedEvents(scoreState, 99, [finalRemoved]);
assert.equal(repeatedFinal.updated.length, 0, 'unchanged final poll is a no-op');
assert.equal(scoreState.seen.get('99:play-51-main').review.scoreImpact.actualRunsRemoved, 1,
  'observed removal persists after later final-only payloads');

const finalOnlyState = { seen: new Map(), order: [] };
mergeFeedEvents(finalOnlyState, 100, [finalRemoved]);
mergeFeedEvents(finalOnlyState, 100, [finalRemoved]);
assert.equal(finalOnlyState.seen.get('100:play-51-main').review.scoreImpact.scoreAtReviewStart, null,
  'repeated final-only polls never back-fill Before review from the final score');
assert.equal(finalOnlyState.seen.get('100:play-51-main').review.scoreImpact.officialScoreAfterReview.away, 5);

const missingStartState = { seen: new Map(), order: [] };
const activeWithoutScore = {
  ...activeRisk,
  id: 'play-52-main',
  scoreImpact: {
    ...activeWithoutScenario.scoreImpact,
    activeReviewObserved: true,
    scoreAtReviewStart: null,
    currentScore: null,
  },
};
const finalAfterMissingStart = {
  ...finalRemoved,
  id: 'play-52-main',
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    activeReviewObserved: false,
    officialScoreAfterReview: { away: 5, home: 5 },
    currentScore: { away: 5, home: 5 },
  },
};
mergeFeedEvents(missingStartState, 102, [activeWithoutScore]);
mergeFeedEvents(missingStartState, 102, [finalAfterMissingStart]);
const repeatedMissingStartFinal = mergeFeedEvents(missingStartState, 102, [finalAfterMissingStart]);
const missingStartImpact = missingStartState.seen.get('102:play-52-main').review.scoreImpact;
assert.equal(repeatedMissingStartFinal.updated.length, 0);
assert.equal(missingStartImpact.activeReviewObserved, true,
  'later final polls remember that an active payload was seen even when its score was incomplete');
assert.equal(missingStartImpact.scoreAtReviewStart, null);
assert.equal(missingStartImpact.officialScoreAfterReview.away, 5);

const aliasState = { seen: new Map(), order: [] };
const syntheticActiveRisk = { ...activeRisk, id: 'live-active-review', atBatIndex: 51 };
const resolvedAliasRisk = { ...finalRemoved, atBatIndex: 51 };
mergeFeedEvents(aliasState, 101, [syntheticActiveRisk]);
const aliasedResolution = mergeFeedEvents(aliasState, 101, [resolvedAliasRisk]);
assert.equal(aliasedResolution.added.length, 0,
  'a resolved play id replaces its matching status-only active id instead of duplicating it');
assert.equal(aliasedResolution.updated.length, 1);
assert.equal(aliasedResolution.ended.length, 0);
assert.equal(aliasState.seen.has('101:live-active-review'), false);
assert.equal(aliasState.seen.get('101:play-51-main').review.scoreImpact.scoreAtReviewStart.away, 6);
assert.equal(aliasState.seen.get('101:play-51-main').review.scoreImpact.officialScoreAfterReview.away, 5);

const finalRetained = {
  ...finalRemoved,
  outcome: 'stands',
  outcomeLabel: 'Call Stands',
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    officialScoreAfterReview: { away: 6, home: 5 },
    currentScore: { away: 6, home: 5 },
  },
};
const retained = reconcileScoreImpact(activeRisk, finalRetained);
assert.equal(retained.scoreImpact.runsRetained, 1,
  'unchanged official score records that the observed at-risk run remained');
assert.equal(retained.scoreImpact.actualRunsRemoved, undefined);

const activeBoundaryPending = {
  ...activeRisk,
  scoreImpact: {
    context: 'boundary', scoringSide: 'home', runsCredited: 0, runsAtRisk: 0,
    currentScore: { away: 3, home: 3 }, teamLabels: { away: 'NYY', home: 'BAL' },
  },
};
const finalBoundaryAdded = reconcileScoreImpact(activeBoundaryPending, {
  ...finalRemoved,
  scoreImpact: {
    context: 'boundary', scoringSide: 'home', runsCredited: 1, runsAtRisk: 0,
    currentScore: { away: 3, home: 4 }, teamLabels: { away: 'NYY', home: 'BAL' },
  },
});
assert.equal(finalBoundaryAdded.scoreImpact.actualRunsAdded, 1,
  '3-3 boundary review -> 3-4 resolution records one observed added run');

const opponentAlsoMoved = reconcileScoreImpact(activeRisk, {
  ...finalRemoved,
  scoreImpact: {
    ...finalRemoved.scoreImpact,
    officialScoreAfterReview: { away: 5, home: 6 },
    currentScore: { away: 5, home: 6 },
  },
});
assert.equal(opponentAlsoMoved.scoreImpact.actualRunsRemoved, undefined,
  'do not attribute a score transition when the other team score also changed');

const sameOutcomeNewImpact = {
  ...activeRisk,
  scoreImpact: { ...riskImpact, runsAtRisk: 2 },
};
assert.equal(reviewChanged(activeRisk, sameOutcomeNewImpact), true,
  'new score-impact data updates a row even while outcome remains in progress');

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

/* ----------------------------- 10. Alert gating (which events make sound) */

// ABS pitch challenges are routine and must stay silent…
assert.equal(shouldAlertForReview({ typeKey: 'abs' }), false);
// …while every other observed review typeKey alerts.
assert.equal(shouldAlertForReview({ typeKey: 'manager' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'crew_chief' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'boundary' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'review' }), true);
assert.equal(shouldAlertForReview({ typeKey: 'rules' }), true);
// Defensive: junk input never alerts.
assert.equal(shouldAlertForReview(null), false);
assert.equal(shouldAlertForReview({}), false);
assert.equal(shouldAlertForReview({ typeKey: 42 }), false);

/* --------------- 10b. All-section visibility (ABS has its own section)
 *
 * The All section shows challenges, reviews, boundary calls, under-review
 * status and run-at-risk entries, but NOT ABS pitch challenges. ABS stays
 * tracked (own tab / stat / counters) and stays silent (§10 above). This
 * gate is independent of alerting: a run-at-risk ABS-typed entry is still
 * hidden from All (its own tab + the run-at-risk surfaces show it) while
 * the run-at-risk ALERT gate remains data-driven, unchanged.
 */

// The one excluded category: ABS pitch challenges (official code "MJ").
assert.equal(visibleInAllFeed({ typeKey: 'abs' }), false);
// Every other observed review typeKey belongs in All…
['manager', 'crew_chief', 'boundary', 'review', 'rules'].forEach((typeKey) => {
  assert.equal(visibleInAllFeed({ typeKey }), true, `${typeKey} must stay in the All section`);
});
// …even when flagged run-at-risk or under review (All keeps those
// categories; only the ABS type itself is sectioned out).
assert.equal(visibleInAllFeed({ typeKey: 'manager', inProgress: true }), true);
// Defensive: unknown / malformed entries fail OPEN — an unrecognized event
// must never be silently hidden from the main feed.
assert.equal(visibleInAllFeed(null), true);
assert.equal(visibleInAllFeed(undefined), true);
assert.equal(visibleInAllFeed({}), true);
assert.equal(visibleInAllFeed({ typeKey: 42 }), true);

/* ---------------------- 11. Audio alert is a gentle raindrop chime
 *
 * Drives window.ReplayFeed against a recording AudioContext stub and
 * verifies the graph the code actually builds:
 *   - silence while the toggle is off; preview plays once when enabled
 *   - every oscillator is an explicitly-set sine (no square/sawtooth buzz)
 *   - three pitch-drop "raindrop" voices + a soft chime tail
 *   - per-voice levels stay gentle (≤ 0.3) and envelopes end cleanly
 *   - the 2.5s cooldown blocks an immediate repeat and admits one after it
 *   - a suspended context is resumed before playing
 */

const ReplayFeed = context.window.ReplayFeed;
assert.ok(ReplayFeed, 'window.ReplayFeed API is exported');

// 11a. Disabled by default (no localStorage in this VM): nothing plays.
assert.equal(ReplayFeed.getSoundEnabled(), false);
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'no sound while the toggle is off');

// 11b. Enabling plays exactly one preview alert (the user-gesture path).
ReplayFeed.setSoundEnabled(true);
assert.equal(ReplayFeed.getSoundEnabled(), true);
const previewCount = audioLog.oscillators.length;
assert.ok(previewCount > 0, 'enabling the toggle plays a preview');

// 11c. Every oscillator is an explicitly-set pure sine — no buzz timbres.
audioLog.oscillators.forEach((osc) => {
  assert.equal(osc.type, 'sine', 'alert must use sine oscillators only (soft timbre)');
  assert.ok(Number.isFinite(osc.startedAt) && Number.isFinite(osc.stoppedAt), 'oscillator has start/stop');
  assert.ok(osc.stoppedAt > osc.startedAt, 'oscillator stop is after start');
});

// 11d. Voice mix: 3 pitch-drop raindrops (exponential high→low sweep) + 2
//     steady-pitch chime partials = the recognizable gentle motif.
const drops = audioLog.oscillators.filter((o) => o._freqEvents.some((e) => e.kind === 'exp'));
const chimes = audioLog.oscillators.filter((o) => !o._freqEvents.some((e) => e.kind === 'exp'));
assert.equal(drops.length, 3, 'exactly three raindrop voices');
assert.equal(chimes.length, 2, 'exactly two chime partials');
drops.forEach((o) => {
  const from = o._freqEvents.find((e) => e.kind === 'set').v;
  const to = o._freqEvents.find((e) => e.kind === 'exp').v;
  assert.ok(from > to && to > 0, `raindrop sweeps high→low (${from}→${to} Hz)`);
});
// The drops ascend (rising plip-plop-ploop motif = clearly an alert).
const dropFroms = drops.map((o) => o._freqEvents.find((e) => e.kind === 'set').v);
assert.ok(dropFroms[0] < dropFroms[1] && dropFroms[1] < dropFroms[2],
  `raindrops ascend (${dropFroms.join(' → ')} Hz)`);

// 11e. Gentle levels + clean envelopes on every oscillator's gain node.
audioLog.oscillators.forEach((osc) => {
  const edge = audioLog.edges.find(([src]) => src === osc);
  assert.ok(edge, 'each oscillator connects into a gain node');
  const voiceGain = edge[1];
  assert.equal(voiceGain._kind, 'gain');
  const peaks = voiceGain._gainEvents.map((e) => e.v).filter((v) => v > 0);
  assert.ok(peaks.length, 'voice gain is automated');
  assert.ok(Math.max(...peaks) <= 0.3, `voice level is gentle (peak ${Math.max(...peaks)})`);
  const kinds = voiceGain._gainEvents.map((e) => e.kind).join(',');
  assert.ok(kinds.includes('lin') && kinds.includes('exp'),
    'voice envelope has a fast attack and an exponential (natural) decay');
});

// 11f. The 2.5s cooldown: an immediate repeat is suppressed…
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, previewCount, 'cooldown blocks an immediate repeat');
// …and after the cooldown a new alert plays.
clockOffsetMs = 3000;
audioLog.ctx.state = 'suspended';
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, previewCount * 2, 'alert plays again after the cooldown');
assert.ok(audioLog.resumes >= 1, 'a suspended AudioContext is resumed before playing');

// 11g. Disabling silences it again (and no preview on mute).
ReplayFeed.setSoundEnabled(false);
assert.equal(ReplayFeed.getSoundEnabled(), false);
assert.equal(audioLog.oscillators.length, previewCount * 2, 'muting plays nothing');

/* ------------------------- 12. Run-at-risk detection (the ASAP alert)
 *
 * A run already on the scoreboard can only be "at risk" when the review is
 * still active AND the official payload credits runs to the reviewed event.
 * Nothing here is inferred from a score delta or predicted from a ruling.
 */

const activeOneRun = {
  typeKey: 'manager', inProgress: true,
  scoreImpact: { runsCredited: 1, runsAtRisk: 1, runsAtRiskAtStart: 1 },
};
const activeThreeRun = {
  typeKey: 'boundary', inProgress: true,
  scoreImpact: { runsCredited: 3, runsAtRisk: 3, runsAtRiskAtStart: 3 },
};

// 12a. Active + credited runs = at risk, with the observed count.
assert.equal(runsRemovableFromReview(activeOneRun), 1);
assert.equal(runsRemovableFromReview(activeThreeRun), 3);
assert.equal(shouldRunRiskAlert(activeOneRun), true);
assert.equal(shouldRunRiskAlert(activeThreeRun), true);

// 12b. Every review type is eligible — unlike the new-review chime gate, the
// run-at-risk gate is driven by the DATA, not by the review's type. ABS included.
['manager', 'crew_chief', 'boundary', 'review', 'rules', 'abs'].forEach((typeKey) => {
  assert.equal(shouldRunRiskAlert({ ...activeOneRun, typeKey }), true,
    `${typeKey} with a credited run at risk must alert`);
});
// The soft chime still skips ABS; the two gates are independent.
assert.equal(shouldAlertForReview({ typeKey: 'abs' }), false);
assert.equal(shouldRunRiskAlert({ typeKey: 'abs' }), false,
  'an ABS challenge with no credited run is still not a run-risk event');

// 12c. A resolved review can never put a run at risk.
assert.equal(shouldRunRiskAlert({ ...activeOneRun, inProgress: false }), false);
assert.equal(runsRemovableFromReview({ ...activeOneRun, inProgress: false }), 0);

// 12d. An active review with no scoring runner tied to it is not at risk.
assert.equal(shouldRunRiskAlert({
  typeKey: 'boundary', inProgress: true,
  scoreImpact: { runsCredited: 0, runsAtRisk: 0, runsAtRiskAtStart: 0 },
}), false);

// 12e. reconcileScoreImpact() preserves the FIRST snapshot, so
// runsAtRiskAtStart can lag at 0 on the poll where runner records land. The
// largest observed candidate wins so a late run is never dropped.
assert.equal(runsRemovableFromReview({
  typeKey: 'manager', inProgress: true,
  scoreImpact: { runsAtRiskAtStart: 0, runsAtRisk: 0, runsCredited: 2 },
}), 2);

// 12f. Malformed input never throws and never alerts.
[null, undefined, {}, { inProgress: true }, { inProgress: true, scoreImpact: null },
  { inProgress: true, scoreImpact: 7 },
  { inProgress: true, scoreImpact: { runsCredited: NaN } },
  { inProgress: true, scoreImpact: { runsCredited: -1 } },
  { inProgress: true, scoreImpact: { runsCredited: '2' } },
  { inProgress: 1, scoreImpact: { runsCredited: 2 } },
].forEach((bad) => {
  assert.equal(runsRemovableFromReview(bad), 0, `zero runs for ${JSON.stringify(bad)}`);
  assert.equal(shouldRunRiskAlert(bad), false, `no run-at-risk alert for ${JSON.stringify(bad)}`);
});

// 12g. It agrees with MLBReviews.runsRemovableByReview() on the tracker
// fixture used by section 4b above (the two implementations must not drift).
assert.equal(runsRemovableFromReview(activeRisk), 1);
assert.equal(shouldRunRiskAlert(activeRisk), true);

/* --------------- 13. Alert de-duplication across polls (diffRunRiskKeys) */

const keyOf = (entry) => buildEventKey(entry.gamePk, entry.review);
const entryOf = (gamePk, review) => ({ gamePk, review });

// 13a. First sighting of a risky review starts an alert.
let tracked = new Set();
const pollOne = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
  entryOf(2, { ...activeOneRun, id: 'play-9-main', inProgress: false }),
], keyOf);
assert.deepEqual([...pollOne.started], ['1:play-5-main'], 'only the risky review alerts');
assert.deepEqual([...pollOne.cleared], []);
assert.deepEqual([...pollOne.next], ['1:play-5-main']);
tracked = pollOne.next;

// 13b. The SAME review still active on the next poll must NOT re-alert.
const pollTwo = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf);
assert.deepEqual([...pollTwo.started], [], 'a still-running review does not re-alert every poll');
assert.deepEqual([...pollTwo.cleared], []);
tracked = pollTwo.next;

// 13c. A second game going at-risk alerts on its own, once.
const pollThree = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
  entryOf(2, { ...activeThreeRun, id: 'play-11-main' }),
], keyOf);
assert.deepEqual([...pollThree.started], ['2:play-11-main']);
assert.deepEqual([...pollThree.next].sort(), ['1:play-5-main', '2:play-11-main']);
tracked = pollThree.next;

// 13d. Resolution clears the key (so a later, genuinely new review on the
// same play can alert again) without alerting on the way out.
const pollFour = diffRunRiskKeys(tracked, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main', inProgress: false }),
  entryOf(2, { ...activeThreeRun, id: 'play-11-main' }),
], keyOf);
assert.deepEqual([...pollFour.started], []);
assert.deepEqual([...pollFour.cleared], ['1:play-5-main']);
assert.deepEqual([...pollFour.next], ['2:play-11-main']);
tracked = pollFour.next;

// 13e. An entry that vanishes from the feed entirely is cleared too.
const pollFive = diffRunRiskKeys(tracked, [], keyOf);
assert.deepEqual([...pollFive.cleared], ['2:play-11-main']);
assert.equal(pollFive.next.size, 0);

// 13f. After clearing, the same play going back under review alerts again.
const pollSix = diffRunRiskKeys(pollFive.next, [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf);
assert.deepEqual([...pollSix.started], ['1:play-5-main'], 'a re-review re-alerts');

// 13g. Defensive: junk entries are skipped, not crashed on.
const pollJunk = diffRunRiskKeys(new Set(), [null, undefined, { gamePk: 3 }], keyOf);
assert.deepEqual([...pollJunk.started], []);
assert.equal(pollJunk.next.size, 0);
// An array (not a Set) is accepted as the previous state.
assert.deepEqual([...diffRunRiskKeys(['1:play-5-main'], [
  entryOf(1, { ...activeOneRun, id: 'play-5-main' }),
], keyOf).started], []);

/* ------------- 14. The run-at-risk alert IS the same raindrop chime
 *
 * By request the run-at-risk alert uses the ordinary review chime rather than
 * a separate urgent voice. These assertions pin that: the two entry points
 * must build an identical audio graph and share one cooldown, so they can
 * never drift into two different sounds.
 */

/** Snapshot the voice graph the recording stub just captured. */
function captureVoices() {
  return audioLog.oscillators.map((osc) => {
    const edge = audioLog.edges.find(([src]) => src === osc);
    assert.ok(edge, 'each oscillator connects into a gain node');
    return {
      type: osc.type,
      // Include the scheduled TIMES, not just the values, so two graphs only
      // compare equal when the rhythm is identical too.
      freq: osc._freqEvents.map((e) => `${e.kind}@${e.v}t${e.t}`).join(','),
      gain: edge[1]._gainEvents.map((e) => `${e.kind}@${e.v}t${e.t}`).join(','),
      start: osc.startedAt,
      dur: Number((osc.stoppedAt - osc.startedAt).toFixed(6)),
    };
  });
}

audioLog.oscillators.length = 0;
audioLog.edges.length = 0;
clockOffsetMs = 60000;
audioLog.ctx.state = 'running';

// 14a. Silent while muted, exactly like the chime.
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'no run-at-risk alert while the toggle is off');

// 14b. Capture the ordinary chime (the preview fired by enabling sound).
ReplayFeed.setSoundEnabled(true);
const chimeVoices = captureVoices();
assert.equal(chimeVoices.length, 5, 'the chime is the 3-drop + 2-partial motif');

// 14c. Capture the run-at-risk alert and compare it voice for voice.
audioLog.oscillators.length = 0;
audioLog.edges.length = 0;
clockOffsetMs = 120000;
ReplayFeed.playRunRiskAlertSound();
const runRiskVoices = captureVoices();
assert.ok(runRiskVoices.length > 0, 'the run-at-risk alert plays when sound is on');
assert.deepEqual(runRiskVoices, chimeVoices,
  'the run-at-risk alert must be the SAME raindrop chime, voice for voice');

// Belt and braces: it still satisfies every property the chime is held to.
assert.equal(runRiskVoices.length, 5);
runRiskVoices.forEach((v) => assert.equal(v.type, 'sine', 'sine-only, no buzz'));
assert.equal(runRiskVoices.filter((v) => v.freq.includes('exp@')).length, 3,
  'three raindrop pitch-sweeps, same as the chime');
assert.equal(runRiskVoices.filter((v) => !v.freq.includes('exp@')).length, 2,
  'two steady chime partials, same as the chime');
const runRiskPeaks = runRiskVoices.flatMap((v) => v.gain.split(',')
  .map((e) => Number(e.split('@')[1])).filter((n) => n > 0));
assert.ok(Math.max(...runRiskPeaks) <= 0.3,
  `run-at-risk alert stays at the gentle chime level (peak ${Math.max(...runRiskPeaks)})`);

// 14d. ONE shared cooldown — the same sound must never chime on top of itself.
audioLog.oscillators.length = 0;
ReplayFeed.playAlertSound();
assert.equal(audioLog.oscillators.length, 0,
  'the ordinary chime is blocked by the run-at-risk alert that just played');
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, 0, 'and so is an immediate run-at-risk repeat');
clockOffsetMs = 130000;
ReplayFeed.playRunRiskAlertSound();
assert.equal(audioLog.oscillators.length, 5, 'it plays again after the shared 2.5s cooldown');

// 14e. A suspended context is resumed before the run-at-risk alert plays.
const resumesBefore = audioLog.resumes;
audioLog.ctx.state = 'suspended';
clockOffsetMs = 140000;
ReplayFeed.playRunRiskAlertSound();
assert.ok(audioLog.resumes > resumesBefore, 'run-at-risk alert resumes a suspended AudioContext');

ReplayFeed.setSoundEnabled(false);

/* --------------------------- 15. Challenges-remaining tracker (pure helpers)
 * Fixtures are VERBATIM live captures from statsapi.mlb.com on 2026-08-28:
 *   - game 824638 (CIN @ CHC, In Progress): feed/live gameData carried
 *       review:        {hasChallenges:false, away:{used:0,remaining:1}, home:{used:0,remaining:1}}
 *       absChallenges: {hasChallenges:true,  away:{usedSuccessful:2,usedFailed:0,remaining:2},
 *                                            home:{usedSuccessful:3,usedFailed:0,remaining:2}}
 *   - game 824879 (LAD @ ATL, Final 2026-08-27): review home used:2 remaining:0,
 *       absChallenges away usedFailed:1 remaining:1.
 *   - game 776162 (BAL @ NYY, Final 2025-09-27, pre-ABS season): feed/live
 *       gameData has review but NO absChallenges object at all.
 */

// 15a. Both live sources normalize; nothing is invented.
const live824638 = normalizeChallengeCounts(
  { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  { hasChallenges: true,
    away: { usedSuccessful: 2, usedFailed: 0, remaining: 2 },
    home: { usedSuccessful: 3, usedFailed: 0, remaining: 2 } });
assert.equal(live824638.manager.away.used, 0);
assert.equal(live824638.manager.home.remaining, 1);
assert.equal(live824638.abs.away.usedSuccessful, 2);
assert.equal(live824638.abs.home.remaining, 2);

// 15b. Pre-ABS season (verified 2025 game 776162): abs stays null, never 0.
const preAbs = normalizeChallengeCounts(
  { hasChallenges: true, away: { used: 0, remaining: 1 }, home: { used: 1, remaining: 0 } },
  null);
assert.equal(preAbs.abs, null, 'missing absChallenges must stay null, not zero-filled');
assert.equal(preAbs.manager.home.used, 1);

// 15c. Wholly missing/malformed input yields null, and partial numbers stay null.
assert.equal(normalizeChallengeCounts(null, null), null);
assert.equal(normalizeChallengeCounts({}, {}), null);
const malformed = normalizeChallengeCounts(
  { away: { used: 'one', remaining: -2 }, home: { used: 1 } }, null);
assert.equal(malformed.manager.away, null, 'non-numeric/negative counters are rejected');
assert.equal(malformed.manager.home.used, 1);
assert.equal(malformed.manager.home.remaining, null, 'a missing counter is null, never 0');

// 15d. Irregularity flag: a used counter can never decrease within a game.
const before = normalizeChallengeCounts(
  { away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 1, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
const regressed = normalizeChallengeCounts(
  { away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 0, usedFailed: 1, remaining: 1 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
const issues = challengeCountIrregularities(before, regressed);
assert.equal(JSON.stringify(issues),
  JSON.stringify(['manager.away.used decreased 1 → 0', 'abs.away.usedSuccessful decreased 1 → 0']));

// 15e. remaining may legitimately rise (successful ABS challenges are retained;
// extra innings can regain one) — never flagged in either direction.
const regained = normalizeChallengeCounts(
  { away: { used: 1, remaining: 0 }, home: { used: 0, remaining: 1 } },
  { away: { usedSuccessful: 1, usedFailed: 1, remaining: 2 }, home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 } });
assert.equal(challengeCountIrregularities(before, regained).length, 0,
  'a rising remaining counter is not an irregularity');
assert.equal(challengeCountIrregularities(null, regained).length, 0);
assert.equal(challengeCountIrregularities(before, null).length, 0);

// 15f. teamSideInGame reads only the schedule's team ids.
const cinChc = { teams: {
  away: { team: { id: 113, name: 'Cincinnati Reds', link: '/api/v1/teams/113' } },
  home: { team: { id: 112, name: 'Chicago Cubs', link: '/api/v1/teams/112' } },
} };
assert.equal(teamSideInGame(cinChc, 113), 'away');
assert.equal(teamSideInGame(cinChc, 112), 'home');
assert.equal(teamSideInGame(cinChc, 999), null);
assert.equal(teamSideInGame(cinChc, null), null);

// 15g. Per-team line: only ABS/manager types, only observed counters.
assert.equal(teamChallengeLine(live824638, 'away', 'CIN', 'abs', 'now'),
  'CIN: 2 ABS challenges left now (2 successful · 0 failed)');
assert.equal(teamChallengeLine(live824638, 'home', 'CHC', 'manager', 'now'),
  'CHC: 1 manager challenge left now (0 used)');
assert.equal(teamChallengeLine(live824638, 'away', 'CIN', 'boundary', 'now'), null,
  'crew-chief/boundary reviews are not charged to a team counter');
assert.equal(teamChallengeLine(preAbs, 'away', 'BAL', 'abs', 'now'), null,
  'no ABS counters in a pre-ABS season — nothing rendered, not 0');
assert.equal(teamChallengeLine(live824638, null, 'CIN', 'abs', 'now'), null);

// 15h. Both-teams summary omits unavailable halves and never zero-fills.
assert.equal(gameChallengeLine(live824638, { away: 'CIN', home: 'CHC' }, 'Challenges left'),
  'Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS');
assert.equal(gameChallengeLine(preAbs, { away: 'BAL', home: 'NYY' }, 'Challenges left'),
  'Challenges left: BAL 1 MGR — NYY 0 MGR');
assert.equal(gameChallengeLine(null, { away: 'CIN', home: 'CHC' }), null);
assert.equal(gameChallengeLine(normalizeChallengeCounts({}, {}), {}), null);
const blob15 = [
  teamChallengeLine(live824638, 'away', 'CIN', 'abs', 'now'),
  gameChallengeLine(live824638, { away: 'CIN', home: 'CHC' }),
].join(' | ');
assert.ok(!blob15.includes('undefined'), `challenge lines leaked "undefined": ${blob15}`);

console.log('Replay feed tests passed successfully!');
