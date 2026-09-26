#!/usr/bin/env node
/* ============================================================================
 * review-watcher-test.mjs — integration test for the Replay Feed's
 * review-status watcher: the change that makes "a play is under review"
 * arrive within one sweep instead of up to ~3s. The sweep is the earliest
 * signal that exists for a challenge / review / boundary call; its cadence is
 * 125ms since 2026-09-26 (250ms before that — see docs/api-compliance.md).
 *
 * It drives the REAL page boot path (DOMContentLoaded -> load() + the
 * watcher's own timer) with fake timers and a stubbed MLB client, then
 * asserts the observable behaviour:
 *
 *   1. the watcher sweeps on boot, without waiting for a cadence;
 *   2. a sweep that reports a review merges the official status into the
 *      known slate — so ingestGame's pseudo-feed, reviewFetchPriority,
 *      hasActiveReviewSignal and renderActiveStrip all see it at once;
 *   3. that merge kicks an OUT-OF-BAND playByPlay scan instead of waiting
 *      for the next scheduled poll (this is the latency win, measured here
 *      in scan counts, not asserted in prose);
 *   4. the LIVE REVIEW strip shows the official detailedState and the
 *      registry reason from the status alone, before any play text exists;
 *   5. a sweep that changes nothing triggers no extra scan;
 *   6. a failed sweep is silent and does not break the page;
 *   7. a hidden tab stops sweeping.
 *
 * Fixtures: the schedule/pbp shapes mirror the verbatim captures used by
 * tools/replay-feed-render-test.mjs; the review STATUS rows are verbatim
 * GET /api/v1/gameStatus entries (verified live 2026-09-02).
 *
 * Run: node tools/review-watcher-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ------------------------------------------------------- fake timer queue */

let now = 0;
let timerId = 0;
const timers = new Map();

function fakeSetTimeout(fn, ms) {
  timerId += 1;
  timers.set(timerId, { fn, at: now + (Number.isFinite(ms) ? ms : 0) });
  return timerId;
}
function fakeClearTimeout(id) { timers.delete(id); }
function fakeSetInterval(fn) { timerId += 1; return timerId; }
function fakeClearInterval() {}

/** Run every timer that has come due, oldest first, up to `ms` of fake time. */
async function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null;
    timers.forEach((t, id) => {
      if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
    });
    if (!next) break;
    now = next.t.at;
    timers.delete(next.id);
    next.t.fn();
    // Drain the promise chain the callback started.
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  }
  now = target;
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

/* ------------------------------------------------------ recording DOM stub */

/** Minimal selectors the page uses: '.empty' and '.feed-row[data-key="…"]'. */
function matches(node, sel) {
  if (!node || !node.cls) return false;
  const classes = node.cls.split(/\s+/);
  if (!sel.startsWith('.')) return false;
  const bracket = sel.indexOf('[');
  const want = bracket >= 0 ? sel.slice(1, bracket) : sel.slice(1);
  if (!classes.includes(want)) return false;
  if (bracket >= 0) {
    const m = sel.match(/\[data-key="(.*)"\]/);
    if (m && node.dataset.key !== m[1]) return false;
  }
  return true;
}
function findIn(root, sel) {
  for (const c of root.children) {
    if (matches(c, sel)) return c;
    const deeper = findIn(c, sel);
    if (deeper) return deeper;
  }
  return null;
}

function makeNode(tag) {
  const node = {
    tag, cls: '', text: '', attrs: {}, children: [], dataset: {}, title: null,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
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
    querySelector(sel) { return findIn(node, sel); },
    get firstChild() { return this.children[0] || null; },
  };
  return node;
}

const registry = {};
['#status-line', '#feed-stats', '#active-strip', '#feed-tabs', '#feed-list',
  '#date-picker', '#date-label', '#live-dot', '#banner', '#date-nav',
  '#countdown', '#refresh-btn', '#sound-toggle-btn', '#notify-toggle-btn']
  .forEach((id) => { registry[id] = makeNode('div'); });

