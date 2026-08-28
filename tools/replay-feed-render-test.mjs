#!/usr/bin/env node
/* ============================================================================
 * replay-feed-render-test.mjs — end-to-end render test for the all-games
 * Replay Feed (reviews.html), no network required.
 *
 * Loads the REAL page modules (assets/js/reviews-feed.js + reviews.js) into a
 * VM with a recording DOM stub and drives the actual boot path
 * (DOMContentLoaded -> load() -> getSchedule/getTeams/getPlayByPlay ->
 * ingestGame -> render*). The captured fixture portions below are VERBATIM
 * from statsapi.mlb.com on 2026-08-19 (see docs/verification-report.md):
 *
 *   - schedule entry for gamePk 823342 (Detroit Tigers @ Pittsburgh Pirates),
 *     whose team objects carry ONLY { id, name, link } — no `abbreviation`
 *     (this is the shape that used to render "undefined @ undefined");
 *   - the ABS pitch challenge (reviewType "MJ") at atBatIndex 15 of that
 *     game's playByPlay;
 *   - official /api/v1/teams directory entries for clubs 116 and 134.
 * A clearly marked deterministic active home-plate-review fixture is appended
 * to test the transient Before / Possible / Actual score tracker; no claim is
 * made that the synthetic review itself was captured live.
 *
 * Asserts: captured team/review fields remain official — the string
 * "undefined" can never appear — and the marked deterministic Replay Feed row
 * renders all three score states without inventing Actual.
 *
 * Run: node tools/replay-feed-render-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ------------------------------------------------------ recording DOM stub */

