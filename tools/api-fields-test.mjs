#!/usr/bin/env node
/* ============================================================================
 * api-fields-test.mjs — deterministic tests for the playByPlay `fields`
 * projection in assets/js/api.js (the feed's latency-critical endpoint).
 *
 * Run: node tools/api-fields-test.mjs
 *
 * VERIFICATION BASIS (line-by-line, no guesses):
 *   - The projection field list must contain EVERY property the two
 *     playByPlay consumers read. Each required name below cites the exact
 *     code line that reads it (verified 2026-08-30):
 *       assets/js/reviews.js — extractReviews / processPlay / buildAbsContext /
 *         deriveScoreImpact / reviewedScoringRunners / findReviewedPitch /
 *         countEnteringPitch / scoreBeforePlay / buildPendingScoringEntry
 *       assets/js/game.js — reviewProbeState (lines 76-97) and the fast-path
 *         probe in load()
 *   - The exact projected URL shape was verified LIVE against
 *     statsapi.mlb.com on 2026-08-30 (game 823342 / 822688): the API honors
 *     `fields=` and returns reviewDetails / details.hasReview / runners /
 *     matchup / count / pitchData for the captured MJ challenge at atBatIndex
 *     15. This test only pins the REQUEST (network is not available here);
 *     the payload-level verification is documented in
 *     docs/verification-report.md §15.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const apiSource = readFileSync(new URL('../assets/js/api.js', import.meta.url), 'utf8');

/* ------------------------------------------------ stub fetch (recording) */

const requests = [];
let failNext = null; // { status } → respond with that HTTP status once.
let failAll = null;  // { status } → respond with that status until cleared.

function stubResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

async function fakeFetch(url, init) {
  requests.push({ url, init: init || {} });
  const u = new URL(url);
  // failAll targets the playByPlay endpoint only: the test wants to prove the
  // LAST resort is feed/live, so feed/live and its split endpoints must work.
  if (failNext || (failAll && /\/playByPlay$/.test(u.pathname))) {
    const status = failNext ? failNext.status : failAll.status;
    failNext = null;
    return stubResponse({ error: 'request failed' }, status);
  }
  const withFields = u.searchParams.get('fields');
  if (withFields && withFields.includes('allPlays')) {
    return stubResponse({ allPlays: [], currentPlay: null, projected: true }, 200);
  }
  if (u.pathname.endsWith('/feed/live')) {
    return stubResponse({ gameData: {}, liveData: { plays: {} } }, 200);
  }
  // plain playByPlay (no fields)
  return stubResponse({ allPlays: [], currentPlay: null, projected: false }, 200);
}

const context = {
  console: { warn() {}, error() {}, log() {} },
  fetch: fakeFetch,
  AbortController,
  setTimeout, clearTimeout, Promise, Date, URL,
};
vm.createContext(context);
vm.runInContext(apiSource, context, { filename: 'assets/js/api.js' });
// Top-level `const MLB` lives in the vm's global lexical scope (not on the
// global object), so read it back with a script expression.
const MLB = vm.runInContext('MLB', context);
assert.ok(MLB && typeof MLB.getPlayByPlay === 'function', 'api.js loads and exposes getPlayByPlay');

/* ------------------------- 1. The projection is used by getPlayByPlay */

requests.length = 0;
const pbp = await MLB.getPlayByPlay(822688);
assert.equal(requests.length, 1, 'one request per getPlayByPlay call');
assert.match(requests[0].url, /^https:\/\/statsapi\.mlb\.com\/api\/v1\/game\/822688\/playByPlay\?fields=/,
  'getPlayByPlay requests the fields projection');
assert.equal(pbp.projected, true, 'the projected response is returned as-is');

/* 2. The projection must contain every field the PROJECTED playback is read
 *    by. The projected playByPlay is consumed by:
 *      - reviews.js extractReviews() (via reviews-feed.js ingestGame →
 *        window.MLBReviews.extractReviews) — the feed's review rows
 *      - reviews-feed.js official-scoring-change tracker (buildScoringSnapshot
 *        / scoringChangeSummary / scoringChangeBlock) — the ✏️ Scoring
 *        Changes rows: classification diffs over result + runners[].movement
 *      - game.js reviewProbeState() — the 250ms in-review probe
 *    Every name below is a HARD read on that path; citations are
 *    `<file>:<line>` in the current source. */