let domReadyCb = null;
const visibilityCbs = [];
const documentStub = {
  hidden: false,
  createElement: (tag) => makeNode(tag),
  querySelector: (sel) => registry[sel] || null,
  addEventListener: (ev, cb) => {
    if (ev === 'DOMContentLoaded') domReadyCb = cb;
    if (ev === 'visibilitychange') visibilityCbs.push(cb);
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
  clear: (n) => { if (n) n.children.length = 0; return n; },
  fmtCountdown: (s) => `${s}s`,
};

function collectStrings(node, out = []) {
  if (node.text) out.push(node.text);
  Object.values(node.attrs || {}).forEach((v) => out.push(v));
  if (node.title) out.push(node.title);
  (node.children || []).forEach((c) => collectStrings(c, out));
  return out;
}

/* ---------------------------------------------------------------- fixtures */

// Schedule rows mirror the verbatim captures in replay-feed-render-test.mjs
// (teams.*.team carries only { id, name, link }).
const baseStatus = () => ({
  abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress',
  statusCode: 'I', startTimeTBD: false, abstractGameCode: 'L',
});
const SCHEDULE_GAMES = [{
  gamePk: 823342,
  season: '2026',
  status: baseStatus(),
  teams: {
    away: { team: { id: 116, name: 'Detroit Tigers', link: '/api/v1/teams/116' }, score: 3 },
    home: { team: { id: 134, name: 'Pittsburgh Pirates', link: '/api/v1/teams/134' }, score: 1 },
  },
  linescore: { teams: { away: { runs: 3 }, home: { runs: 1 } }, currentInning: 6, inningState: 'Bottom' },
  review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
}];

// The current play: a safe-at-home call that credited a run, with NO review
// text yet — exactly the state a game is in the instant a manager challenges.
const PBP = {
  allPlays: [],
  currentPlay: {
    about: { atBatIndex: 17, inning: 6, halfInning: 'top', isComplete: false },
    result: { event: 'Single', eventType: 'single', awayScore: 3, homeScore: 1, description: 'Runner is safe at home.' },
    matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
    runners: [{
      movement: { start: '3B', end: 'score', isOut: false },
      details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 2, runner: { id: 1, fullName: 'Test Runner' } },
    }],
    playEvents: [{ index: 2, isPitch: true, details: { description: 'In play, run(s)' } }],
  },
};

// The same play, but with the review already recorded on the play itself —
// the shape the playByPlay endpoint carries once MLB writes reviewDetails.
const PBP_WITH_REVIEW = {
  allPlays: [],
  currentPlay: {
    about: { atBatIndex: 9, inning: 3, halfInning: 'bottom', isComplete: false },
    result: { event: 'Single', eventType: 'single', awayScore: 0, homeScore: 2, description: 'Runner is safe at home.' },
    matchup: { batter: { id: 665487, fullName: 'Test Batter' }, pitcher: { id: 682227, fullName: 'Test Pitcher' } },
    reviewDetails: { inProgress: true, reviewType: 'MA', challengeTeamId: 144 },
    runners: [{
      movement: { start: '3B', end: 'score', isOut: false },
      details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 2, runner: { id: 2, fullName: 'Slow Game Runner' } },
    }],
    playEvents: [{ index: 2, isPitch: true, details: { description: 'In play, run(s)' } }],
  },
};

const TEAMS_DIR = {
  116: { id: 116, name: 'Detroit Tigers', teamName: 'Tigers', locationName: 'Detroit', abbreviation: 'DET' },
  134: { id: 134, name: 'Pittsburgh Pirates', teamName: 'Pirates', locationName: 'Pittsburgh', abbreviation: 'PIT' },
};