function makeNode(tag) {
  const node = {
    tag,
    cls: '',
    text: '',               // set via textContent
    attrs: {},
    children: [],
    dataset: {},
    title: null,
    hidden: false,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    appendChild(child) { this.children.push(child); return child; },
    prepend(child) { this.children.unshift(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    remove() {},
    addEventListener() {},
    get firstChild() { return this.children[0] || null; },
    querySelector(sel) { return findIn(node, sel); },
  };
  return node;
}

/** Minimal selectors used by the page: '.empty' and '.feed-row[data-key="…"]'. */
function matches(node, sel) {
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
    if (matches(c, sel)) return c;
    const deeper = findIn(c, sel);
    if (deeper) return deeper;
  }
  return null;
}

const registry = {};
const ids = ['#status-line', '#feed-stats', '#active-strip', '#feed-tabs',
  '#feed-list', '#date-picker', '#date-label', '#live-dot', '#banner', '#date-nav',
  '#countdown', '#refresh-btn'];
ids.forEach((id) => { registry[id] = makeNode('div'); });

let domReadyCb = null;
let visibilityCb = null;
const documentStub = {
  hidden: false,
  createElement: (tag) => makeNode(tag),
  querySelector: (sel) => registry[sel] || null,
  addEventListener: (ev, cb) => {
    if (ev === 'DOMContentLoaded') domReadyCb = cb;
    if (ev === 'visibilitychange') visibilityCb = cb;
  },
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

/* ---------------- captured API fixtures + marked deterministic tracker records */

// GET /api/v1/schedule?sportId=1&date=2026-08-19&hydrate=… — game 823342 entry,
// captured verbatim. NOTE: teams.*.team has NO `abbreviation` field.
const SCHEDULE_GAMES = [{
  gamePk: 823342,
  gameGuid: '2eb3fe1e-b2ab-445d-861a-fd8bd0dfea9d',
  link: '/api/v1.1/game/823342/feed/live',
  gameType: 'R',
  season: '2026',
  gameDate: '2026-08-19T16:35:00Z',
  officialDate: '2026-08-19',
  status: { abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress', statusCode: 'I', startTimeTBD: false, abstractGameCode: 'L' },
  teams: {
    away: { team: { id: 116, name: 'Detroit Tigers', link: '/api/v1/teams/116' }, leagueRecord: { wins: 61, losses: 65, ties: 0, pct: '.484' }, score: 3, splitSquad: false, seriesNumber: 41 },
    home: { team: { id: 134, name: 'Pittsburgh Pirates', link: '/api/v1/teams/134' }, leagueRecord: { wins: 62, losses: 66, ties: 0, pct: '.484' }, score: 1, splitSquad: false, seriesNumber: 41 },
  },
  linescore: {
    currentInning: 6, currentInningOrdinal: '6th', inningState: 'Bottom', inningHalf: 'Bottom', isTopInning: false, scheduledInnings: 9,
    innings: [
      { num: 1, ordinalNum: '1st', home: { runs: 1, hits: 2, errors: 0, leftOnBase: 2 }, away: { runs: 0, hits: 0, errors: 0, leftOnBase: 2 } },
      { num: 2, ordinalNum: '2nd', home: { runs: 0, hits: 0, errors: 0, leftOnBase: 1 }, away: { runs: 0, hits: 0, errors: 0, leftOnBase: 0 } },
      { num: 3, ordinalNum: '3rd', home: { runs: 0, hits: 0, errors: 0, leftOnBase: 0 }, away: { runs: 1, hits: 2, errors: 0, leftOnBase: 1 } },
      { num: 4, ordinalNum: '4th', home: { runs: 0, hits: 2, errors: 0, leftOnBase: 1 }, away: { runs: 0, hits: 0, errors: 0, leftOnBase: 0 } },
      { num: 5, ordinalNum: '5th', home: { runs: 0, hits: 0, errors: 0, leftOnBase: 1 }, away: { runs: 2, hits: 3, errors: 0, leftOnBase: 1 } },
      { num: 6, ordinalNum: '6th', home: { hits: 0, errors: 0, leftOnBase: 0 }, away: { runs: 0, hits: 0, errors: 0, leftOnBase: 0 } },
    ],
    teams: { home: { runs: 1, hits: 4, errors: 0, leftOnBase: 5 }, away: { runs: 3, hits: 5, errors: 0, leftOnBase: 4 } },
  },
  venue: { id: 31, name: 'PNC Park', link: '/api/v1/venues/31' },
  review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
}];

// GET /api/v1/game/823342/playByPlay — the ABS pitch-challenge at-bat captured
// live at atBatIndex 15 (reviewDetails.reviewType "MJ", challengeTeamId 116).
// The atBatIndex 16 and 17/currentPlay records are deterministic tracker data,
// separate from the verbatim capture: 2-1 before the play, 3-1 after a safe-at-
// home call, with one scoring movement tied to the reviewed event.
const PBP = {
  allPlays: [
    {
      about: { atBatIndex: 15, startTime: '2026-08-19T17:05:00Z', endTime: '2026-08-19T17:07:00Z', inning: 2, halfInning: 'bottom', isComplete: true, hasReview: false },
      result: { description: 'Jared Triolo grounds out, third baseman Hao-Yu Lee to first baseman Spencer Torkelson.', event: 'Groundout' },
      matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
      playEvents: [
        { isPitch: true, startTime: '2026-08-19T17:06:00Z', details: { description: 'Ball', hasReview: true }, reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 116 } },
      ],
    },
    {
      about: { atBatIndex: 16, inning: 6, halfInning: 'top', isComplete: true },
      result: { description: 'Previous play.', awayScore: 2, homeScore: 1 },
      runners: [], playEvents: [],
    },
  ],
  currentPlay: {
    about: { atBatIndex: 17, startTime: '2026-08-19T18:30:00Z', inning: 6, halfInning: 'top', isComplete: false },
    result: {
      event: 'Single', eventType: 'single', awayScore: 3, homeScore: 1,
      description: 'Runner is safe at home. Play under review.',
    },
    matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
    reviewDetails: { inProgress: true, reviewType: 'MA', challengeTeamId: 134 },
    runners: [{
      movement: { start: '3B', end: 'score', isOut: false },
      details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 2, runner: { id: 1, fullName: 'Test Runner' } },
    }],
    playEvents: [{ index: 2, isPitch: true, details: { description: 'In play, run(s)' } }],
  },
};

// GET /api/v1/teams?sportId=1&season=2026 — the two entries this game needs,
// verbatim (id / official full name / official abbreviation).
const TEAMS_DIR = {
  116: { id: 116, name: 'Detroit Tigers', teamName: 'Tigers', locationName: 'Detroit', abbreviation: 'DET' },
  134: { id: 134, name: 'Pittsburgh Pirates', teamName: 'Pirates', locationName: 'Pittsburgh', abbreviation: 'PIT' },
};

// GET /api/v1.1/game/823342/feed/live?fields=gameData,review,absChallenges,…
// — the game's official challenge counters, captured verbatim on 2026-08-19
// (see docs/verification-report.md §1–2): the manager `review` object and the
// ABS tracker after DET's one failed ABS challenge.
const CHALLENGE_COUNTS = {
  gameData: {
    review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
    absChallenges: {
      hasChallenges: true,
      away: { usedSuccessful: 0, usedFailed: 1, remaining: 1 },
      home: { usedSuccessful: 0, usedFailed: 0, remaining: 2 },
    },
  },
};

const MLBStub = {
  getSchedule: async () => SCHEDULE_GAMES,
  getTeams: async () => TEAMS_DIR,
  getPlayByPlay: async () => PBP,
  getChallengeCounts: async () => CHALLENGE_COUNTS,
  // Mirrors MLB.ordinal in assets/js/api.js exactly.
  ordinal: (n) => {
    const ORD = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];
    const n10 = n % 100;
    const suffix = (n10 >= 11 && n10 <= 13) ? 'th' : ORD[n % 10] || 'th';
    return `${n}${suffix}`;
  },
};

