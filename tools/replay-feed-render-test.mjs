#!/usr/bin/env node
/* ============================================================================
 * replay-feed-render-test.mjs — end-to-end render test for the all-games
 * Replay Feed (reviews.html), no network required.
 *
 * Loads the REAL page modules (assets/js/reviews-feed.js + reviews.js) into a
 * VM with a recording DOM stub and drives the actual boot path
 * (DOMContentLoaded -> load() -> getSchedule/getTeams/getPlayByPlay ->
 * ingestGame -> render*). The API fixtures below are VERBATIM captures from
 * statsapi.mlb.com on 2026-08-19 (see docs/verification-report.md):
 *
 *   - schedule entry for gamePk 823342 (Detroit Tigers @ Pittsburgh Pirates),
 *     whose team objects carry ONLY { id, name, link } — no `abbreviation`
 *     (this is the shape that used to render "undefined @ undefined");
 *   - the ABS pitch challenge (reviewType "MJ") at atBatIndex 15 of that
 *     game's playByPlay;
 *   - official /api/v1/teams directory entries for clubs 116 and 134.
 *
 * Asserts: every rendered text/attr contains official data only — the string
 * "undefined" can never appear — and the official full team names are shown.
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

/* -------------------------------------------- verbatim API fixtures (2026-08-19) */

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
// live at atBatIndex 15 (reviewDetails.reviewType "MJ", challengeTeamId 116),
// plus the game's live currentPlay shape ({result:{},about:{},playEvents:[]}).
const PBP = {
  allPlays: [{
    about: { atBatIndex: 15, startTime: '2026-08-19T17:05:00Z', endTime: '2026-08-19T17:07:00Z', inning: 2, halfInning: 'bottom', isComplete: true, hasReview: false },
    result: { description: 'Jared Triolo grounds out, third baseman Hao-Yu Lee to first baseman Spencer Torkelson.', event: 'Groundout' },
    matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
    playEvents: [
      { isPitch: true, startTime: '2026-08-19T17:06:00Z', details: { description: 'Ball', hasReview: true }, reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 116 } },
    ],
  }],
  currentPlay: { result: {}, about: {}, playEvents: [] },
};

// GET /api/v1/teams?sportId=1&season=2026 — the two entries this game needs,
// verbatim (id / official full name / official abbreviation).
const TEAMS_DIR = {
  116: { id: 116, name: 'Detroit Tigers', teamName: 'Tigers', locationName: 'Detroit', abbreviation: 'DET' },
  134: { id: 134, name: 'Pittsburgh Pirates', teamName: 'Pirates', locationName: 'Pittsburgh', abbreviation: 'PIT' },
};

const MLBStub = {
  getSchedule: async () => SCHEDULE_GAMES,
  getTeams: async () => TEAMS_DIR,
  getPlayByPlay: async () => PBP,
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

// 1. The feed rendered exactly one review row from the real payloads.
const feedList = registry['#feed-list'];
const rows = feedList.children.filter((c) => c.cls.includes('feed-row'));
assert.equal(rows.length, 1, `expected 1 feed row, got ${rows.length}`);
const rowTexts = [];
collectStrings(rows[0], rowTexts);
const rowBlob = rowTexts.join(' | ');

// 2. Official team names are shown — never "undefined", never a guess.
assert.ok(rowBlob.includes('Detroit Tigers @ Pittsburgh Pirates'),
  `feed row must show the official matchup names, got: ${rowBlob}`);
assert.ok(!rowBlob.includes('undefined'),
  `feed row leaked "undefined": ${rowBlob}`);

// 3. Challenging-team chip = official abbreviation, official full name on hover.
const teamChip = findIn(rows[0], '.feed-team');
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
const scoreChip = findIn(rows[0], '.feed-game-score');
assert.ok(scoreChip && scoreChip.text === '3–1',
  `score chip from the schedule linescore, got: ${scoreChip && scoreChip.text}`);

// 5. Whole-page sweep: stats bar, tabs, active strip, status line included.
const everything = [];
Object.values(registry).forEach((n) => collectStrings(n, everything));
const leaked = everything.filter((s) => String(s).includes('undefined'));
assert.equal(leaked.length, 0, `no rendered string may contain "undefined": ${JSON.stringify(leaked)}`);

// 6. Status line summarizes the poll.
assert.match(registry['#status-line'].textContent, /1 game · 1 review event · updated /);
assert.match(registry['#status-line'].textContent, /refreshing every 2s/);

console.log('Replay-feed render test passed successfully!');