// Verbatim GET /api/v1/gameStatus rows.
const STATUS_IN_PROGRESS = baseStatus();
const STATUS_MANAGER_CHALLENGE = {
  abstractGameState: 'Live', codedGameState: 'M',
  detailedState: 'Manager challenge: Tag play', statusCode: 'MA',
  reason: 'Tag play', startTimeTBD: false, abstractGameCode: 'L',
};
const STATUS_INSTANT_REPLAY = {
  abstractGameState: 'Live', codedGameState: 'I',
  detailedState: 'Instant Replay', statusCode: 'IH',
  reason: 'Review', startTimeTBD: false, abstractGameCode: 'L',
};

/* ------------------------------------------------------- stubbed MLB client */

const calls = { schedule: 0, reviewStatus: 0, pbp: 0, teams: 0, counts: 0 };
// gamePk -> official status returned by the next sweep.
const reviewStatusByGame = new Map([[823342, STATUS_IN_PROGRESS]]);
let reviewStatusFails = false;
// When set, getPlayByPlay parks on this deferred so a test can observe the
// strip in the window where ONLY the official status is known.
let pbpGate = null;
// Games whose playByPlay answers on the fake clock instead of immediately —
// the "slowest game in the slate" case.
const slowPks = new Set();
let slowMs = 4000;
// gamePk -> playByPlay payload (default PBP).
const pbpByGame = new Map();

const MLBStub = {
  getSchedule: async () => { calls.schedule += 1; return SCHEDULE_GAMES; },
  getReviewStatus: async () => {
    calls.reviewStatus += 1;
    if (reviewStatusFails) throw new Error('sweep failed');
    return [...reviewStatusByGame].map(([gamePk, status]) => ({ gamePk, status }));
  },
  getPlayByPlay: async (gamePk) => {
    calls.pbp += 1;
    if (pbpGate) await pbpGate;
    // A slow game resolves on the fake clock, so a test can hold it pending
    // across an assertion and then let it land with advance().
    if (slowPks.has(gamePk)) await new Promise((r) => fakeSetTimeout(r, slowMs));
    return pbpByGame.get(gamePk) || PBP;
  },
  getTeams: async () => { calls.teams += 1; return TEAMS_DIR; },
  getChallengeCounts: async () => {
    calls.counts += 1;
    return { gameData: { review: SCHEDULE_GAMES[0].review } };
  },
  ordinal: (n) => {
    const ORD = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];
    const n10 = n % 100;
    return `${n}${(n10 >= 11 && n10 <= 13) ? 'th' : ORD[n % 10] || 'th'}`;
  },
};

/* ------------------------------------------- live push (SSE) test harness */

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, cb) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(cb);
  }
  close() { this.closed = true; }
  emit(type, event) {
    (this.listeners.get(type) || []).slice().forEach((cb) => cb(event));
  }
}
FakeEventSource.instances = [];

/** Deliver one frame on the newest stream exactly as a browser would. */
function pushFrame(payload) {
  const stream = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  stream.emit('feed-log', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return stream;
}

/* ---------------------------------------------------------------- run page */

const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Date, Math, Number, String, Object, Array, URL, URLSearchParams, RegExp, JSON,
  CSS: { escape: (s) => s },
  UI: UIStub,
  MLB: MLBStub,
  window: { location: 'http://localhost/reviews.html', history: { replaceState() {} } },
  document: documentStub,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetInterval,
  clearInterval: fakeClearInterval,
  EventSource: FakeEventSource,
  module: { exports: {} },
};
vm.createContext(context);
// The REAL shared log module: the push path under test is subscribeFeedLog
// itself (frame parsing, the per-date guard, the give-up-after-3-errors rule),
// not a stub of it.
vm.runInContext(readFileSync(new URL('../assets/js/feed-log.js', import.meta.url), 'utf8'),
  context, { filename: 'assets/js/feed-log.js' });
vm.runInContext(readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8'),
  context, { filename: 'assets/js/reviews.js' });
vm.runInContext(readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8'),
  context, { filename: 'assets/js/reviews-feed.js' });

assert.equal(typeof domReadyCb, 'function', 'page registers DOMContentLoaded boot');
domReadyCb();
for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------- assertions */