/* --------------------------------------------------------------- run page */

const feedSrc = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
const reviewsSrc = readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8');

const context = {
  console: { warn: console.warn.bind(console), error: console.error.bind(console), log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams,
  CSS: { escape: (s) => s },
  UI: UIStub,
  MLB: MLBStub,
  window: { location: { search: '' }, history: { replaceState() {} } },
  document: documentStub,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  module: { exports: {} },
};
vm.createContext(context);
vm.runInContext(reviewsSrc, context, { filename: 'assets/js/reviews.js' });
vm.runInContext(feedSrc, context, { filename: 'assets/js/reviews-feed.js' });

assert.equal(typeof domReadyCb, 'function', 'page registers DOMContentLoaded boot');
domReadyCb();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------- assertions */

/** Collect every rendered string (texts + attribute values) under a node. */
function collectStrings(node, out) {
  if (node.text) out.push(node.text);
  if (node.textContent) out.push(node.textContent);
  if (typeof node.value === 'string' && node.value) out.push(node.value);
  Object.values(node.attrs || {}).forEach((v) => out.push(v));
  if (node.title) out.push(node.title);
  (node.children || []).forEach((c) => collectStrings(c, out));
  return out;
}

// 1. The feed rendered the captured ABS review plus the deterministic active
// score-impact review.
const feedList = registry['#feed-list'];
const rows = feedList.children.filter((c) => c.cls.includes('feed-row'));
assert.equal(rows.length, 2, `expected 2 feed rows, got ${rows.length}`);
const rowRecords = rows.map((row) => {
  const strings = [];
  collectStrings(row, strings);
  return { row, blob: strings.join(' | ') };
});
const absRecord = rowRecords.find((record) => record.blob.includes('ABS Challenge'));
const impactRecord = rowRecords.find((record) => record.blob.includes('1 RUN AT RISK'));
assert.ok(absRecord, 'captured ABS row rendered');
assert.ok(impactRecord, 'active score-impact row rendered');
const rowBlob = absRecord.blob;

// 2. Official team names are shown — never "undefined", never a guess.
assert.ok(rowBlob.includes('Detroit Tigers @ Pittsburgh Pirates'),
  `feed row must show the official matchup names, got: ${rowBlob}`);
assert.ok(!rowBlob.includes('undefined'),
  `feed row leaked "undefined": ${rowBlob}`);

// 3. Challenging-team chip = official abbreviation, official full name on hover.
const teamChip = findIn(absRecord.row, '.feed-team');
assert.ok(teamChip, 'challenge team chip rendered');
assert.equal(teamChip.text, 'DET');
assert.equal(teamChip.title, 'Detroit Tigers');

// 4. Event content from the real MJ payload.
assert.ok(rowBlob.includes('ABS Challenge'), 'type chip');
assert.ok(rowBlob.includes('Call Stands'), `outcome pill (isOverturned:false), got: ${rowBlob}`);
assert.ok(rowBlob.includes('Batter: Bryan Reynolds'), 'batter footer');
assert.ok(rowBlob.includes('Pitcher: Jackson Jobe'), 'pitcher footer');
// First pitch of the PA, no event.count in the captured payload: show 0-0
// before and the fielding-side role (DET challenged in the bottom). Do not
// invent an after-count.
assert.ok(rowBlob.includes('Count before challenge: 0-0'), `ABS before-count, got: ${rowBlob}`);
assert.ok(rowBlob.includes('Catcher or pitcher challenged'), `ABS challenger role, got: ${rowBlob}`);
assert.ok(!/After call/.test(rowBlob), `no invented after-count when event.count is missing: ${rowBlob}`);
assert.ok(rowBlob.includes('▼ Bot 2nd'), `inning label from the play's about, got: ${rowBlob}`);
const scoreChip = findIn(absRecord.row, '.feed-game-score');
assert.ok(scoreChip && scoreChip.text === '3–1',
  `score chip from the schedule linescore, got: ${scoreChip && scoreChip.text}`);

// 4a-ter. Challenges-remaining tracker on the ABS row: the challenging team's
// current official ABS counter (DET challenged; absChallenges.away shows
// 1 remaining after the failed challenge), plus the both-teams summary as the
// hover title. Numbers come only from the captured payloads.
const challengesLine = findIn(absRecord.row, '.feed-challenges-line');
assert.ok(challengesLine, 'ABS row renders the challenges-remaining line');
assert.equal(challengesLine.text, 'DET: 1 ABS challenge left now (0 successful · 1 failed)');
const challengesMeta = findIn(absRecord.row, '.feed-challenges');
assert.equal(challengesMeta.title, 'Challenges left now: DET 1 MGR · 1 ABS — PIT 1 MGR · 2 ABS');
assert.equal(findIn(absRecord.row, '.feed-challenges-flag'), null,
  'no irregularity flag when counters never regress');
// The deterministic manager-challenge row shows PIT's manager counter.
const impactChallenges = findIn(impactRecord.row, '.feed-challenges-line');
assert.ok(impactChallenges, 'manager row renders the challenges-remaining line');
assert.equal(impactChallenges.text, 'PIT: 1 manager challenge left now (0 used)');
// The active strip carries the whole-game summary for the game under review.
const activeChallenges = findIn(registry['#active-strip'], '.feed-active-challenges');
assert.ok(activeChallenges, 'active strip renders the challenges-left summary');
assert.equal(activeChallenges.text, 'Challenges left: DET 1 MGR · 1 ABS — PIT 1 MGR · 2 ABS');

// 4b. The real feed-row path renders the three distinct score snapshots.
assert.match(impactRecord.blob, /Before review \| DET 3 – PIT 1/);
assert.match(impactRecord.blob, /Possible after \| Call stands: DET 3 – PIT 1/);
assert.match(impactRecord.blob, /safe-at-home call becomes an out: DET 2 – PIT 1/);
assert.match(impactRecord.blob, /Actual after \| Pending — review in progress/);
const activeStripStrings = [];
collectStrings(registry['#active-strip'], activeStripStrings);
assert.ok(activeStripStrings.includes('1 RUN AT RISK'),
  `active strip includes score risk, got: ${JSON.stringify(activeStripStrings)}`);

/* 4d. RUN-AT-RISK surfaces. The deterministic active review credits exactly
 * one scoring movement (playIndex 2) to the reviewed event, so a run already
 * on the scoreboard could come off — this is the state the user asked to be
 * alerted about, and it must be visible everywhere at once. */

// The feed row is flagged and badged.
assert.ok(impactRecord.row.cls.includes('feed-row-run-risk'),
  `at-risk feed row carries the urgent class, got: ${impactRecord.row.cls}`);
const riskBadge = findIn(impactRecord.row, '.feed-run-risk-badge');
assert.ok(riskBadge, 'at-risk feed row renders a run-at-risk badge');
assert.equal(riskBadge.text, '⚠️ 1 RUN AT RISK');
// The ABS row credits no run, so it must NOT be flagged.
assert.ok(!absRecord.row.cls.includes('feed-row-run-risk'),
  'a row with no credited run is never flagged as at-risk');
assert.equal(findIn(absRecord.row, '.feed-run-risk-badge'), null);

// The persistent banner sits above the active strip with the observed scores.
const banner = findIn(registry['#active-strip'], '.run-risk-banner');
assert.ok(banner, 'run-at-risk banner renders above the feed');
const bannerBlob = collectStrings(banner, []).join(' | ');
assert.match(bannerBlob, /1 RUN AT RISK/);
assert.match(bannerBlob, /An active review could remove a run already on the scoreboard/);
assert.match(bannerBlob, /Detroit Tigers @ Pittsburgh Pirates/);
assert.match(bannerBlob, /Manager Challenge/);
// Scores come straight from the payload (away 3 / home 1, minus the one run).
assert.match(bannerBlob, /Call stands: DET 3 – PIT 1 · If removed: DET 2 – PIT 1/);
assert.match(bannerBlob, /DET scored the run/);
assert.match(bannerBlob, /Credited: Test Runner/);
assert.match(bannerBlob, /not predicted here/,
  'the banner states plainly that the ruling is not predicted');
assert.ok(!bannerBlob.includes('undefined'), `banner leaked "undefined": ${bannerBlob}`);

// The stats bar counts it.
const statStrings = collectStrings(registry['#feed-stats'], []);
assert.ok(statStrings.includes('Runs at Risk'), `stats bar shows the Runs at Risk stat, got: ${JSON.stringify(statStrings)}`);
const runRiskStat = findIn(registry['#feed-stats'], '.stat-run-risk');
assert.ok(runRiskStat, 'Runs at Risk stat has its urgent class');
assert.equal(findIn(runRiskStat, '.review-stat-value').text, '1');

// 4d-bis. EVERY run-at-risk surface must disclaim that the ruling is not
// predicted — banner, row badge and stat alike. docs/verification-report.md
// §11 makes exactly this claim, so it is pinned here rather than trusted.
const disclaimers = [
  ['banner note', collectStrings(banner, []).join(' | ')],
  ['row badge', riskBadge.title || ''],
  ['stat', runRiskStat.title || ''],
];
disclaimers.forEach(([where, text]) => {
  assert.match(text, /not a prediction|not predicted/i,
    `${where} must disclaim that the ruling is not predicted, got: ${text}`);
});

// The public API exposes the tracked state for the alerting path.
assert.equal(context.window.ReplayFeed.getRunsAtRisk(), 1);
const riskEvents = context.window.ReplayFeed.getRunRiskEvents();
assert.equal(riskEvents.length, 1);
assert.equal(riskEvents[0].runs, 1);
assert.equal(riskEvents[0].gamePk, 823342);
assert.equal(riskEvents[0].matchup, 'Detroit Tigers @ Pittsburgh Pirates');

// 4c. The Boundary Calls filter tab renders with the setFilter wiring the
// other tabs use (observed typeKey 'boundary' — see tools/review-test.mjs §3c).
const tabsNode = registry['#feed-tabs'];
const tabStrings = [];
collectStrings(tabsNode, tabStrings);
assert.ok(tabStrings.some((s) => /^Boundary Calls \(0\)$/.test(s)),
  `Boundary Calls tab with count renders, got: ${JSON.stringify(tabStrings)}`);
assert.ok(tabStrings.some((s) => s === "ReplayFeed.setFilter('boundary')"),
  'Boundary Calls tab wires ReplayFeed.setFilter(\'boundary\')');
assert.ok(tabStrings.some((s) => /^ABS \(1\)$/.test(s)), 'captured ABS tab count');
assert.ok(tabStrings.some((s) => /^Challenges \(1\)$/.test(s)), 'active manager-review tab count');
assert.ok(tabStrings.some((s) => /^● Under Review \(1\)$/.test(s)), 'active review tab count');
assert.ok(tabStrings.some((s) => /^⚠️ Runs at Risk \(1\)$/.test(s)),
  `Runs at Risk filter tab renders with its count, got: ${JSON.stringify(tabStrings)}`);
assert.ok(tabStrings.some((s) => s === "ReplayFeed.setFilter('runrisk')"),
  "Runs at Risk tab wires ReplayFeed.setFilter('runrisk')");

// 4e. The Runs at Risk filter shows only the at-risk event.
context.window.ReplayFeed.setFilter('runrisk');
const riskRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(riskRows.length, 1, 'the runrisk filter shows only the at-risk row');
assert.match(collectStrings(riskRows[0], []).join(' | '), /1 RUN AT RISK/);
context.window.ReplayFeed.setFilter('all');
assert.equal(registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row')).length, 2,
  'switching back to All restores every row');

// 5. Whole-page sweep: stats bar, tabs, active strip, status line included.
const everything = [];
Object.values(registry).forEach((n) => collectStrings(n, everything));
const leaked = everything.filter((s) => String(s).includes('undefined'));
assert.equal(leaked.length, 0, `no rendered string may contain "undefined": ${JSON.stringify(leaked)}`);

// 6. Status line summarizes the poll.
assert.match(registry['#status-line'].textContent, /1 game · 2 review events · updated /);
assert.match(registry['#status-line'].textContent, /refreshing every 1s/);

/* 7. The run-at-risk predicate is DUPLICATED on purpose — MLBReviews.
 * runsRemovableByReview() in reviews.js and runsRemovableFromReview() in
 * reviews-feed.js — so the feed's pure-helper layer and its Node tests do not
 * depend on reviews.js being loaded. This file is the only place both modules
 * live in one VM, so it is the only place the copies can be pinned together.
 * If they ever drift, this fails.
 */
const MLBReviewsInVm = context.window.MLBReviews;
const feedExports = context.module.exports;
assert.ok(MLBReviewsInVm && typeof MLBReviewsInVm.runsRemovableByReview === 'function',
  'reviews.js exposes runsRemovableByReview');
assert.ok(feedExports && typeof feedExports.runsRemovableFromReview === 'function',
  'reviews-feed.js exposes runsRemovableFromReview');

const predicateCases = [
  // [label, review]
  ['null', null],
  ['undefined', undefined],
  ['empty object', {}],
  ['active, no scoreImpact', { inProgress: true }],
  ['active, null scoreImpact', { inProgress: true, scoreImpact: null }],
  ['active, non-object scoreImpact', { inProgress: true, scoreImpact: 'nope' }],
  ['active, zero runs', { inProgress: true, scoreImpact: { runsCredited: 0, runsAtRisk: 0, runsAtRiskAtStart: 0 } }],
  ['active, one run', { inProgress: true, scoreImpact: { runsCredited: 1, runsAtRisk: 1, runsAtRiskAtStart: 1 } }],
  ['active, three runs', { inProgress: true, scoreImpact: { runsCredited: 3, runsAtRisk: 3, runsAtRiskAtStart: 3 } }],
  ['active, late-arriving run', { inProgress: true, scoreImpact: { runsAtRiskAtStart: 0, runsAtRisk: 0, runsCredited: 2 } }],
  ['active, preserved higher snapshot', { inProgress: true, scoreImpact: { runsAtRiskAtStart: 2, runsAtRisk: 0, runsCredited: 0 } }],
  ['resolved with credit', { inProgress: false, scoreImpact: { runsCredited: 2, runsAtRisk: 0, runsAtRiskAtStart: 2 } }],
  ['truthy-but-not-true inProgress', { inProgress: 1, scoreImpact: { runsCredited: 2 } }],
  ['NaN runs', { inProgress: true, scoreImpact: { runsCredited: NaN } }],
  ['negative runs', { inProgress: true, scoreImpact: { runsCredited: -2 } }],
  ['string runs', { inProgress: true, scoreImpact: { runsCredited: '3' } }],
  ['Infinity runs', { inProgress: true, scoreImpact: { runsCredited: Infinity } }],
  ['abs typeKey with a run', { typeKey: 'abs', inProgress: true, scoreImpact: { runsCredited: 1, runsAtRisk: 1, runsAtRiskAtStart: 1 } }],
];
predicateCases.forEach(([label, review]) => {
  const fromReviews = MLBReviewsInVm.runsRemovableByReview(review);
  const fromFeed = feedExports.runsRemovableFromReview(review);
  assert.equal(fromFeed, fromReviews,
    `runsRemovableFromReview and runsRemovableByReview must agree for "${label}" (feed=${fromFeed}, reviews=${fromReviews})`);
  assert.equal(feedExports.shouldRunRiskAlert(review), MLBReviewsInVm.reviewCouldRemoveRuns(review),
    `shouldRunRiskAlert and reviewCouldRemoveRuns must agree for "${label}"`);
});
// The table must actually exercise both outcomes, or the loop proves nothing.
const positives = predicateCases.filter(([, r]) => MLBReviewsInVm.runsRemovableByReview(r) > 0);
assert.ok(positives.length >= 5, `predicate table covers the at-risk branch (${positives.length} cases)`);
assert.ok(predicateCases.length - positives.length >= 10, 'predicate table covers the not-at-risk branch');

console.log('Replay-feed render test passed successfully!');
