#!/usr/bin/env node
/* ============================================================================
 * page-status-watcher-test.mjs — integration tests for the standalone
 * review-status watchers on the two pages that previously detected a
 * BRAND-NEW review only on their ~500ms ordinary cycle. The watcher cadence
 * was 250ms from 2026-09-05 and is 125ms since 2026-09-26 (that sweep is the
 * earliest signal that exists, so it is the request that best repays a
 * tighter interval — see docs/api-compliance.md):
 *
 *   1. assets/js/scoreboard.js — whole-slate watcher (MLB.getReviewStatus):
 *      the 🚨 review ticker / card badges must appear within one sweep of MLB
 *      flipping a status to a review code, not on the next 500ms
 *      hydrated-schedule poll (docs/latency-audit.md §8 option 2).
 *   2. assets/js/game.js — per-game watcher (MLB.getGameStatus): a new
 *      review flips the page to its fast path, paints the banner from the
 *      LEAN probe (~3KB) instead of waiting for the 1-2MB full feed, and
 *      kicks an OUT-OF-BAND full feed (latency-audit §8 option 1 + the
 *      2026-09-26 probe-first change).
 *
 * Both pages are booted through their REAL DOMContentLoaded path in a VM
 * with fake timers, a recording DOM stub, a programmable MLB client, and
 * the REAL assets/js/reviews.js (so extractReviews / registry detection /
 * banner rendering are exercised, not stubbed).
 *
 * Verified behaviors (observable, no internals):
 *   scoreboard: sweep cadence 125ms while live; first sweep adopts without
 *     re-rendering; a real flip merges + re-renders (ticker up/down) and
 *     drops the main poll to its 250ms review cadence; a no-change sweep
 *     does not re-render; a hidden tab stops sweeping; an idle slate backs
 *     off to 5s; the pure diff helper scheduleStatusFlips is pinned; a
 *     pushed feed-log frame updates the scoring-change badge with no pull.
 *   game page: watcher sweeps 125ms while live && !in-review; a review flip
 *     paints "🚨 <official detailedState>" from status alone, paints the
 *     BANNER from the lean probe while the full feed is still in flight, and
 *     kicks an out-of-band full feed; the banner survives the stale in-flight
 *     feed landing (no flap); the lean probe then owns in-review ticks;
 *     resolution re-arms the watcher; a hidden tab stops sweeping.
 *
 * Fixtures mirror the verbatim shapes captured in replay-feed-render-test /
 * review-watcher-test (real gameStatus registry rows for MA; the same
 * reviewDetails shape MLB shipped on live games 823341/823342).
 *
 * Run: node tools/page-status-watcher-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

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
    for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
  }
  now = target;
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

/* ------------------------------------------------------ recording DOM stub */

function makeNode(tag) {
  const node = {
    tag, cls: '', text: '', attrs: {}, children: [], dataset: {}, title: null,
    style: {}, scrollTop: 0, isConnected: true,
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    set textContent(v) { node.text = String(v); node.children.length = 0; },
    get textContent() { return node.text; },
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
    click() {},
    // game.js renderHeader uses Element.replaceChildren (5 call sites).
    replaceChildren(...kids) { node.children.length = 0; kids.forEach((k) => node.appendChild(k)); },
    click() {},
    querySelector(sel) { return findIn(node, sel); },
    querySelectorAll() { return []; },
    get scrollHeight() { return 0; },
    get clientHeight() { return 0; },
    get firstChild() { return this.children[0] || null; },
  };
  return node;
}

function matches(node, sel) {
  if (!node || !node.cls) return false;
  const classes = node.cls.split(/\s+/);
  if (!sel.startsWith('.')) return false;
  return classes.includes(sel.slice(1));
}
function findIn(root, sel) {
  for (const c of root.children) {
    if (matches(c, sel)) return c;
    const deeper = findIn(c, sel);
    if (deeper) return deeper;
  }
  return null;
}

function collectStrings(node, out = []) {
  if (node.text) out.push(node.text);
  Object.values(node.attrs || {}).forEach((v) => out.push(v));
  if (node.title) out.push(node.title);
  (node.children || []).forEach((c) => collectStrings(c, out));
  return out;
}

/* ------------------------------------------------- live push (SSE) harness */

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