/* 1. The watcher swept on boot, without waiting for its own cadence. */
assert.equal(calls.reviewStatus, 1, 'the watcher sweeps immediately on boot');
assert.ok(calls.schedule >= 1, 'the ordinary schedule poll also ran');
assert.equal(calls.pbp >= 1, true, 'the boot scan ran');

/* Nothing is under review yet: no LIVE REVIEW strip, no feed rows. */
assert.equal(collectStrings(registry['#active-strip']).join('|').includes('LIVE REVIEW'), false,
  'no LIVE REVIEW strip while the game is simply In Progress');
assert.equal(context.window.ReplayFeed.getRunsAtRisk(), 0, 'nothing at risk before a review');

/* 2. THE STATUS-ONLY WINDOW — the exact state the latency fix is about.
 * The playByPlay scan is parked, so no feed row exists yet: only the official
 * status is known. The strip must already say a review is running, in the
 * registry's own words. */
{
  let release = null;
  pbpGate = new Promise((r) => { release = r; });
  reviewStatusByGame.set(823342, STATUS_INSTANT_REPLAY);
  await advance(250);

  const strip = collectStrings(registry['#active-strip']).join('|');
  assert.ok(strip.includes('LIVE REVIEW'),
    'the LIVE REVIEW strip is up from the status alone, with no feed row yet');
  assert.ok(strip.includes('Instant Replay'),
    'the strip shows the official detailedState verbatim ("Instant Replay")');
  assert.ok(strip.includes('Review'), 'the strip shows the official registry reason');
  assert.ok(strip.includes('Detroit Tigers') && strip.includes('Pittsburgh Pirates'),
    'the strip still names both clubs');
  assert.ok(calls.pbp > 1, 'the flip kicked an out-of-band scan (now parked)');
  release();
  pbpGate = null;
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
}

/* 3. The scan lands: a feed row is synthesized from the status alone, with
 * the official reason and the run the reviewed call credited. */
{
  const feed = context.window.ReplayFeed;
  assert.ok(feed, 'ReplayFeed is exposed');
  assert.equal(feed.getRunsAtRisk(), 1,
    'the status-only review over a run-scoring play reports 1 run at risk immediately');
  const events = feed.getRunRiskEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].gamePk, 823342);
  assert.equal(events[0].reviewType, 'Instant Replay',
    'the crew-chief state keeps its official label end to end');
  const strip = collectStrings(registry['#active-strip']).join('|');
  assert.ok(strip.includes('RUN AT RISK'), 'the run-at-risk banner is up');
}

/* 4. A different review code on the same game IS a new event, and it drives
 * another out-of-band scan. */
{
  const pbpBefore = calls.pbp;
  reviewStatusByGame.set(823342, STATUS_MANAGER_CHALLENGE);
  await advance(250);
  assert.ok(calls.pbp > pbpBefore,
    `a second, different review triggers another out-of-band scan (${pbpBefore} -> ${calls.pbp})`);
  const strip = collectStrings(registry['#active-strip']).join('|');
  assert.ok(strip.includes('Manager Challenge'), 'the strip shows the new review type');
  assert.ok(strip.includes('Tag play'), 'the strip shows the new official reason');
}

