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
 * renders all three score states without inventing Actual. Also pins the
 * sectioning requirement: the All section renders challenges/reviews/
 * boundary/under-review/run-at-risk rows but NOT the ABS pitch challenge,
 * which stays fully tracked under its own ABS tab (and its stat/counters).
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
// The atBatIndex 16, 17/currentPlay and 18 records are deterministic tracker
// data, separate from the verbatim capture: 2-1 before the play, 3-1 after a
// safe-at-home call, with one scoring movement tied to the reviewed event.
// The atBatIndex 18 entry is the OFFICIAL SCORER PENDING fixture: its marker
// fields (eventType os_ruling_pending_primary, event/description "Official
// Scorer Ruling Pending") are the verbatim values from the official StatsAPI
//   event-type registry (GET /api/v1/eventTypes, fetched live 2026-08-30); the
//   surrounding play shape mirrors the live playByPlay shape. The marker has
//   NOT been captured on a real pending play — see
//   docs/verification-report.md §14 for the exact verification status.
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
    // Deterministic OFFICIAL SCORER PENDING fixture (see block comment above):
    // the batting side comes from halfInning 'top' → away = DET (116).
    {
      about: { atBatIndex: 18, startTime: '2026-08-19T18:45:00Z', endTime: null, inning: 7, halfInning: 'top', isTopInning: true, isComplete: false },
      result: { type: 'atBat' },
      matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
      playEvents: [
        { index: 0, isPitch: true, details: { description: 'In play, no out', type: { description: 'Sinker' } } },
        {
          index: 1, isPitch: false, type: 'action',
          details: {
            description: 'Official Scorer Ruling Pending',
            event: 'Official Scorer Ruling Pending',
            eventType: 'os_ruling_pending_primary',
          },
        },
      ],
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

const callCounts = { schedule: 0, teams: 0, pbp: 0, counts: 0 };
// The served playByPlay payload is mutable so later sections can drive a
// second/third poll with a changed play (the official-scoring-change test at
// the bottom of this file). Until reassigned it is the captured fixture.
let pbpPayload = PBP;
const MLBStub = {
  getSchedule: async () => { callCounts.schedule += 1; return SCHEDULE_GAMES; },
  getTeams: async () => { callCounts.teams += 1; return TEAMS_DIR; },
  getPlayByPlay: async () => { callCounts.pbp += 1; return pbpPayload; },
  getChallengeCounts: async () => { callCounts.counts += 1; return CHALLENGE_COUNTS; },
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

// 1. The default All section renders the deterministic active score-impact
// review — and must NOT render the captured ABS pitch challenge. Per the
// sectioning requirement, All shows challenges, reviews, boundary calls,
// under-review status and run-at-risk entries; ABS challenges are tracked
// separately (their own tab below, stat and counters).
const feedList = registry['#feed-list'];
const rows = feedList.children.filter((c) => c.cls.includes('feed-row'));
assert.equal(rows.length, 2, `expected 2 feed rows in All (manager review + official-scorer pending), got ${rows.length}`);
const rowRecords = rows.map((row) => {
  const strings = [];
  collectStrings(row, strings);
  return { row, blob: strings.join(' | ') };
});
const impactRecord = rowRecords.find((record) => record.blob.includes('1 RUN AT RISK'));
assert.ok(impactRecord, 'active score-impact row rendered in All');
const pendingRecord = rowRecords.find((record) => record.blob.includes('Official Scoring Pending'));
assert.ok(pendingRecord, 'official-scorer pending row rendered in All');
assert.ok(!rowRecords.some((record) => record.blob.includes('ABS Challenge')),
  'the All section must not contain ABS pitch challenges');

// 1-bis. The official-scorer pending row: type chip and ruling-pending
// outcome pill from the deterministic fixture; batting side DET from the
// play's halfInning 'top' (away) + the official /teams directory — never
// guessed; NO run-at-risk flag/badge (a scoring ruling never removes a run).
const pendingBlob = pendingRecord.blob;
assert.ok(pendingBlob.includes('Official Scoring Pending'), 'type chip');
assert.ok(pendingBlob.includes('Ruling Pending'), 'in-progress outcome pill');
assert.ok(pendingBlob.includes('Batting: DET'), 'batting-side chip');
assert.ok(!pendingRecord.row.cls.includes('feed-row-run-risk'),
  'a pending scoring ruling is never flagged run-at-risk');
assert.equal(findIn(pendingRecord.row, '.feed-run-risk-badge'), null,
  'no run-at-risk badge on the pending row');
assert.ok(!pendingBlob.includes('undefined'), `pending row leaked "undefined": ${pendingBlob}`);

// The dedicated scoring-pending strip renders (with the batting team), and
// the pending ruling is NOT duplicated under the generic LIVE REVIEW strip.
const osStrip = findIn(registry['#active-strip'], '.feed-active-strip-os');
assert.ok(osStrip, 'scoring-pending strip renders');
const osStripStrings = [];
collectStrings(osStrip, osStripStrings);
assert.ok(osStripStrings.includes('⚖️ SCORING PENDING'), 'scoring-pending badge');
assert.ok(osStripStrings.includes('Official Scoring Pending'), 'scoring-pending strip type');
assert.ok(osStripStrings.includes('Batting: DET'), 'scoring-pending strip batting team');
// Generic replay strip = every .feed-active-strip child EXCEPT the OS strip.
const genericStripStrings = [];
registry['#active-strip'].children
  .filter((c) => c.cls.includes('feed-active-strip') && !c.cls.includes('feed-active-strip-os'))
  .forEach((c) => collectStrings(c, genericStripStrings));
assert.ok(genericStripStrings.includes('🚨 LIVE REVIEW'), 'replay LIVE REVIEW strip still renders');
assert.ok(!genericStripStrings.includes('Official Scoring Pending'),
  'pending ruling stays out of the generic LIVE REVIEW strip');

// The ABS pitch challenge is still fully tracked: switch to its own
// section and it renders there with all of its official fields.
context.window.ReplayFeed.setFilter('abs');
const absRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(absRows.length, 1, `expected exactly 1 ABS row under the ABS tab, got ${absRows.length}`);
const absStrings = [];
collectStrings(absRows[0], absStrings);
const absRecord = { row: absRows[0], blob: absStrings.join(' | ') };
assert.ok(absRecord.blob.includes('ABS Challenge'), 'captured ABS row rendered under its own tab');
context.window.ReplayFeed.setFilter('all');
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

// The stats bar partitions the two sections: Events counts the All section
// (no ABS), while ABS Challenges keeps its own count — ABS stays tracked.
const statPairs = {};
registry['#feed-stats'].children.forEach((item) => {
  const label = findIn(item, '.review-stat-label');
  const value = findIn(item, '.review-stat-value');
  if (label && value) statPairs[label.text] = value.text;
});
assert.equal(statPairs['Events'], '2',
  `Events stat counts the All section (non-ABS), got: ${JSON.stringify(statPairs)}`);
assert.equal(statPairs['ABS Challenges'], '1',
  `ABS Challenges stat keeps counting the tracked ABS event, got: ${JSON.stringify(statPairs)}`);
assert.equal(statPairs['Scoring Pending'], '1',
  `Scoring Pending stat shows the active official-scorer ruling, got: ${JSON.stringify(statPairs)}`);

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
assert.ok(tabStrings.some((s) => /^All \(2\)$/.test(s)),
  `All tab counts only what the section shows (no ABS), got: ${JSON.stringify(tabStrings)}`);
assert.ok(tabStrings.some((s) => /^⚖️ Scoring Pending \(1\)$/.test(s)),
  `Scoring Pending tab renders with its count, got: ${JSON.stringify(tabStrings)}`);
assert.ok(tabStrings.some((s) => s === "ReplayFeed.setFilter('pending_scoring')"),
  "Scoring Pending tab wires ReplayFeed.setFilter('pending_scoring')");
assert.ok(tabStrings.some((s) => /^Challenges \(1\)$/.test(s)), 'active manager-review tab count');
assert.ok(tabStrings.some((s) => /^● Under Review \(1\)$/.test(s)),
  'Under Review is a replay-review tab — the scoring-pending row is NOT counted there');
assert.ok(tabStrings.some((s) => /^⚠️ Runs at Risk \(1\)$/.test(s)),
  `Runs at Risk filter tab renders with its count, got: ${JSON.stringify(tabStrings)}`);
assert.ok(tabStrings.some((s) => s === "ReplayFeed.setFilter('runrisk')"),
  "Runs at Risk tab wires ReplayFeed.setFilter('runrisk')");

// 4e. The Runs at Risk filter shows only the at-risk event.
context.window.ReplayFeed.setFilter('runrisk');
const riskRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(riskRows.length, 1, 'the runrisk filter shows only the at-risk row');
assert.match(collectStrings(riskRows[0], []).join(' | '), /1 RUN AT RISK/);
// All restores every non-ABS row — the at-risk manager row and the
// official-scorer pending row — and keeps ABS sectioned out.
context.window.ReplayFeed.setFilter('all');
const allRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(allRows.length, 2, 'switching back to All restores every non-ABS row');
assert.ok(!collectStrings(allRows[0], []).join(' | ').includes('ABS Challenge'),
  'All must not render the ABS row even after switching filters');
// The ABS tab is where the tracked ABS pitch challenge lives.
context.window.ReplayFeed.setFilter('abs');
const absOnlyRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(absOnlyRows.length, 1, 'the ABS tab shows exactly the tracked ABS row');
assert.ok(collectStrings(absOnlyRows[0], []).join(' | ').includes('ABS Challenge'),
  'the ABS tab renders the ABS row with its content');
context.window.ReplayFeed.setFilter('all');

// 5. Whole-page sweep: stats bar, tabs, active strip, status line included.
const everything = [];
Object.values(registry).forEach((n) => collectStrings(n, everything));
const leaked = everything.filter((s) => String(s).includes('undefined'));
assert.equal(leaked.length, 0, `no rendered string may contain "undefined": ${JSON.stringify(leaked)}`);

// 6. Status line summarizes the poll. The feed tracks ABS + manager review +
// official-scorer pending = 3 events; a review (or pending ruling) in flight
// uses the in-review cadence REVIEW_POLL_MS = 250 (assets/js/reviews-feed.js).
assert.match(registry['#status-line'].textContent, /1 game · 3 review events · updated /);
assert.match(registry['#status-line'].textContent, /refreshing every 0\.25s/);

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

/* 8. LATENCY PATH (low-poll-count verification of the load() restructure).
 * The schedule is cached for SCHEDULE_TTL_MS (assets/js/reviews-feed.js) and
 * refreshed in PARALLEL with the playByPlay scan, so a poll must NEVER issue
 * a second schedule request back-to-back, and the scan must run every poll.
 * First poll: exactly 1 schedule + 1 teams + 1 playByPlay (fixture = 1 game).
 * Second poll: schedule + teams served from cache (counts stay 1); the scan
 * still fetches playByPlay again (count 2). */
const afterBoot = { ...callCounts };
assert.equal(afterBoot.schedule, 1, 'first poll fetches the schedule once');
assert.equal(afterBoot.pbp, 1, 'first poll scans the one candidate game once');
context.window.ReplayFeed.refresh();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
assert.equal(callCounts.schedule, 1,
  `a second poll within the schedule TTL must NOT refetch the schedule (${callCounts.schedule})`);
// (teams is still CALLED each poll by the feed, but api.js serves it from its
// own cached promise — no network; the stub has no such cache, so no count
// assertion is made here.)
assert.equal(callCounts.pbp, 2, 'the playByPlay scan still runs on every poll');
// The second poll is idempotent: no duplicate feed rows, no re-alert.
const rowsAfterReboot = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(rowsAfterReboot.length, 2, 'second poll keeps exactly the two All rows');
assert.match(registry['#status-line'].textContent, /1 game · 3 review events · /,
  'second poll does not double-count events (still 3 tracked)');

console.log('Replay-feed render test passed successfully!');

/* ============================================================ 9. OFFICIAL
 * SCORING-CHANGE tracker — end-to-end through the REAL boot path. Poll A
 * establishes a completed play's baseline classification (single); poll B
 * serves the SAME play officially rescored to a field error — the exact
 * real-world flow of MLB's official scoring changes (see
 * docs/scoring-changes.md; live-verified precedents: 2026 log change #230,
 * Vladimir Guerrero Jr. double→single on 8/30, and #232, Munetaka Muramoto
 * single→fielder's choice + error on 8/29). The play itself is deterministic
 * fixture data built on the verified live field vocabulary. */

// A completed play with a real classification (deterministic, verified shape).
const SCORING_PLAY_BASE = {
  about: { atBatIndex: 21, startTime: '2026-08-19T19:10:00Z', endTime: '2026-08-19T19:12:00Z', inning: 7, halfInning: 'bottom', isTopInning: false, isComplete: true, hasReview: false },
  count: { balls: 1, strikes: 2, outs: 1 },
  matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
  runners: [
    { movement: { originBase: null, start: null, end: '1B', outBase: null, isOut: false, outNumber: null }, details: { event: 'Single', eventType: 'single', movementReason: null, runner: { fullName: 'Bryan Reynolds' }, responsiblePitcher: null, isScoringEvent: false, rbi: false, earned: false, teamUnearned: false, playIndex: 1 } },
  ],
};
const PBP_BASELINE = {
  ...PBP,
  allPlays: [...PBP.allPlays, {
    ...SCORING_PLAY_BASE,
    result: { event: 'Single', eventType: 'single', description: 'Bryan Reynolds singles on a line drive to left fielder Riley Greene.', rbi: 0, awayScore: 3, homeScore: 1, isOut: false },
  }],
};
const PBP_RESCORED = {
  ...PBP,
  allPlays: [...PBP.allPlays, {
    ...SCORING_PLAY_BASE,
    result: { event: 'Field Error', eventType: 'field_error', description: 'Bryan Reynolds reaches on a fielding error by third baseman Hao-Yu Lee.', rbi: 0, awayScore: 3, homeScore: 1, isOut: false },
  }],
};

// Poll A — baseline poll: the completed play is snapshotted, NO row yet.
pbpPayload = PBP_BASELINE;
context.window.ReplayFeed.refresh();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
assert.equal(callCounts.pbp, 3, 'poll A fetched the playByPlay once more');
let allRowsA = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(allRowsA.length, 2, 'a baseline observation mints no scoring-change row');
assert.match(registry['#status-line'].textContent, /3 review events/,
  'baselines do not enter the event feed');

// Poll B — the official scorer changes the single to a field error: the row
// appears in the ALL feed with the observed initial call and final ruling.
pbpPayload = PBP_RESCORED;
context.window.ReplayFeed.refresh();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
assert.equal(callCounts.pbp, 4, 'poll B fetched the playByPlay once more');

allRowsA = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(allRowsA.length, 3, 'the scoring-change row renders in the All feed');
const scoringRow = allRowsA.find((row) => row.dataset.key === '823342:scoring-21');
assert.ok(scoringRow, `scoring row carries the stable key, got: ${allRowsA.map((r) => r.dataset.key).join(', ')}`);
const scoringStrings = [];
collectStrings(scoringRow, scoringStrings);
const scoringBlob = scoringStrings.join(' | ');
assert.ok(scoringBlob.includes('Scoring Change'), 'type chip');
assert.ok(scoringBlob.includes('Rescored'), 'outcome pill');
assert.ok(scoringBlob.includes('Single'), `initial call label, got: ${scoringBlob}`);
assert.ok(scoringBlob.includes('Field Error'), `final ruling label, got: ${scoringBlob}`);
assert.ok(scoringBlob.includes('→'), 'initial → final arrow');
assert.ok(/Initial call \(observed .*\): Bryan Reynolds singles/.test(scoringBlob),
  `initial call line with observation time, got: ${scoringBlob}`);
assert.ok(scoringBlob.includes('Final ruling: Bryan Reynolds reaches on a fielding error'),
  `final ruling line, got: ${scoringBlob}`);
assert.ok(scoringBlob.includes('Official scoring change — no replay review observed'),
  `attribution note, got: ${scoringBlob}`);
assert.ok(scoringBlob.includes('Batting: PIT'), 'batting-side chip (bottom half → home)');
assert.ok(scoringBlob.includes('Batter: Bryan Reynolds'), 'batter footer');
assert.ok(scoringBlob.includes('Pitcher: Jackson Jobe'), 'pitcher footer');
assert.ok(scoringBlob.includes('Detroit Tigers @ Pittsburgh Pirates'), 'official matchup');
assert.ok(!scoringBlob.includes('undefined'), `scoring row leaked "undefined": ${scoringBlob}`);
assert.ok(!scoringRow.cls.includes('feed-row-run-risk'),
  'a scoring change is never flagged run-at-risk');
assert.equal(findIn(scoringRow, '.feed-run-risk-badge'), null,
  'no run-at-risk badge on a scoring-change row');
assert.equal(findIn(scoringRow, '.feed-scoring-call-hit') ? 'hit' : 'none', 'hit',
  'the initial call chip carries its category class');
assert.ok(findIn(scoringRow, '.feed-scoring-call-error'), 'the final ruling chip carries its category class');

// Stats: the Scoring Changes stat appears; Events (the All count) includes it.
const statPairsB = {};
registry['#feed-stats'].children.forEach((item) => {
  const label = findIn(item, '.review-stat-label');
  const value = findIn(item, '.review-stat-value');
  if (label && value) statPairsB[label.text] = value.text;
});
assert.equal(statPairsB['Scoring Changes'], '1',
  `Scoring Changes stat appears with its count, got: ${JSON.stringify(statPairsB)}`);
assert.equal(statPairsB['Events'], '3', 'Events counts the All section including scoring changes');
assert.equal(statPairsB['Scoring Pending'], '1', 'Scoring Pending unchanged');

// Tabs: the ✏️ Scoring Changes tab exists, is wired, and shows the row.
const tabStringsB = [];
collectStrings(registry['#feed-tabs'], tabStringsB);
assert.ok(tabStringsB.some((s) => /^✏️ Scoring Changes \(1\)$/.test(s)),
  `Scoring Changes tab renders with its count, got: ${JSON.stringify(tabStringsB)}`);
assert.ok(tabStringsB.some((s) => /^All \(3\)$/.test(s)),
  `All tab counts scoring changes in, got: ${JSON.stringify(tabStringsB)}`);
assert.ok(tabStringsB.some((s) => s === "ReplayFeed.setFilter('scoring')"),
  "Scoring Changes tab wires ReplayFeed.setFilter('scoring')");
context.window.ReplayFeed.setFilter('scoring');
const scoringOnly = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(scoringOnly.length, 1, 'the Scoring Changes tab shows exactly the scoring row');
assert.equal(scoringOnly[0].dataset.key, '823342:scoring-21');
// A scoring change is a NOT a replay: the Under Review tab shows the
// in-progress manager challenge (fixture idx 15) but never the scoring row.
context.window.ReplayFeed.setFilter('live');
const liveRows = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(liveRows.length, 1, 'the Under Review tab stays replay-only');
assert.notEqual(liveRows[0].dataset.key, '823342:scoring-21',
  'the scoring-change row never appears under Under Review');
context.window.ReplayFeed.setFilter('all');
assert.equal(registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row')).length, 3,
  'All restores the scoring row');

// Poll C — idempotence: the same rescored payload again must not duplicate.
context.window.ReplayFeed.refresh();
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
await new Promise((r) => setImmediate(r));
const rowsAfterScoringReboot = registry['#feed-list'].children.filter((c) => c.cls.includes('feed-row'));
assert.equal(rowsAfterScoringReboot.length, 3, 're-polling the rescored payload adds no rows');
assert.equal(rowsAfterScoringReboot.filter((r) => r.dataset.key === '823342:scoring-21').length, 1,
  'exactly one scoring-change row for the play');

console.log('Official scoring-change render checks passed.');
