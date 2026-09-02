#!/usr/bin/env node
/* ============================================================================
 * review-status-test.mjs — the "know a play is under review as fast as
 * possible" regression suite.
 *
 * It pins the change that fixed the latency complaint:
 *
 *   1. Review detection now reads the OFFICIAL game-status registry
 *      (GET https://statsapi.mlb.com/api/v1/gameStatus, verified live
 *      2026-09-02) instead of matching the English words "challenge"/"review"
 *      in `status.detailedState`. The word match silently missed the
 *      crew-chief state, whose verbatim detailedState is "Instant Replay"
 *      (statusCode IH) — so those reviews never raised an alert, never
 *      dropped the poll cadence, and never produced an "under review" row.
 *   2. The all-games Replay Feed watches that status on its own 250ms timer
 *      (MLB.getReviewStatus) instead of inheriting the 3s schedule cache,
 *      and kicks an out-of-band scan the instant a review flips.
 *
 * The four self-contained copies of the predicate (reviews-feed.js, game.js,
 * scoreboard.js, ui.js) exist because none of those files may assume
 * reviews.js has loaded. §3 walks the whole registry and asserts every copy
 * agrees with MLBReviews.isReviewGameStatus, so they cannot drift — the same
 * "deliberate duplicate + agreement test" pattern the repo already uses for
 * runsRemovableFromReview / runsRemovableByReview.
 *
 * Run:  node tools/review-status-test.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

/* ------------------------------------------------------------------ loaders */

function loadReviews() {
  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Math, Number, String, Object, Array, RegExp, JSON,
    MLB: { ordinal: (n) => `${n}` },
    UI: {
      el: (tag, cls, text) => ({ tag, cls, text, children: [], appendChild(c) { this.children.push(c); return c; } }),
      clear: (node) => { if (node) node.children = []; return node; },
    },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(file('../assets/js/reviews.js'), context, { filename: 'assets/js/reviews.js' });
  return context.MLBReviews || context.window.MLBReviews;
}

function loadReviewsFeed() {
  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Date, Math, Number, String, Object, Array, RegExp, JSON, URLSearchParams,
    CSS: { escape: (s) => s },
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
  vm.createContext(context);
  vm.runInContext(file('../assets/js/reviews-feed.js'), context,
    { filename: 'assets/js/reviews-feed.js' });
  return context.module.exports;
}