/* 4b. THE SLOW-GAME CASE. A second live game joins the slate; its
 * playByPlay carries an in-progress review and answers at once, while the
 * first game's playByPlay only answers after 4s of fake time. The banner must
 * already be on screen while the slow game is still outstanding.
 *
 * This pins existing behaviour rather than new code: ingestGame calls
 * renderFeedUpdates(), which repaints the header stats, the LIVE REVIEW strip
 * and the run-at-risk banner as soon as ONE game's response lands. On a real
 * 15-game slate that is the difference between the alert arriving with the
 * first response that carries it and arriving after the slowest one — so if
 * that call is ever moved to the end-of-poll render(), this section fails. */
{
  SCHEDULE_GAMES.push({
    gamePk: 822686,
    season: '2026',
    status: baseStatus(),
    teams: {
      away: { team: { id: 144, name: 'Atlanta Braves', link: '/api/v1/teams/144' }, score: 0 },
      home: { team: { id: 120, name: 'Washington Nationals', link: '/api/v1/teams/120' }, score: 2 },
    },
    linescore: { teams: { away: { runs: 0 }, home: { runs: 2 } }, currentInning: 3, inningState: 'Bottom' },
    review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  });
  reviewStatusByGame.set(822686, STATUS_IN_PROGRESS);
  pbpByGame.set(822686, PBP_WITH_REVIEW);
  slowPks.add(823342);
  slowMs = 4000;

  // One poll: 822686 answers immediately, 823342 is still outstanding.
  await advance(600);

  const strip = collectStrings(registry['#active-strip']).join('|');
  assert.ok(strip.includes('RUN AT RISK'),
    'the run-at-risk banner is up while the slow game has not answered yet');
  assert.ok(strip.includes('Washington Nationals') && strip.includes('Atlanta Braves'),
    'the banner names the game whose response actually landed');
  assert.ok(strip.includes('Slow Game Runner'),
    'the banner credits the runner from the game that answered');

  // Let the slow game land; the page must stay consistent.
  await advance(4000);
  const after = collectStrings(registry['#active-strip']).join('|');
  assert.ok(after.includes('LIVE REVIEW'), 'the strip is still correct after the slow game lands');

  SCHEDULE_GAMES.pop();
  slowPks.clear();
  pbpByGame.delete(822686);
  reviewStatusByGame.delete(822686);
  await advance(4600);
}

/* 4c. THE MID-WAVE FLIP (added 2026-09-26). The status watcher's flip handler
 * calls load(); if a full-slate scan is ALREADY in flight that call is a
 * no-op (requestInFlight), so before this change the flipped game's row could
 * only land when the whole wave finished — after the slowest game in it. The
 * flip must instead fetch the flipped game out of band, immediately.
 *
 * Every playByPlay fetch is parked on a deferred, so the ordinary wave is
 * provably still outstanding while the flip happens. */
{
  // A FRESH gamePk with no feed row of its own yet (822686 already carries a
  // row from section 4b, and a row wins over the status in the strip): the
  // brand-new-challenge case.
  SCHEDULE_GAMES.push({
    gamePk: 824529,
    season: '2026',
    status: baseStatus(),
    teams: {
      away: { team: { id: 144, name: 'Atlanta Braves', link: '/api/v1/teams/144' }, score: 0 },
      home: { team: { id: 120, name: 'Washington Nationals', link: '/api/v1/teams/120' }, score: 2 },
    },
    linescore: { teams: { away: { runs: 0 }, home: { runs: 2 } }, currentInning: 3, inningState: 'Bottom' },
    review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  });
  reviewStatusByGame.set(824529, STATUS_IN_PROGRESS);

  let release = null;
  pbpGate = new Promise((r) => { release = r; });
  const beforeWave = calls.pbp;
  await advance(500); // ordinary poll starts; every fetch parks on the gate
  assert.ok(calls.pbp > beforeWave, 'the ordinary wave is in flight (parked)');

  reviewStatusByGame.set(824529, STATUS_INSTANT_REPLAY); // In Progress -> IH: a new review
  const atFlip = calls.pbp;
  await advance(250); // watcher sweep sees the flip

  assert.equal(calls.pbp, atFlip + 1,
    `the flipped game is fetched out of band while the wave is still parked (${atFlip} -> ${calls.pbp})`);
  assert.ok(collectStrings(registry['#active-strip']).join('|').includes('Instant Replay'),
    'the strip already shows the new official status for the game with no row yet');

  // A second sweep with the same status must not stack a second priority fetch.
  const afterKick = calls.pbp;
  await advance(250);
  assert.equal(calls.pbp, afterKick,
    'an unchanged sweep adds no extra fetch (the priority scan is already running)');

  release();
  pbpGate = null;
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
  await advance(600);
  SCHEDULE_GAMES.pop();
  reviewStatusByGame.delete(824529);
  await advance(600);
}