const REQUIRED = [
  // container keys (both consumers)
  ['allPlays', 'reviews.js:allPlays.forEach; game.js:reviewProbeState all'],
  ['currentPlay', 'reviews.js:processPlay(currentPlay); game.js:reviewProbeState cur'],
  // play.about (reviews.js buildPendingScoringEntry / processPlay /
  // scoreBeforePlay / resolveChallenger; game.js reviewProbeState)
  ['about', 'kept as container of the leaves below'],
  ['atBatIndex', 'reviews.js:204,205,961,1012,1016,1038'],
  ['inning', 'reviews.js:206,882,885'],
  ['halfInning', 'reviews.js:194,397,573,883'],
  ['startTime', 'reviews.js:229,230,1023,1059'],
  ['endTime', 'reviews.js:229,230,1023,1059'],
  ['isComplete', 'reviews.js:1009,1035'],
  ['hasReview', 'reviews.js:999,1003; game.js:93,184,204 (about.hasReview / details.hasReview)'],
  // play.result (reviews.js readScorePair + toDescription + pending match)
  ['result', 'kept as container of the leaves below'],
  ['event', 'reviews.js:116,117,159,192,528,529,588'],
  ['eventType', 'reviews.js:116,159,528,544,588,589'],
  ['description', 'reviews.js:118,159,192,590'],
  ['awayScore', 'reviews.js:481,484 (readScorePair(result)); reviews-feed.js buildScoringSnapshot awayScore'],
  ['homeScore', 'reviews.js:481,484 (readScorePair(result)); reviews-feed.js buildScoringSnapshot homeScore'],
  ['isOut', 'reviews-feed.js buildScoringSnapshot result.isOut + movement.isOut (scoring classification diff)'],
  ['rbi', 'reviews-feed.js buildScoringSnapshot result.rbi (RBI-change irregularity diff)'],
  // play.matchup (reviews.js resolveChallenger / buildAbsContext)
  ['matchup', 'reviews.js:366-368'],
  ['batter', 'reviews.js:233,367,373,979'],
  ['pitcher', 'reviews.js:234,368,376,980'],
  ['id', 'reviews.js:233,234,979,980 (batter/pitcher.id)'],
  ['fullName', 'reviews.js:233,234,373,376,979,980'],
  // playEvents + pitch data (reviews.js processPlay / buildAbsContext /
  // findReviewedPitch; game.js reviewProbeState)
  ['playEvents', 'reviews.js:321,419,421; game.js:91-96'],
  ['index', 'reviews.js:541 (event.index === runner playIndex)'],
  ['isPitch', 'reviews.js:321,419,421,1021'],
  ['pitchData', 'reviews.js:1022'],
  ['startSpeed', 'reviews.js:1022'],
  ['type', 'reviews.js:115,148 (event.type)'],
  // counts (reviews.js readPitchCount on play.count AND event count)
  ['count', 'reviews.js:427,441 (event.count); reviews.js:297-309'],
  ['balls', 'reviews.js:297,308,327,441'],
  ['strikes', 'reviews.js:298,308,327,441'],
  ['outs', 'reviews.js:302'],
  // review markers (both consumers)
  ['reviewDetails', 'reviews.js:421,849-855; game.js:87-95,1122'],
  ['inProgress', 'reviews.js:850; game.js:88,94'],
  ['isOverturned', 'reviews.js:854,855; game.js:89,95'],
  ['reviewType', 'reviews.js:1011,1037; game.js:89,95,1128'],
  ['challengeTeamId', 'reviews.js:355,366,380,396,400,408,433'],
  // event-level details (reviews.js description extraction; game.js probe)
  ['details', 'reviews.js:114,147,591; game.js:93,184,186,203,204'],
  // scoring runners (reviews.js reviewedScoringRunners / deriveScoreImpact;
  // reviews-feed.js buildScoringSnapshot movement signature)
  ['runners', 'reviews.js:515'],
  ['movement', 'reviews.js:597 (movement.outBase); reviews-feed.js buildScoringSnapshot movement sig'],
  ['outBase', 'reviews.js:597; reviews-feed.js buildScoringSnapshot (OUT:<base> label)'],
  ['originBase', 'reviews-feed.js buildScoringSnapshot movement signature (originBase leg)'],
  ['end', 'reviews-feed.js buildScoringSnapshot movement.end endpoint leg'],
  ['runner', 'reviews.js:618 (runner.details.runner.fullName); reviews-feed.js footer/scoring labels'],
  ['isScoringEvent', 'reviews.js:517'],
  ['playIndex', 'reviews.js:531,534,541'],
];