function pushFrame(payload) {
  const stream = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  stream.emit('feed-log', { data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return stream;
}

/* ------------------------------------------------------------- UI / MLB stubs */

const UIStub = {
  el: (tag, cls, text, attrs) => {
    const n = makeNode(tag);
    if (cls) n.cls = cls;
    if (text != null) n.text = String(text);
    if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v != null) n.setAttribute(k, v); });
    return n;
  },
  clear: (n) => { if (n) n.children.length = 0; return n; },
  statusChip: (status, label) => UIStub.el('span', 'chip', label || (status && status.detailedState) || ''),
  teamLogo: (id, name) => UIStub.el('span', `logo-${id}`, name || ''),
  headshot: (id, name) => UIStub.el('span', `headshot-${id}`, name || ''),
  countDots: (b, s, o) => UIStub.el('span', 'count', `${b}-${s}-${o}`),
  diamond: (runners) => UIStub.el('span', 'diamond', runners || ''),
  basesFromRunners: () => '',
  fmtCountdown: (s) => `${s}s`,
  fmtInnings: () => '',
  teamColor: () => '#2f81f7',
};

const FORMATTERS = {
  ordinal: (n) => {
    const ORD = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];
    const n10 = n % 100;
    return `${n}${(n10 >= 11 && n10 <= 13) ? 'th' : ORD[n % 10] || 'th'}`;
  },
  localTime: () => '7:40 PM',
  localDateTime: () => 'Fri, Sep 5, 7:40 PM',
  inningLabel: (ls, status) => {
    if (!ls) return '';
    if (status && status.abstractGameState === 'Final') return 'Final';
    const st = (ls.inningState || '').toLowerCase();
    const num = ls.currentInning != null ? String(ls.currentInning) : '';
    return st === 'top' ? `Top ${num}` : st === 'bottom' ? `Bot ${num}` : num;
  },
  inningGlyph: (ls) => {
    if (!ls) return '';
    const st = (ls.inningState || '').toLowerCase();
    const num = ls.currentInning != null ? String(ls.currentInning) : '';
    return st === 'top' ? `▲ ${num}` : st === 'bottom' ? `▼ ${num}` : '';
  },
  scoreOf: (game, side) => {
    const t = game.teams && game.teams[side];
    return t && typeof t.score === 'number' ? t.score : null;
  },
};

/* ------------------------------------------------------------- fixtures */

const baseStatus = () => ({
  abstractGameState: 'Live', codedGameState: 'I', detailedState: 'In Progress',
  statusCode: 'I', startTimeTBD: false, abstractGameCode: 'L',
});
// Verbatim GET /api/v1/gameStatus registry row (verified live 2026-09-02).
const STATUS_MANAGER_CHALLENGE = {
  abstractGameState: 'Live', codedGameState: 'M',
  detailedState: 'Manager challenge: Tag play', statusCode: 'MA',
  reason: 'Tag play', startTimeTBD: false, abstractGameCode: 'L',
};

/* =====================================================================
 * PART A — scoreboard.js
 * ===================================================================*/