/* 4d. THE RUN-AT-RISK NOTIFICATION (added 2026-09-26). The chime has always
 * fired from the first response that carries the alert, but the DESKTOP
 * notification was flushed at the END of the poll — i.e. after the slowest
 * game in the wave, up to PBP_TIMEOUT_MS on a stalled one. It now leaves one
 * short coalescing window after that first response, so a run already on the
 * scoreboard is put in front of the user as soon as it is known.
 *
 * A second game is parked for 4s: if the notification still waited for the
 * wave, nothing would be recorded here. */
{
  const notificationStub = function Notification(title, opts) {
    notificationStub.log.push({ title, opts });
  };
  notificationStub.permission = 'granted';
  notificationStub.log = [];
  context.Notification = notificationStub;

  // Deliberately distinct club names (not the Braves/Nationals used by the
  // other fixture games) so "the notification for the game that ANSWERED" is
  // unambiguous in the assertions below.
  SCHEDULE_GAMES.push({
    gamePk: 824638,
    season: '2026',
    status: baseStatus(),
    teams: {
      away: { team: { id: 147, name: 'New York Yankees', link: '/api/v1/teams/147' }, score: 0 },
      home: { team: { id: 111, name: 'Boston Red Sox', link: '/api/v1/teams/111' }, score: 2 },
    },
    linescore: { teams: { away: { runs: 0 }, home: { runs: 2 } }, currentInning: 3, inningState: 'Bottom' },
    review: { hasChallenges: false, away: { used: 0, remaining: 1 }, home: { used: 0, remaining: 1 } },
  });
  reviewStatusByGame.set(824638, STATUS_MANAGER_CHALLENGE);
  pbpByGame.set(824638, PBP_WITH_REVIEW); // a reviewed play that credited a run
  slowPks.add(823342);                    // the slowest game in the wave
  slowMs = 4000;
  context.window.ReplayFeed.setNotifyEnabled(true);

  await advance(500); // wave starts: 824638 answers, 823342 is still parked

  const answeredNotes = () => notificationStub.log.filter((n) =>
    `${n.title} ${n.opts.body || ''}`.includes('Yankees'));
  assert.equal(answeredNotes().length, 1,
    'the run-at-risk notification for the game that ANSWERED left before the slow game landed');
  assert.ok(/RUN AT RISK/i.test(answeredNotes()[0].title) ||
            /RUN AT RISK/i.test(answeredNotes()[0].opts.body || ''),
    'the notification is the run-at-risk notification');

  await advance(4200); // let the slow game land and the poll end
  assert.equal(answeredNotes().length, 1,
    'the end-of-poll flush does not re-notify the same run-at-risk event');

  context.window.ReplayFeed.setNotifyEnabled(false);
  SCHEDULE_GAMES.pop();
  slowPks.clear(); // no NEW slow fetches; the parked one still has to land
  pbpByGame.delete(824638);
  reviewStatusByGame.delete(824638);
  await advance(5000); // let the parked slow fetch resolve and the wave finish
  await advance(600);
}

/* 5. An unchanged sweep triggers no EXTRA scan. While a review is in flight
 * the ordinary poll is already at the 250ms REVIEW cadence, so the watcher
 * sweeping on the same 250ms tick must not double it: over 1s we expect the
 * ~4 scans the ordinary cadence produces, not ~8. */
{
  const pbpBefore = calls.pbp;
  const sweepsBefore = calls.reviewStatus;
  await advance(1000);
  const scans = calls.pbp - pbpBefore;
  const sweeps = calls.reviewStatus - sweepsBefore;
  assert.ok(sweeps >= 3, `the watcher kept sweeping (${sweeps} sweeps in 1s)`);
  assert.ok(scans >= 2 && scans <= 6,
    `scans stay at the ordinary cadence, not one per sweep (${scans} scans / ${sweeps} sweeps in 1s)`);
}