/* `fields` is a whitelist applied at any depth; extra leaf names are cheap
 * and protect against the API pruning a named container's children. These
 * are kept deliberately — they are NOT claimed as reads of the projected
 * payload (they feed the full-feed render path in game.js: batSide/pitchHand
 * at 522/583/660-661/1179-1181, details.call at 1164, movement.start at
 * 1230). `rbi`, `isOut` and `end` were promoted to REQUIRED when the
 * official-scoring-change tracker became a third projected-payload consumer. */
const GUARD = ['isTopInning', 'batSide', 'pitchHand', 'call', 'start'];

const fieldsParam = new URL(requests[0].url).searchParams.get('fields');
const included = new Set(fieldsParam.split(','));
const missing = REQUIRED.filter(([name]) => !included.has(name));
assert.deepEqual(missing.map(([name, where]) => `${name} (${where})`), [],
  `projection is missing fields the code reads: ${JSON.stringify(missing)}`);

/* Every whitelisted name must be accounted for — REQUIRED (read) or GUARD
 * (kept deliberately). An unaccounted name is a no-hallucination failure. */
const accounted = new Set([...REQUIRED.map(([n]) => n), ...GUARD]);
const unaccounted = [...included].filter((name) => !accounted.has(name));
assert.deepEqual(unaccounted, [],
  `projection contains field names with no stated purpose: ${JSON.stringify(unaccounted)}`);

/* --------------- 3. A 4xx on the projection falls back WITHOUT fields */

requests.length = 0;
failNext = { status: 400 };
// retries:0 — otherwise getJSON's own retry would eat the injected 400 and
// the outer fallback path would never run.
const fallback = await MLB.getPlayByPlay(822688, { retries: 0 });
assert.equal(requests.length, 2, 'projected 400 → one unprojected retry');
assert.ok(requests[0].url.includes('fields='), 'first attempt uses the projection');
assert.ok(requests[1].url.endsWith('/playByPlay') && !requests[1].url.includes('fields='),
  'the fallback is the SAME lean endpoint without fields');
assert.equal(fallback.projected, false, 'the unprojected response is used');

/* --------- 4. A 404 on BOTH falls back to getLiveFeed (never silent) */

requests.length = 0;
failAll = { status: 400 };
const viaFeed = await MLB.getPlayByPlay(822688, { retries: 0 });
failAll = null;
assert.equal(requests.length, 3, 'projected 400 → plain 400 → feed/live');
assert.ok(requests[2].url.includes('/feed/live'), 'last resort is feed/live');
assert.deepEqual(viaFeed, {}, 'feed/live plays object returned');

/* ------------------- 5. Other endpoints keep their exact shapes */

requests.length = 0;
await MLB.getSchedule('2026-08-30');
assert.equal(requests.length, 1);
assert.ok(!requests[0].url.includes('fields='), 'getSchedule request is unchanged');

requests.length = 0;
await MLB.getChallengeCounts(822688);
assert.equal(requests.length, 1);
assert.ok(requests[0].url.includes('fields=gameData,review,absChallenges'),
  'getChallengeCounts keeps its tiny fields projection');

/* 6. Timeout/retry options pass through (the feed fails fast, next poll retries) */
requests.length = 0;
await MLB.getPlayByPlay(822688, { timeout: 3000, retries: 0 });
assert.ok(requests[0].init && requests[0].init.signal, 'AbortController signal wired');

console.log('API fields projection tests passed successfully!');