{
  const ids = ['#banner', '#tabs', '#game-list', '#status-line', '#date-picker', '#date-label'];
  const registry = {};
  ids.forEach((id) => { registry[id] = makeNode('div'); });

  let domReadyCb = null;
  const visibilityCbs = [];
  const documentStub = {
    hidden: false,
    title: '',
    createElement: (tag) => makeNode(tag),
    querySelector: (sel) => registry[sel] || null,
    querySelectorAll: () => [],
    addEventListener: (ev, cb) => {
      if (ev === 'DOMContentLoaded') domReadyCb = cb;
      if (ev === 'visibilitychange') visibilityCbs.push(cb);
    },
  };

  const calls = { schedule: 0, reviewStatus: 0 };
  // When set, getSchedule parks on this deferred: no ordinary poll can
  // complete, so any rendering during that window is the WATCHER's doing.
  let scheduleGate = null;
  const slate = () => [{
    gamePk: 823342,
    season: '2026',
    status: slateStatus(),
    teams: {
      away: {
        team: { id: 116, name: 'Detroit Tigers' }, score: 3,
        leagueRecord: { wins: 70, losses: 62 },
      },
      home: {
        team: { id: 134, name: 'Pittsburgh Pirates' }, score: 1,
        leagueRecord: { wins: 60, losses: 72 },
      },
    },
    linescore: { currentInning: 6, inningState: 'Bottom', teams: { away: { runs: 3 }, home: { runs: 1 } } },
    venue: { name: 'Comerica Park' },
  }];
  let slateStatus = baseStatus;
  let sweepStatus = baseStatus;
  const MLBStub = {
    ...FORMATTERS,
    getSchedule: async () => {
      calls.schedule += 1;
      if (scheduleGate) await scheduleGate;
      return slate().map((g) => ({ ...g, status: slateStatus() }));
    },
    getReviewStatus: async () => {
      calls.reviewStatus += 1;
      return [{ gamePk: 823342, status: sweepStatus() }];
    },
  };

  // Transport stub for the shared-log module: every GET of the log endpoint is
  // counted, so the page's pull policy (per poll vs. throttled-with-push) is
  // directly observable. The payload itself starts empty.
  const net = { logGets: 0 };
  let pullPayload = {
    v: 1, date: '2026-09-05', savedAt: 0, entries: [], order: [],
    snapshots: {}, irregularities: {}, grace: {}, settled: [],
  };
  const fetchStub = async (url) => {
    if (String(url).includes('/api/feed-log?')) net.logGets += 1;
    return { ok: true, json: async () => pullPayload };
  };

  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Date, Math, Number, String, Object, Array, URLSearchParams, RegExp, JSON, URL,
    UI: UIStub,
    MLB: MLBStub,
    window: { location: { search: '' }, history: { replaceState() {} } },
    document: documentStub,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    EventSource: FakeEventSource,
    fetch: fetchStub,
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(src('assets/js/feed-log.js'), context, { filename: 'assets/js/feed-log.js' });
  vm.runInContext(src('assets/js/scoreboard.js'), context, { filename: 'assets/js/scoreboard.js' });

  /* A1. Pure sweep-diff policy (window.Scoreboard._scheduleStatusFlips). */
  {
    const flips = context.window.Scoreboard._scheduleStatusFlips;
    assert.equal(typeof flips, 'function', 'pure diff helper exposed for tests');
    const first = flips(new Map(), [{ gamePk: 1, status: baseStatus() }]);
    assert.equal(first.changed, true, 'first sweep reports changed (adopt)');
    const same = flips(first.codes, [{ gamePk: 1, status: baseStatus() }]);
    assert.equal(same.changed, false, 'identical sweep reports no change');
    const flip = flips(first.codes, [{ gamePk: 1, status: STATUS_MANAGER_CHALLENGE }]);
    assert.equal(flip.changed, true, 'review-code flip reports changed');
    const reason = flips(first.codes, [{
      gamePk: 1,
      status: { ...baseStatus(), statusCode: 'II', detailedState: 'Delayed', reason: 'Inclement Weather' },
    }]);
    assert.equal(reason.changed, true, 'a delay (statusCode/reason change) reports changed');
    const grown = flips(first.codes, [
      { gamePk: 1, status: baseStatus() }, { gamePk: 2, status: baseStatus() },
    ]);
    assert.equal(grown.changed, true, 'slate-size change reports changed');
    const empty = flips(new Map(), []);
    assert.equal(empty.changed, false, 'empty slate on first sweep: nothing to adopt');
    console.log('  A1 pure scheduleStatusFlips policy — ok');
  }

  /* Boot the page through its real DOMContentLoaded path. The watcher is
   * armed by the first scheduleNext() once the hydrated slate lands (games
   * is empty at DOMContentLoaded time, so an immediate boot sweep would have
   * nothing to diff against); its first sweep therefore fires ~250ms after
   * the first schedule poll resolves. */
  assert.equal(typeof domReadyCb, 'function', 'scoreboard registers DOMContentLoaded boot');
  domReadyCb();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  await advance(250);

  /* A2. The watcher swept once armed; a no-change sweep does NOT re-render.
   * Isolated by parking the next schedule poll on a deferred, so the only
   * thing running during the window is the status watcher. */
  assert.ok(calls.reviewStatus >= 1, 'status watcher sweeps once armed (~250ms after boot)');
  assert.ok(calls.schedule >= 1, 'hydrated schedule poll ran');
  assert.ok(registry['#game-list'].children.length > 0, 'cards rendered from the schedule');
  assert.equal(collectStrings(registry['#banner']).join('|').includes('ACTIVE REVIEWS'), false,
    'no review ticker before any review');
  {
    let release = null;
    scheduleGate = new Promise((r) => { release = r; });
    const cardBefore = registry['#game-list'].children[0];
    await advance(1000); // ~4 sweeps against an UNCHANGED slate, no poll completing
    assert.equal(registry['#game-list'].children[0] === cardBefore, true,
      'no-change sweeps do not re-render the cards');
    release();
    scheduleGate = null;
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  }
  console.log('  A2 armed sweep + no-change-no-render — ok');

  /* A3. Sweep cadence is 125ms while a game is live (~8 sweeps / second).
   * 2026-09-26: was 250ms/~4x — the sweep is the earliest signal that exists
   * (one ~2.4 KB whole-slate status request), so it is where a tighter
   * interval buys the most. */
  {
    const before = calls.reviewStatus;
    await advance(1000);
    const delta = calls.reviewStatus - before;
    assert.ok(delta >= 7 && delta <= 9,
      `live watcher sweeps ~8x/s (got ${delta} in 1000ms)`);
    console.log('  A3 live sweep cadence 125ms — ok');
  }

  /* A4. THE LATENCY FIX: a review flip paints the ticker within one 250ms
   * sweep — not on the next 500ms hydrated-schedule poll — and drops the
   * main poll to its 250ms review cadence. */
  {
    const cardBeforeFlip = registry['#game-list'].children[0];
    slateStatus = () => STATUS_MANAGER_CHALLENGE;
    sweepStatus = () => STATUS_MANAGER_CHALLENGE;
    await advance(250);
    const ticker = collectStrings(registry['#banner']).join('|');
    assert.ok(ticker.includes('ACTIVE REVIEWS'),
      'review ticker is up within one 250ms sweep of the flip');
    assert.ok(ticker.includes('Manager challenge: Tag play'),
      'ticker shows the official detailedState verbatim');
    assert.ok(registry['#game-list'].children[0] !== cardBeforeFlip,
      'cards re-rendered (review badge) from the merged status alone');
    // Main poll cadence dropped to 250ms: ~7-8 schedule polls in 2s vs ~4.
    const before = calls.schedule;
    await advance(2000);
    const delta = calls.schedule - before;
    assert.ok(delta >= 6, `main poll dropped to 250ms while under review (got ${delta} in 2000ms)`);
    console.log('  A4 review flip -> ticker + 250ms main cadence — ok');
  }

  /* A5. Review over: ticker disappears on the next sweep. */
  {
    slateStatus = baseStatus;
    sweepStatus = baseStatus;
    await advance(300);
    assert.equal(collectStrings(registry['#banner']).join('|').includes('ACTIVE REVIEWS'), false,
      'ticker cleared once the status leaves the review code');
    console.log('  A5 review resolution clears the ticker — ok');
  }

  /* A6. Hidden tab: no sweeps at all; showing resumes them. */
  {
    const before = calls.reviewStatus;
    documentStub.hidden = true;
    visibilityCbs.forEach((cb) => cb());
    await advance(2000);
    assert.equal(calls.reviewStatus, before, 'hidden tab sweeps nothing');
    documentStub.hidden = false;
    visibilityCbs.forEach((cb) => cb());
    await advance(300);
    assert.ok(calls.reviewStatus > before, 'showing the tab resumes sweeps');
    console.log('  A6 hidden-tab park + resume — ok');
  }

  /* A7. Idle slate: the watcher backs off to 5s. */
  {
    slateStatus = () => ({ abstractGameState: 'Final', codedGameState: 'F', detailedState: 'Final', statusCode: 'F' });
    sweepStatus = slateStatus;
    await advance(300); // let the flip settle (render to Final)
    const before = calls.reviewStatus;
    await advance(2000);
    assert.equal(calls.reviewStatus, before, 'no live games -> no fast sweeps (5s backoff)');
    await advance(3500);
    assert.equal(calls.reviewStatus, before + 1, 'one idle sweep after ~5s');
    console.log('  A7 idle 5s backoff — ok');
  }

  /* A8. LIVE PUSH for scoring-change badges (2026-09-26). Before this, the
   * badge could only appear on the next slate poll and the shared log was
   * re-fetched on every poll; now the server pushes the entry and the badge
   * lands synchronously with the frame, while the pull stays as a safety net
   * (and returns to its per-poll cadence the moment the stream gives up). */
  {
    assert.equal(FakeEventSource.instances.length, 1,
      'the scoreboard opens exactly one live stream');
    const stream = FakeEventSource.instances[0];
    const streamDate = /\/api\/feed-log\/stream\?date=(\d{4}-\d{2}-\d{2})/.exec(stream.url);
    assert.ok(streamDate, `the stream subscribes to the log endpoint (${stream.url})`);

    // Put the slate back to live so the polls actually run: the checks below
    // are about the pull policy DURING polling, not about an idle slate. The
    // page only learns the slate is live again on its next poll (idle cadence
    // 5s), so wait for that poll and the tightened cadence after it.
    slateStatus = baseStatus;
    sweepStatus = baseStatus;
    await advance(6000);

    const scoringReview = {
      id: 'scoring-9',
      typeKey: 'scoring_change',
      reviewType: 'Official Scoring Change',
      reason: 'Error → Double',
      outcome: 'changed',
      outcomeLabel: 'Rescored',
      atBatIndex: 9,
      batter: { id: 1, fullName: 'Pushed Scorer' },
    };
    const payload = {
      v: 1,
      date: streamDate[1],
      savedAt: 1758914400000,
      entries: [{ gamePk: 823342, review: scoringReview, firstSeen: 1758914400000, lastSeen: 1758914400000 }],
      order: ['823342:scoring-9'],
      snapshots: {}, irregularities: {}, grace: {}, settled: [],
    };

    const before = { ...calls };
    const getsBefore = net.logGets;
    pushFrame(payload);
    const cardText = collectStrings(registry['#game-list']).join('|');
    assert.ok(cardText.includes('Scoring Change'),
      'the pushed scoring change shows on the game card the moment the frame arrives');
    assert.equal(net.logGets, getsBefore, 'and needed no log request');
    assert.equal(calls.schedule, before.schedule, 'and no schedule fetch');
    assert.equal(calls.reviewStatus, before.reviewStatus, 'and no status sweep');

    /* While the stream is live the pull is throttled (a safety net), so a
     * burst of polls must not re-read the log. */
    const getsWithStream = net.logGets;
    const pollsWithStream = calls.schedule;
    await advance(2000);
    assert.ok(calls.schedule > pollsWithStream + 1,
      `the slate is polling again (${calls.schedule - pollsWithStream} polls in 2s)`);
    assert.equal(net.logGets, getsWithStream,
      'with a live stream the log is not re-pulled on every poll');

    /* Stream gives up (endpoint blocked/absent): the handle must be dropped
     * and the pull must return to its per-poll cadence — the push path may
     * never make the page slower when it is unavailable. */
    stream.emit('error');
    stream.emit('error');
    stream.emit('error');
    assert.equal(stream.closed, true, 'the stream gives up after repeated failures');
    const getsAfterClose = net.logGets;
    await advance(2500);
    assert.ok(net.logGets > getsAfterClose,
      `without a stream the log is re-read on the polls again (${net.logGets - getsAfterClose} gets)`);
    console.log('  A8 pushed scoring-change badge + pull fallback — ok');
  }

  console.log('scoreboard status-watcher tests passed\n');
}