/* 6. A failing sweep is silent and leaves the page running. */
{
  reviewStatusFails = true;
  const pbpBefore = calls.pbp;
  await advance(1000);
  reviewStatusFails = false;
  assert.ok(calls.reviewStatus >= 6, 'the watcher keeps sweeping after failures');
  assert.ok(calls.pbp >= pbpBefore, 'the page did not stop scanning');
  assert.equal(collectStrings(registry['#status-line']).join(' ').includes('failed'), false,
    'a failed sweep is not surfaced as a page error');
}

/* 7. A hidden tab stops the watcher; becoming visible sweeps again. */
{
  documentStub.hidden = true;
  visibilityCbs.forEach((cb) => cb());
  const before = calls.reviewStatus;
  await advance(2000);
  assert.equal(calls.reviewStatus, before, 'no sweeps while the tab is hidden');
  documentStub.hidden = false;
  visibilityCbs.forEach((cb) => cb());
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(calls.reviewStatus > before, 'becoming visible sweeps immediately');
}

/* 8. LIVE PUSH — the cross-session path added 2026-09-26. Another browser's
 * (or another tab's) review / challenge / pending-ruling entry is persisted to
 * the shared server log; the server pushes it over the SSE tail, and the row
 * must appear in THIS page immediately, with no poll of any kind. The same
 * render is driven synchronously by the frame, so the assertion runs before
 * any timer could fire. */
{
  const PUSH_PK = 824777;
  const pushedReview = {
    id: 'pushed-1',
    typeKey: 'challenge',
    reviewType: 'Manager challenge',
    reason: 'Pushed challenge reason',
    description: 'Pushed challenge description',
    inProgress: false,
    outcome: 'overturned',
    outcomeLabel: 'Overturned',
    atBatIndex: 12,
    challengeTeamId: 116,
    teamId: 116,
  };
  const payloadFor = (date, review, gamePk) => ({
    v: 1,
    date,
    savedAt: 1758914400000,
    entries: [{ gamePk, review, firstSeen: 1758914400000, lastSeen: 1758914400000 }],
    order: [`${gamePk}:${review.id}`],
    snapshots: {},
    irregularities: {},
    grace: {},
    settled: [],
  });

  assert.equal(FakeEventSource.instances.length, 1,
    'the feed opens exactly one live stream');
  const stream = FakeEventSource.instances[0];
  const streamDate = /\/api\/feed-log\/stream\?date=(\d{4}-\d{2}-\d{2})/.exec(stream.url);
  assert.ok(streamDate, `the stream subscribes to the log endpoint (${stream.url})`);
  const feedDate = streamDate[1];

  const before = { ...calls };
  pushFrame(payloadFor(feedDate, pushedReview, PUSH_PK));

  const text = collectStrings(registry['#feed-list']).join('|');
  assert.ok(text.includes('Pushed challenge reason'),
    'the pushed entry is on screen the moment the frame arrives');
  assert.ok(text.includes('Manager challenge'),
    'the pushed entry keeps its official review type');
  assert.equal(calls.pbp, before.pbp, 'rendering a pushed entry needs no playByPlay fetch');
  assert.equal(calls.reviewStatus, before.reviewStatus, 'and no status sweep');
  assert.equal(calls.schedule, before.schedule, 'and no schedule fetch');

  /* A repeated frame is idempotent (the server re-pushes on every write). */
  pushFrame(payloadFor(feedDate, pushedReview, PUSH_PK));
  const repeat = collectStrings(registry['#feed-list']).join('|');
  assert.equal(repeat.split('Pushed challenge reason').length - 1, 1,
    'a repeated frame does not duplicate the row');

  /* A frame for another date is not this page's business. */
  pushFrame(payloadFor('1999-01-01', { ...pushedReview, id: 'stale-1', reason: 'Stale reason' }, 824778));
  assert.equal(collectStrings(registry['#feed-list']).join('|').includes('Stale reason'), false,
    'a frame for a different date is ignored');

  /* A malformed frame must never throw into the page. */
  pushFrame('{not json');
  assert.ok(collectStrings(registry['#feed-list']).join('|').includes('Pushed challenge reason'),
    'a malformed frame leaves the rendered feed untouched');

  /* The stream is per date: a date switch closes the old one and opens a new
   * one, so the new date's entries are pushed too. */
  context.window.ReplayFeed.nextDay();
  assert.equal(FakeEventSource.instances.length, 2,
    'a date switch opens a stream for the new date');
  assert.equal(stream.closed, true, 'the previous date\'s stream is closed');
  const nextStream = FakeEventSource.instances[1];
  const nextDate = /date=(\d{4}-\d{2}-\d{2})/.exec(nextStream.url)[1];
  assert.notEqual(nextDate, feedDate, 'the new stream targets the new date');
}