/** Extract one top-level `function name(...)` declaration with a balanced body. */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in the source`);
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    if (src[i] === '}') depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > start, `extracted a balanced ${name} body`);
  return src.slice(start, end);
}

/**
 * Compile an extracted function with a chosen `window`. MLBReviews is passed
 * as null so every copy below runs its SELF-CONTAINED fallback — that is the
 * code path a page hits when reviews.js has not (or cannot) load.
 */
// eslint-disable-next-line no-new-func
const compile = (fnSrc, win = {}) => new Function('window', `"use strict"; return (${fnSrc});`)(win);

const MLBReviews = loadReviews();
assert.ok(MLBReviews, 'MLBReviews loads');
const feed = loadReviewsFeed();
assert.ok(feed && typeof feed.reviewStatusFlips === 'function',
  'reviews-feed.js exports reviewStatusFlips');

const gameSrc = file('../assets/js/game.js');
const scoreboardSrc = file('../assets/js/scoreboard.js');
const uiSrc = file('../assets/js/ui.js');

/* ============================================================ 1. registry */

const REG = MLBReviews.REVIEW_STATUS_BY_CODE;
assert.ok(REG && typeof REG === 'object', 'REVIEW_STATUS_BY_CODE is exported');

const codes = Object.keys(REG);
// 1 IH + 23 M-family + 23 N-family = 47, read verbatim off GET /api/v1/gameStatus.
assert.equal(codes.length, 47, `registry holds all 47 review codes (got ${codes.length})`);
assert.equal(codes.filter((c) => REG[c].codedGameState === 'I').length, 1,
  'IH is the only codedGameState "I" review state');
assert.equal(codes.filter((c) => c.charAt(0) === 'M').length, 23, '23 M-family codes');
assert.equal(codes.filter((c) => c.charAt(0) === 'N').length, 23, '23 N-family codes');

codes.forEach((code) => {
  const e = REG[code];
  assert.ok(['I', 'M', 'N'].includes(e.codedGameState), `${code} has a registry codedGameState`);
  assert.ok(typeof e.detailedState === 'string' && e.detailedState.length > 0,
    `${code} has a verbatim detailedState`);
  assert.ok(e.reason === null || typeof e.reason === 'string',
    `${code} reason is a string or explicitly null (never invented)`);
  // Every M/N code's detailedState starts with its own family wording.
  if (code.charAt(0) === 'M') {
    assert.ok(/^Manager challenge|^Player challenge/.test(e.detailedState),
      `${code} detailedState is a manager/player challenge`);
  }
  if (code.charAt(0) === 'N') {
    assert.ok(/^Umpire review|^Umpire Challenge/.test(e.detailedState),
      `${code} detailedState is an umpire review`);
  }
  // The registry's `reason` is the detailedState's own suffix — never a
  // different topic.
  if (e.reason && e.detailedState.includes(': ')) {
    assert.equal(e.detailedState.slice(e.detailedState.indexOf(': ') + 2), e.reason,
      `${code} reason matches its detailedState suffix`);
  }
});

// Spot checks against the verbatim registry rows (these are the codes this
// repo had already observed live in real payloads). Compared as JSON because
// the registry object comes from a different VM realm, where deepStrictEqual
// rejects an identical shape over a different Object prototype.
const row = (code) => JSON.stringify(REG[code]);
const eq = (code, expected) => assert.equal(row(code), JSON.stringify(expected),
  `${code} matches the registry row verbatim`);
eq('MA', { codedGameState: 'M', detailedState: 'Manager challenge: Tag play', reason: 'Tag play' });
eq('MF', { codedGameState: 'M', detailedState: 'Manager challenge: Close play at 1st', reason: 'Close play at 1st' });
eq('MH', { codedGameState: 'M', detailedState: 'Manager challenge: Home run', reason: 'Home run' });
eq('MS', { codedGameState: 'M', detailedState: 'Manager challenge: Stadium boundary call', reason: 'Stadium boundary call' });
eq('MJ', { codedGameState: 'M', detailedState: 'Player challenge: Pitch Result', reason: 'Pitch Result' });
eq('NH', { codedGameState: 'N', detailedState: 'Umpire review: Home run', reason: 'Home run' });
eq('NJ', { codedGameState: 'N', detailedState: 'Umpire Challenge: Pitch Result', reason: 'Pitch Result' });
eq('NW', { codedGameState: 'N', detailedState: 'Umpire review: Def Shift Violation', reason: 'Def Shift Violation' });
eq('IH', { codedGameState: 'I', detailedState: 'Instant Replay', reason: 'Review' });
// MX / NX are the bare registry rows and carry no reason at all.
assert.equal(REG.MX.reason, null, 'MX has no registry reason');
assert.equal(REG.NX.reason, null, 'NX has no registry reason');
// The M and N families share one reason per suffix (the registry repeats the
// topic verbatim), except J (player vs umpire challenge) and the two
// single-family codes V (M only) / W (N only).
codes.filter((c) => c.charAt(0) === 'M' && !'JMV'.includes(c.charAt(1))).forEach((c) => {
  const twin = `N${c.charAt(1)}`;
  assert.ok(REG[twin], `${twin} exists for ${c}`);
  assert.equal(REG[twin].reason, REG[c].reason, `${c}/${twin} share the registry reason`);
});

/* ================================== 2. isReviewGameStatus over the registry */

// Every review state, exactly as the schedule/feed publishes it.
codes.forEach((code) => {
  const status = {
    abstractGameState: 'Live',
    codedGameState: REG[code].codedGameState,
    detailedState: REG[code].detailedState,
    statusCode: code,
  };
  if (REG[code].reason) status.reason = REG[code].reason;
  assert.equal(MLBReviews.isReviewGameStatus(status), true,
    `isReviewGameStatus true for ${code} (${REG[code].detailedState})`);
});

// Non-review states taken from the SAME registry (GET /api/v1/gameStatus).
// "I" in particular is plain "In Progress" — it must never match, or every
// live game would look like it is under review.
const NOT_REVIEW = [
  { abstractGameState: 'Preview', codedGameState: 'S', detailedState: 'Scheduled', statusCode: 'S' },
  { abstractGameState: 'Preview', codedGameState: 'P', detailedState: 'Pre-Game', statusCode: 'P' },
  { abstractGameState: 'Live', codedGameState: 'P', detailedState: 'Warmup', statusCode: 'PW' },
  { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
  { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed', statusCode: 'IO' },
  // Verified live 2026-09-02, game 822686: a real rain delay.
  { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed', statusCode: 'II', reason: 'Inclement Weather' },
  { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Delayed: Rain', statusCode: 'IR', reason: 'Rain' },
  { abstractGameState: 'Live', codedGameState: 'T', detailedState: 'Suspended', statusCode: 'T' },
  { abstractGameState: 'Live', codedGameState: 'U', detailedState: 'Suspended: Rain', statusCode: 'UR', reason: 'Rain' },
  { abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' },
  { abstractGameState: 'Final', codedGameState: 'O', detailedState: 'Game Over', statusCode: 'O' },
  { abstractGameState: 'Final', codedGameState: 'D', detailedState: 'Postponed: Rain', statusCode: 'DR', reason: 'Rain' },
  { abstractGameState: 'Final', codedGameState: 'C', detailedState: 'Cancelled', statusCode: 'CO' },
  { abstractGameState: 'Final', codedGameState: 'Q', detailedState: 'Forfeit', statusCode: 'Q' },
  { abstractGameState: 'Other', codedGameState: 'X', detailedState: 'Unknown', statusCode: 'X' },
  { abstractGameState: 'Other', codedGameState: 'W', detailedState: 'Writing', statusCode: 'W' },
];
NOT_REVIEW.forEach((status) => {
  assert.equal(MLBReviews.isReviewGameStatus(status), false,
    `isReviewGameStatus false for ${status.statusCode} (${status.detailedState})`);
});

// Malformed input never throws and never reports a review.
[null, undefined, {}, 0, '', 'Manager Challenge', { statusCode: 42 }, { codedGameState: null }]
  .forEach((bad) => {
    assert.equal(MLBReviews.isReviewGameStatus(bad), false,
      `malformed status ${JSON.stringify(bad)} is not a review`);
  });

/* ==================== 3. every self-contained copy agrees, over everything */

// Each copy is adapted to take a bare `status` object: scoreboard.js wraps
// its argument in a schedule game, the others read the status directly.
const copies = {
  'reviews-feed.js isReviewStatusCode': (st) => feed.isReviewStatusCode(st),
  'game.js statusSaysReview': (st) => compile(extractFunction(gameSrc, 'statusSaysReview'))(st),
  'scoreboard.js gameIsUnderReview': (st) =>
    compile(extractFunction(scoreboardSrc, 'gameIsUnderReview'))({ status: st }),
};
Object.entries(copies).forEach(([label, fn]) => {
  assert.equal(typeof fn, 'function', `${label} was extracted`);
  codes.forEach((code) => {
    const status = {
      abstractGameState: 'Live',
      codedGameState: REG[code].codedGameState,
      detailedState: REG[code].detailedState,
      statusCode: code,
    };
    assert.equal(fn(status), true, `${label} true for ${code}`);
    // A payload that carries only detailedState (no codes) must still match.
    assert.equal(fn({ detailedState: REG[code].detailedState }), true,
      `${label} true for detailedState-only "${REG[code].detailedState}"`);
  });
  NOT_REVIEW.forEach((status) => {
    assert.equal(fn(status), false,
      `${label} false for ${status.statusCode} (${status.detailedState})`);
    assert.equal(fn({ detailedState: status.detailedState }), false,
      `${label} false for detailedState-only "${status.detailedState}"`);
  });
  [null, undefined, {}, 'In Progress'].forEach((bad) => {
    assert.equal(fn(bad), false, `${label} survives malformed input ${JSON.stringify(bad)}`);
  });
});

// ui.js keeps its fallback inline inside statusChip(), so drive the real
// statusChip with a stub DOM and no MLBReviews loaded.
{
  const context = {
    window: {},
    document: {
      createElement: (tag) => ({
        tag, className: '', textContent: '', children: [], attrs: {},
        appendChild(c) { this.children.push(c); return c; },
        prepend(c) { this.children.unshift(c); return c; },
        setAttribute(k, v) { this.attrs[k] = v; },
      }),
    },
  };
  vm.createContext(context);
  // A top-level `const` in a vm Script lands in the global LEXICAL scope, not
  // on the context object, so publish it explicitly.
  vm.runInContext(`${uiSrc}\n;globalThis.__UI = UI;`, context, { filename: 'assets/js/ui.js' });
  const UI = context.__UI;
  assert.ok(UI && typeof UI.statusChip === 'function', 'ui.js statusChip loads');
  codes.forEach((code) => {
    const chip = UI.statusChip({
      abstractGameState: 'Live',
      codedGameState: REG[code].codedGameState,
      detailedState: REG[code].detailedState,
      statusCode: code,
    });
    assert.ok(chip.className.includes('chip-review'),
      `ui.js renders ${code} (${REG[code].detailedState}) with the review chip`);
    assert.ok(chip.children.some((c) => c.className === 'chip-dot'),
      `ui.js pulses the ${code} chip`);
  });
  NOT_REVIEW.forEach((status) => {
    const chip = UI.statusChip(status);
    assert.ok(!chip.className.includes('chip-review'),
      `ui.js does not render ${status.statusCode} (${status.detailedState}) as a review`);
  });
}

/* ================================================= 4. normalizeType codes */

assert.equal(MLBReviews.normalizeType('MJ', 'Ball').key, 'abs');
assert.equal(MLBReviews.normalizeType('NJ', '').key, 'abs',
  'NJ (umpire pitch challenge) is ABS, not a generic Replay Review');
assert.equal(MLBReviews.normalizeType('NJ', '').label, 'ABS Challenge');
assert.equal(MLBReviews.normalizeType('NH', 'Foul').key, 'boundary');
assert.equal(MLBReviews.normalizeType('MA', '').key, 'manager');
assert.equal(MLBReviews.normalizeType('MF', '').key, 'manager');
assert.equal(MLBReviews.normalizeType('MH', '').key, 'manager');
assert.equal(MLBReviews.normalizeType('NA', '').key, 'crew_chief');
assert.equal(MLBReviews.normalizeType('NF', '').key, 'crew_chief');
assert.equal(MLBReviews.normalizeType('NX', '').label, 'Umpire Review');
assert.equal(MLBReviews.normalizeType('IH', '').label, 'Instant Replay');
assert.equal(MLBReviews.normalizeType('ZZ', 'Something happened').label, 'Replay Review',
  'a code outside the registry is still labelled honestly');
// The description-text path is untouched.
assert.equal(MLBReviews.normalizeType('Manager Challenge', '').key, 'manager');
assert.equal(MLBReviews.normalizeType('Umpire Review', '').key, 'crew_chief');

/* ================================================= 5. reviewStatusInfo */

assert.equal(MLBReviews.reviewStatusInfo({ statusCode: 'I', codedGameState: 'I', detailedState: 'In Progress' }), null);
{
  const info = MLBReviews.reviewStatusInfo({
    abstractGameState: 'Live', codedGameState: 'M',
    detailedState: 'Manager challenge: Tag play', statusCode: 'MA', reason: 'Tag play',
  });
  assert.equal(info.statusCode, 'MA');
  assert.equal(info.reason, 'Tag play', 'official registry reason is carried through');
  assert.equal(info.typeKey, 'manager');
  assert.equal(info.typeLabel, 'Manager Challenge');
}
{
  // Status with a code but no reason on the payload: the registry supplies it.
  const info = MLBReviews.reviewStatusInfo({ statusCode: 'MH', detailedState: 'Manager challenge: Home run' });
  assert.equal(info.reason, 'Home run');
  assert.equal(info.typeKey, 'manager');
}
{
  // A payload with detailedState only (no codes at all).
  const info = MLBReviews.reviewStatusInfo({ detailedState: 'Instant Replay' });
  assert.ok(info, 'detailedState-only "Instant Replay" is recognised');
  assert.equal(info.typeKey, 'review');
  assert.equal(info.reason, null, 'no reason is invented when the payload has none');
}
{
  // MX / NX carry no registry reason and the payload has none either.
  const info = MLBReviews.reviewStatusInfo({ statusCode: 'MX', detailedState: 'Manager challenge' });
  assert.equal(info.reason, null, 'a bare "Manager challenge" has no reason to show');
}

/* ============== 6. extractReviews surfaces a review from status alone ======
 * This is the user-visible bug: a game whose ONLY review signal is the
 * official status must still produce an in-progress row immediately. */

function feedWithStatus(status, currentPlay) {
  return {
    gameData: {
      status,
      teams: {
        away: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
        home: { id: 111, name: 'Boston Red Sox', abbreviation: 'BOS' },
      },
    },
    liveData: {
      linescore: { teams: { away: { runs: 6 }, home: { runs: 5 } } },
      plays: { allPlays: [], currentPlay: currentPlay || null },
    },
  };
}

const baseCurrentPlay = {
  about: { atBatIndex: 51, inning: 8, halfInning: 'top', isComplete: false },
  result: { event: 'Single', eventType: 'single', awayScore: 6, homeScore: 5, description: 'Anthony Volpe is safe at home.' },
  matchup: { batter: { id: 592450, fullName: 'Aaron Judge' }, pitcher: { id: 656302, fullName: 'Brayan Bello' } },
  playEvents: [{ index: 5, isPitch: true, details: { description: 'In play, run(s)' } }],
  runners: [{
    movement: { start: '3B', end: 'score', outBase: null, isOut: false },
    details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 5, runner: { id: 660670, fullName: 'Anthony Volpe' } },
  }],
};

const REVIEW_STATUSES = [
  ['MA', { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA', reason: 'Tag play' }, 'manager', 'Tag play'],
  ['IH', { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Instant Replay', statusCode: 'IH', reason: 'Review' }, 'review', 'Review'],
  ['NA', { abstractGameState: 'Live', codedGameState: 'N', detailedState: 'Umpire review: Tag play', statusCode: 'NA', reason: 'Tag play' }, 'crew_chief', 'Tag play'],
  ['NH', { abstractGameState: 'Live', codedGameState: 'N', detailedState: 'Umpire review: Home run', statusCode: 'NH', reason: 'Home run' }, 'boundary', 'Home run'],
  ['MJ', { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Player challenge: Pitch Result', statusCode: 'MJ', reason: 'Pitch Result' }, 'abs', 'Pitch Result'],
];

REVIEW_STATUSES.forEach(([code, status, expectedKey, expectedReason]) => {
  const extracted = MLBReviews.extractReviews(feedWithStatus(status, baseCurrentPlay));
  assert.ok(extracted.activeReview, `${code}: an active review row exists from status alone`);
  assert.equal(extracted.activeReview.inProgress, true, `${code}: row is in progress`);
  assert.equal(extracted.activeReview.typeKey, expectedKey, `${code}: typeKey`);
  assert.equal(extracted.activeReview.reason, expectedReason,
    `${code}: the official registry reason is on the row immediately`);
  assert.equal(extracted.activeReview.statusCode, code, `${code}: provenance statusCode`);
  assert.equal(extracted.activeReview.officialStatus, status.detailedState,
    `${code}: provenance detailedState`);
});

// The run-at-risk model still works off the status-only row: the reviewed
// play credited a run, so an overturn could remove it.
{
  const extracted = MLBReviews.extractReviews(
    feedWithStatus(REVIEW_STATUSES[0][1], baseCurrentPlay));
  assert.equal(MLBReviews.runsRemovableByReview(extracted.activeReview), 1,
    'a status-only manager challenge over a scoring play reports 1 run at risk');
}

// The challenging team is taken from the official challengeTeamId when the
// feed already exposes it, and is left null otherwise — never guessed.
{
  const withTeam = JSON.parse(JSON.stringify(baseCurrentPlay));
  withTeam.reviewDetails = { inProgress: true, reviewType: 'MA', challengeTeamId: 147 };
  const extracted = MLBReviews.extractReviews(
    feedWithStatus(REVIEW_STATUSES[0][1], withTeam));
  assert.equal(extracted.activeReview.teamAbbrev, 'NYY', 'challengeTeamId resolves to the official club');
  const noTeam = MLBReviews.extractReviews(
    feedWithStatus(REVIEW_STATUSES[0][1], baseCurrentPlay));
  assert.equal(noTeam.activeReview.teamAbbrev, null, 'no challenging team is invented');
}

// A non-review status still produces no synthesized row.
{
  const extracted = MLBReviews.extractReviews(feedWithStatus(
    { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
    baseCurrentPlay));
  assert.equal(extracted.activeReview, null, 'In Progress is not a review');
}

/* ============================================ 7. inspectScheduleGame (IH) */

assert.equal(
  MLBReviews.inspectScheduleGame({
    status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Instant Replay', statusCode: 'IH' },
  }).hasActiveReview, true,
  'a crew-chief "Instant Replay" game is reported as under review');
assert.equal(
  MLBReviews.inspectScheduleGame({
    status: { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA' },
  }).typeLabel, 'Manager Challenge');
assert.equal(
  MLBReviews.inspectScheduleGame({
    status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' },
  }).hasActiveReview, false);
// The pre-existing text-only shape must keep working.
assert.equal(
  MLBReviews.inspectScheduleGame({ status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' } })
    .hasActiveReview, true);

/* ================================================ 8. reviewStatusFlips */

const sweep = (rows) => rows.map(([gamePk, statusCode, detailedState, codedGameState]) => ({
  gamePk,
  status: { abstractGameState: 'Live', statusCode, detailedState, codedGameState,
    ...(statusCode === 'MA' ? { reason: 'Tag play' } : {}) },
}));

{
  // First sweep: a game already under review is a reportable event.
  const first = feed.reviewStatusFlips(new Map(), sweep([
    [1, 'I', 'In Progress', 'I'],
    [2, 'MA', 'Manager challenge: Tag play', 'M'],
  ]));
  assert.equal(first.changed.length, 1,
    'the first sweep reports only the game that is under review, not every game it sees');
  assert.equal(first.codes.size, 2, 'both games are tracked for the next diff');
  const started = first.changed.filter((c) => c.started).map((c) => c.gamePk);
  assert.equal(started.join(','), '2', 'only the review game is a "started" event');
  const two = first.changed.find((c) => c.gamePk === 2);
  assert.equal(two.reason, 'Tag play', 'the flip carries the official reason');

  // Nothing moved.
  const same = feed.reviewStatusFlips(first.codes, sweep([
    [1, 'I', 'In Progress', 'I'],
    [2, 'MA', 'Manager challenge: Tag play', 'M'],
  ]));
  assert.equal(same.changed.length, 0, 'an unchanged sweep reports nothing');

  // A different challenge on the same game is a new event, not a repeat.
  const next = feed.reviewStatusFlips(first.codes, sweep([
    [1, 'I', 'In Progress', 'I'],
    [2, 'MF', 'Manager challenge: Close play at 1st', 'M'],
  ]));
  assert.equal(next.changed.length, 1);
  assert.equal(next.changed[0].gamePk, 2);
  assert.equal(next.changed[0].started, false, 'a code change is not a fresh start');
  assert.equal(next.changed[0].ended, false);

  // The ruling lands.
  const done = feed.reviewStatusFlips(next.codes, sweep([
    [1, 'I', 'In Progress', 'I'],
    [2, 'I', 'In Progress', 'I'],
  ]));
  assert.equal(done.changed.length, 1);
  assert.equal(done.changed[0].ended, true, 'the resolution is reported as an end');

  // A crew-chief review is caught — the bug this suite exists for.
  const crew = feed.reviewStatusFlips(done.codes, sweep([
    [1, 'IH', 'Instant Replay', 'I'],
    [2, 'I', 'In Progress', 'I'],
  ]));
  assert.equal(crew.changed.length, 1);
  assert.equal(crew.changed[0].gamePk, 1);
  assert.equal(crew.changed[0].started, true, 'IH flips the watcher');

  // A rain delay is not a review.
  const delay = feed.reviewStatusFlips(crew.codes, sweep([
    [1, 'II', 'Delayed', 'I'],
    [2, 'I', 'In Progress', 'I'],
  ]));
  const delayFlip = delay.changed.find((c) => c.gamePk === 1);
  assert.ok(delayFlip, 'leaving the review state is reported');
  assert.equal(delayFlip.ended, true);
  assert.equal(delayFlip.review, false);
}

// Malformed sweeps never throw.
assert.equal(feed.reviewStatusFlips(null, null).changed.length, 0,
  'a null sweep never throws and reports nothing');
{
  const malformed = feed.reviewStatusFlips(undefined, [null, {}, { gamePk: 1 }]);
  assert.equal(malformed.changed.length, 0,
    'a row with no status is not a review event (it is only tracked)');
  assert.equal(malformed.codes.size, 1, 'the one usable row is still tracked for the next diff');
}

/* ================================================ 9. reviewFetchPriority */

assert.equal(
  feed.reviewFetchPriority({ gamePk: 1, status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'Instant Replay', statusCode: 'IH' } }, false),
  0, 'a crew-chief review game is fetched first');
assert.equal(
  feed.reviewFetchPriority({ gamePk: 1, status: { abstractGameState: 'Live', codedGameState: 'M', detailedState: 'Manager challenge: Tag play', statusCode: 'MA' } }, false),
  0);
assert.equal(
  feed.reviewFetchPriority({ gamePk: 1, status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' } }, false),
  1, 'an ordinary live game is second');
assert.equal(
  feed.reviewFetchPriority({ gamePk: 1, status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I' } }, true),
  0, 'a game with an in-progress feed entry is still first');
assert.equal(
  feed.reviewFetchPriority({ gamePk: 1, status: { abstractGameState: 'Final', detailedState: 'Final', statusCode: 'F' } }, false),
  2);

/* ======================================= 10. the bug, stated as a test =====
 * The old detector was /challenge|review/i on detailedState. Pin that it
 * really did miss "Instant Replay" — if someone "simplifies" back to a word
 * match, this assertion is what fails. */

assert.equal(/challenge|review/i.test('Instant Replay'), false,
  'the old word match does not see "Instant Replay"');
assert.equal(MLBReviews.isReviewGameStatus({ detailedState: 'Instant Replay' }), true,
  'the registry-based detector does');
assert.equal(feed.isReviewStatusCode({ detailedState: 'Instant Replay' }), true);

/* ====================================== 11. the lean status endpoints =====
 * Structural pin on the two URLs the watcher/probe use: they must ask for
 * statusCode + codedGameState + reason, or the earliest signal is lost. */

{
  const api = file('../assets/js/api.js');
  assert.ok(/REVIEW_STATUS_FIELDS\s*=\s*\[/.test(api), 'api.js declares REVIEW_STATUS_FIELDS');
  const block = api.slice(api.indexOf('REVIEW_STATUS_FIELDS = ['), api.indexOf('];', api.indexOf('REVIEW_STATUS_FIELDS = [')));
  ['gamePk', 'status', 'statusCode', 'codedGameState', 'detailedState', 'reason']
    .forEach((f) => assert.ok(block.includes(`'${f}'`), `REVIEW_STATUS_FIELDS whitelists ${f}`));
  assert.ok(/GAME_STATUS_FIELDS\s*=/.test(api), 'api.js declares GAME_STATUS_FIELDS');
  const gsBlock = api.slice(api.indexOf('GAME_STATUS_FIELDS ='), api.indexOf(';', api.indexOf('GAME_STATUS_FIELDS =')));
  ['statusCode', 'codedGameState', 'detailedState', 'reason']
    .forEach((f) => assert.ok(gsBlock.includes(f), `GAME_STATUS_FIELDS whitelists ${f}`));
  assert.ok(/async function getReviewStatus/.test(api), 'api.js exposes getReviewStatus');
  assert.ok(/async function getGameStatus/.test(api), 'api.js exposes getGameStatus');
  assert.ok(/getReviewStatus, getGameStatus/.test(api) || /getReviewStatus,\s*getGameStatus/.test(api),
    'both are on the MLB namespace');
  // The watcher cadence is the whole point: it must stay faster than the
  // 3s schedule cache it replaced.
  const rf = file('../assets/js/reviews-feed.js');
  const watcherMs = Number(/REVIEW_STATUS_POLL_MS\s*=\s*(\d+)/.exec(rf)[1]);
  const scheduleTtl = Number(/SCHEDULE_TTL_MS\s*=\s*(\d+)/.exec(rf)[1]);
  assert.ok(watcherMs > 0 && watcherMs < scheduleTtl,
    `review-status watcher (${watcherMs}ms) is faster than the schedule cache (${scheduleTtl}ms)`);
}

console.log('Review-status latency tests passed successfully!');