/* =====================================================================
 * PART B — game.js (with the REAL reviews.js loaded: registry detection,
 * extractReviews and the live banner are exercised, not stubbed)
 * ===================================================================*/

{
  const ids = ['#main', '#loading', '#countdown', '#status-line', '#refresh-btn',
    '#reviews-tab-count', '#live-review-banner-wrap', '#header-center', '#header-meta',
    '#header-decisions', '#header-away', '#header-home', '#live-panel', '#linescore-wrap',
    '#plays-wrap', '#boxscore-wrap', '#props-wrap', '#reviews-wrap',
    '#panel-plays', '#panel-boxscore', '#panel-props', '#panel-reviews'];
  const registry = {};
  ids.forEach((id) => { registry[id] = makeNode('div'); });

  let domReadyCb = null;
  const visibilityCbs = [];
  const documentStub = {
    hidden: false,
    title: '',
    createElement: (tag) => makeNode(tag),
    querySelector: (sel) => registry[sel] || null,
    querySelectorAll: () => [],
    addEventListener: (ev, cb) => {
      if (ev === 'DOMContentLoaded') domReadyCb = cb;
      if (ev === 'visibilitychange') visibilityCbs.push(cb);
    },
  };

  /* Programmable server state. */
  let feedStatus = baseStatus;          // full feed's gameData.status
  let watchStatus = baseStatus;         // the ~150B projection's status
  const calls = { feed: 0, gameStatus: 0, pbp: 0 };

  const completedPlay = {
    about: { atBatIndex: 17, inning: 5, halfInning: 'top', isComplete: true, hasReview: false, endTime: '2026-09-05T02:00:00Z' },
    result: { type: 'atBat', event: 'Single', eventType: 'single', description: 'Bryan Reynolds singles on a line drive to center fielder Riley Greene.', rbi: 0, awayScore: 3, homeScore: 1, isOut: false },
    count: { balls: 1, strikes: 1, outs: 2 },
    matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
    runners: [],
    playEvents: [{ index: 1, isPitch: true, details: { description: 'In play, no out' } }],
  };
  const currentPlayNoReview = {
    about: { atBatIndex: 18, inning: 6, halfInning: 'bottom', isComplete: false, hasReview: false, startTime: '2026-09-05T02:05:00Z' },
    result: { event: 'Single', eventType: 'single', description: 'Runner is safe at home.', awayScore: 3, homeScore: 1 },
    count: { balls: 1, strikes: 0, outs: 1 },
    matchup: { batter: { id: 665487, fullName: 'Test Batter' }, pitcher: { id: 682227, fullName: 'Test Pitcher' } },
    runners: [{
      movement: { start: '3B', end: 'score', isOut: false },
      details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 2, runner: { id: 2, fullName: 'Slow Game Runner' } },
    }],
    playEvents: [{ index: 2, isPitch: true, details: { description: 'In play, run(s)' } }],
  };
  // reviewDetails shape verified live (games 823341/823342, 2026-08-19).
  const currentPlayUnderReview = {
    ...currentPlayNoReview,
    reviewDetails: { inProgress: true, isOverturned: false, reviewType: 'MA', challengeTeamId: 144 },
  };
  const currentPlayResolved = {
    ...currentPlayNoReview,
    result: { ...currentPlayNoReview.result, description: 'Pirates challenged (tag play), call on the field was overturned: runner out.' },
    reviewDetails: { inProgress: false, isOverturned: true, reviewType: 'MA', challengeTeamId: 144 },
  };

  let currentPlay = currentPlayNoReview;
  // Away runs, mutable so a test can make a parked feed's token differ from
  // the last rendered one (feedToken includes the linescore runs) and thereby
  // force renderAll() to run when it lands.
  let awayRuns = 3;
  // When set, getLiveFeed parks on this deferred (after snapshotting its
  // payload) so a test can hold a cycle in flight.
  let feedGate = null;
  // The play the LEAN probe (getPlayByPlay) reports as currentPlay. Set
  // independently of `currentPlay` so a test can make the probe agree or
  // disagree with the (possibly in-flight, hence stale) full feed — that is
  // how the probe-first banner path is isolated from the feed path.
  let probePlay = null;
  const buildFeed = () => ({
    gamePk: 823342,
    gameData: {
      status: feedStatus(),
      datetime: { dateTime: '2026-09-05T01:40:00Z' },
      venue: { name: 'Comerica Park' },
      teams: {
        away: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET', record: { leagueRecord: { wins: 70, losses: 62 } } },
        home: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT', record: { leagueRecord: { wins: 60, losses: 72 } } },
      },
      players: {},
    },
    liveData: {
      linescore: {
        currentInning: 6, inningState: 'Bottom',
        innings: [{ away: { runs: 1 }, home: { runs: 0 } }],
        teams: { away: { runs: awayRuns }, home: { runs: 1 } },
        balls: 1, strikes: 0, outs: 1,
      },
      boxscore: { teams: {
        away: {
          team: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET' },
          players: { ID695549: { stats: { pitching: { inningsPitched: '5.1', hits: 6, pitchesThrown: 82, strikes: 55 } } } },
        },
        home: {
          team: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
          players: { ID682227: { stats: { pitching: { inningsPitched: '5.0', hits: 9, pitchesThrown: 78, strikes: 50 } } } },
        },
      } },
      decisions: {},
      plays: { allPlays: [completedPlay], currentPlay },
    },
  });

  const MLBStub = {
    ...FORMATTERS,
    getLiveFeed: async () => {
      calls.feed += 1;
      // Captured at REQUEST time: a cycle in flight cannot see a status flip
      // that lands while it is being fetched (feedGate lets a test hold it).
      const payload = buildFeed();
      if (feedGate) await feedGate;
      return payload;
    },
    getGameStatus: async () => {
      calls.gameStatus += 1;
      return { gameData: { status: watchStatus() } };
    },
    getPlayByPlay: async () => {
      calls.pbp += 1;
      return { allPlays: [completedPlay], currentPlay: probePlay || currentPlay };
    },
  };

  const context = {
    console: { warn() {}, error() {}, log() {} },
    Map, Set, Math, Number, String, Object, Array, URLSearchParams, RegExp, JSON, URL,
    // Date.now() follows the FAKE clock: game.js's status-lead grace window
    // (STATUS_LEAD_GRACE_MS) is time-based, and the test must be able to
    // cross it by advancing fake time (real reviews always outlast it).
    Date: class extends Date {
      static now() { return now; }
    },
    CSS: { escape: (s) => s },
    UI: UIStub,
    MLB: MLBStub,
    window: { location: { search: '?gamePk=823342' }, history: { replaceState() {} } },
    document: documentStub,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    setInterval: fakeSetInterval,
    clearInterval: fakeClearInterval,
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(src('assets/js/reviews.js'), context, { filename: 'assets/js/reviews.js' });
  vm.runInContext(src('assets/js/game.js'), context, { filename: 'assets/js/game.js' });

  assert.equal(typeof domReadyCb, 'function', 'game page registers DOMContentLoaded boot');
  domReadyCb();
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  // scheduleNext() arms the watcher as soon as the first full feed lands.
  await advance(250);

  /* B1. Boot: full feed rendered; the watcher is armed and sweeps ~4x/s
   * while the game is live and not under review. No banner. */
  assert.ok(calls.feed >= 1, 'full feed fetched on boot');
  assert.ok(calls.gameStatus >= 1, 'status watcher sweeps on boot (armed by scheduleNext)');
  assert.equal(collectStrings(registry['#live-review-banner-wrap']).join('|').length, 0,
    'no review banner before any review');
  {
    const before = calls.gameStatus;
    await advance(1000);
    const delta = calls.gameStatus - before;
    assert.ok(delta >= 7 && delta <= 9, `watcher sweeps ~8x/s while live (got ${delta} in 1000ms)`);
    console.log('  B1 boot + live watcher cadence 125ms — ok');
  }

  /* B2. THE LATENCY FIX, step 1: MLB flips the official status to MA. Within
   * one 250ms sweep the page (a) paints the official state on the status
   * line from the projection alone, and (b) kicks an OUT-OF-BAND full feed
   * (not the next 500ms cycle). */
  {
    watchStatus = () => STATUS_MANAGER_CHALLENGE;
    const feedsBefore = calls.feed;
    await advance(250);
    const line = registry['#status-line'].text;
    assert.ok(line.includes('🚨'), 'status line flags the review immediately');
    assert.ok(line.includes('Manager challenge: Tag play'),
      'status line shows the official detailedState verbatim');
    assert.ok(calls.feed > feedsBefore,
      'the flip kicked an out-of-band full feed within the same 250ms window');
    console.log('  B2 status flip -> 🚨 line + out-of-band feed — ok');
  }

  /* B3. Step 2: the feed now carries the review (reviewDetails.inProgress).
   * The banner must render, and the page must be on its fast path — the
   * lean playByPlay probe owns the ticks, the watcher stops sweeping. */
  {
    feedStatus = () => STATUS_MANAGER_CHALLENGE;
    currentPlay = currentPlayUnderReview;
    await advance(600);
    const banner = collectStrings(registry['#live-review-banner-wrap']).join('|');
    assert.ok(banner.length > 0, 'live review banner rendered from the authoritative feed');
    const watchBefore = calls.gameStatus;
    const pbpBefore = calls.pbp;
    await advance(1000);
    assert.equal(calls.gameStatus, watchBefore,
      'watcher parks (no sweeps) once the review is known — the lean probe owns updates');
    assert.ok(calls.pbp > pbpBefore, 'lean playByPlay probe ticking at the 250ms cadence');
    assert.ok(calls.feed - 1 <= pbpBefore + 100, 'sanity');
    console.log('  B3 banner + in-review lean probe — ok');
  }

  /* B4. Resolution: the probe sees the reviewDetails flip, pulls one full
   * feed, clears the banner, and — once the 3s status-lead grace has expired
   * (real reviews always outlast it; fake time crosses it here) — the
   * watcher RE-ARMS at 250ms. (watchStatus reverts with the feed: MLB flips
   * the official status back when the review ends.) */
  {
    feedStatus = baseStatus;
    watchStatus = baseStatus;
    currentPlay = currentPlayResolved;
    await advance(600);
    assert.equal(collectStrings(registry['#live-review-banner-wrap']).join('|').length, 0,
      'banner cleared once the review resolved');
    // Cross the status-lead grace window in fake time, then let the watcher's
    // 1s in-review check-in tick see lastActiveReview=false (recomputed on
    // the unchanged-token cycles) and resume fast sweeps.
    await advance(2600);
    const watchBefore = calls.gameStatus;
    await advance(1500);
    assert.ok(calls.gameStatus > watchBefore,
      'watcher re-armed after the review resolved (new-review detection is live again)');
    console.log('  B4 resolution re-arms the watcher — ok');
  }

  /* B5. Hidden tab: no watcher sweeps, no polls; showing resumes. */
  {
    const watchBefore = calls.gameStatus;
    const feedsBefore = calls.feed;
    documentStub.hidden = true;
    visibilityCbs.forEach((cb) => cb());
    await advance(1500);
    assert.equal(calls.gameStatus, watchBefore, 'hidden tab: no status sweeps');
    assert.equal(calls.feed, feedsBefore, 'hidden tab: no feed polls');
    documentStub.hidden = false;
    visibilityCbs.forEach((cb) => cb());
    await advance(300);
    assert.ok(calls.feed > feedsBefore, 'showing the tab reloads');
    console.log('  B5 hidden-tab park + resume — ok');
  }

  /* B6. THE MID-CYCLE FLIP (2026-09-26). If the official status flips to a
   * review state WHILE a full-feed cycle is already in flight, that cycle was
   * requested before the flip and cannot carry the review. The page must run
   * again the instant it finishes — not drop the kick and wait for the next
   * scheduled tick. */
  {
    // Settle back to a live game with no review, and let the watcher re-arm.
    feedStatus = baseStatus;
    watchStatus = baseStatus;
    currentPlay = currentPlayNoReview;
    await advance(4000); // past the 3s status-lead grace of the previous section
    assert.equal(collectStrings(registry['#live-review-banner-wrap']).join('|').length, 0,
      'no review banner before the mid-cycle flip');

    // Park a full-feed cycle: its payload is snapshotted NOW (no review).
    // The lean probe is held on the SAME no-review play, so this section
    // isolates the feed-cycle behaviour; the probe-first banner is section B7.
    probePlay = currentPlayNoReview;
    let releaseFeed = null;
    feedGate = new Promise((r) => { releaseFeed = r; });
    await advance(500); // the cycle starts and parks
    const feedsWhileParked = calls.feed;
    assert.ok(feedsWhileParked > 0, 'a full-feed cycle is in flight');

    // MLB flips the status while that cycle is still in flight, and the feed
    // (once fetched AFTER the flip) carries the review.
    watchStatus = () => STATUS_MANAGER_CHALLENGE;
    currentPlay = currentPlayUnderReview;
    await advance(250); // one watcher sweep sees the flip, mid-cycle

    assert.ok(registry['#status-line'].text.includes('Manager challenge: Tag play'),
      'the flip is painted on the status line even though a cycle is in flight');
    assert.equal(collectStrings(registry['#live-review-banner-wrap']).join('|').length, 0,
      'the in-flight cycle cannot carry the review (it was fetched before the flip)');

    // Release it: the kicked cycle must now run WITHOUT waiting for a tick.
    const feedsBeforeRelease = calls.feed;
    const pbpBeforeRelease = calls.pbp;
    releaseFeed();
    feedGate = null;
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(calls.feed > feedsBeforeRelease || calls.pbp > pbpBeforeRelease,
      'the flip runs a fresh cycle the instant the in-flight one finishes '
      + `(no clock advance: feed ${calls.feed - feedsBeforeRelease}, pbp ${calls.pbp - pbpBeforeRelease})`);
    await advance(300);
    assert.ok(collectStrings(registry['#live-review-banner-wrap']).join('|').length > 0,
      'and the review banner renders from the fresh cycle');
    console.log('  B6 mid-cycle flip re-runs the cycle immediately — ok');
  }

  /* B7. PROBE-FIRST BANNER (2026-09-26). The full feed is 1–2MB; the lean
   * projected playByPlay is ~3KB and carries the same reviewDetails markers
   * the banner is built from. On a status flip the page must therefore paint
   * the banner from the PROBE — while the full feed is still downloading —
   * instead of waiting for it. The full feed is held on a deferred here, so
   * any banner that appears can only have come from the probe. */
  {
    // Settle back to a live game with no review, past the grace window of the
    // previous section, and make both sources agree there is no review.
    feedStatus = baseStatus;
    watchStatus = baseStatus;
    currentPlay = currentPlayNoReview;
    probePlay = currentPlayNoReview;
    await advance(4000);
    assert.equal(collectStrings(registry['#live-review-banner-wrap']).join('|').length, 0,
      'no review banner before the probe-path flip');

    // Hold the next full feed on a deferred; the probe answers WITH the review.
    // The parked payload is a real CHANGE (the score moved), so when it lands
    // renderAll() really runs — that is what makes the no-flap assertion below
    // capable of failing (with a token-identical payload renderAll would be
    // skipped and the assertion would be vacuous).
    awayRuns = 4;
    let releaseFeed = null;
    feedGate = new Promise((r) => { releaseFeed = r; });
    probePlay = currentPlayUnderReview;
    watchStatus = () => STATUS_MANAGER_CHALLENGE;
    const pbpBefore = calls.pbp;
    const feedsBefore = calls.feed;

    await advance(150); // one 125ms sweep sees the flip
    for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r));

    assert.ok(calls.pbp > pbpBefore, 'the flip asked the LEAN endpoint about the play');
    assert.ok(calls.feed > feedsBefore, 'and the out-of-band full feed is in flight');
    const probeBanner = collectStrings(registry['#live-review-banner-wrap']).join('|');
    assert.ok(probeBanner.length > 0,
      'the banner is painted from the lean probe while the 1-2MB feed is still in flight');

    // Release the STALE feed (payload snapshotted before the flip, so it does
    // not carry the review): the probe-painted banner must survive it — the
    // two writers must not flap it off screen during the status-lead window.
    releaseFeed();
    feedGate = null;
    await advance(300);
    assert.ok(collectStrings(registry['#live-review-banner-wrap']).join('|').length > 0,
      'the banner survives the stale in-flight feed landing (no flap)');

    // Once the authoritative feed carries the review it simply keeps it.
    currentPlay = currentPlayUnderReview;
    await advance(600);
    assert.ok(collectStrings(registry['#live-review-banner-wrap']).join('|').length > 0,
      'the authoritative feed keeps the banner up');
    probePlay = null;
    console.log('  B7 probe-first banner while the full feed is in flight — ok');
  }

  console.log('game page status-watcher tests passed');
}