/* 9. The watcher really is faster than the schedule cache it replaced, and
 * the cadence tightening is pinned: the live playByPlay scan runs at 250ms
 * (was 500ms — see docs/latency-audit.md addendum), the post-Final fast
 * rescan gap is 2.5s (was 5s), and since 2026-09-26 the first two minutes
 * after a final out are rescanned every 1s (the hot tier — see
 * docs/latency-audit.md 2026-09-26 addendum). */
{
  const src = readFileSync(new URL('../assets/js/reviews-feed.js', import.meta.url), 'utf8');
  const watcherMs = Number(/REVIEW_STATUS_POLL_MS\s*=\s*(\d+)/.exec(src)[1]);
  const ttl = Number(/SCHEDULE_TTL_MS\s*=\s*(\d+)/.exec(src)[1]);
  // The sweep must stay faster than the wave it feeds and than the schedule
  // cache it replaced; 125ms is half the 250ms wave, so a flip is seen within
  // half of one scan interval.
  assert.equal(watcherMs, 125, 'the watcher cadence is 125ms (2026-09-26)');
  assert.ok(watcherMs < ttl, `watcher ${watcherMs}ms < schedule cache ${ttl}ms`);
  const liveMs = Number(/LIVE_POLL_MS\s*=\s*(\d+)/.exec(src)[1]);
  const reviewMs = Number(/REVIEW_POLL_MS\s*=\s*(\d+)/.exec(src)[1]);
  assert.equal(liveMs, 250, 'the live playByPlay scan cadence is 250ms (2026-09-05)');
  assert.equal(reviewMs, 250, 'the in-review cadence is 250ms');
  const recentMs = Number(/SCORING_RECENT_RESCAN_MS\s*=\s*([\d.]+\s*\*\s*1000|\d+)/.exec(src)[1]
    .replace(/\s*\*\s*1000/, ''));
  assert.equal(recentMs, 2.5, 'the post-Final fast rescan gap is 2.5s (2026-09-05)');
  // 2026-09-26: the first two minutes after the final out are rescanned at 1s
  // (the hot tier), so a post-Final scorer ruling in the window where it is
  // most likely lands ~1s after publication instead of ~2.5s.
  const hotMs = Number(/SCORING_HOT_RESCAN_MS\s*=\s*(\d+)/.exec(src)[1]);
  const hotWindow = /SCORING_HOT_WINDOW_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  assert.equal(hotMs, 1000, 'the post-Final hot rescan gap is 1s (2026-09-26)');
  assert.equal(Number(hotWindow[1]) * Number(hotWindow[2]) * Number(hotWindow[3]), 120000,
    'the hot tier covers the first 2 minutes after Final');
  assert.ok(hotMs < recentMs * 1000,
    `hot ${hotMs}ms is faster than the fast tier ${recentMs * 1000}ms`);
}

console.log('Review-status watcher integration test passed successfully!');
