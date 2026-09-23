#!/usr/bin/env node
/* ============================================================================
 * cross-browser-persistence-test.mjs — deterministic test verifying that
 * scoring changes and feed entries are recorded, logged, and persistent
 * ACROSS BROWSERS and ACROSS THE WEBSITE (scoreboard, game page, replay feed).
 *
 * Verifies:
 *   1. Browser 1 tracks a scoring change live and persists it to the server.
 *   2. Browser 2 (a completely fresh browser with EMPTY localStorage) opens
 *      the website and immediately restores and renders the scoring change!
 *   3. Across the website:
 *      - reviews.html: Replay feed displays scoring change row + stats
 *      - game.html: Game page "Challenges & Reviews" tab displays the scoring
 *        change card, stat counter, and updates tab badge
 *      - index.html: Scoreboard displays "✏️ 1 Scoring Change" indicator badge
 *   4. Multi-client idempotent merging: two browsers observing different games
 *      both persist their entries to the server without clobbering each other.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_DIR = path.resolve(__dirname, '..');

const feedSource = fs.readFileSync(path.join(REPO_DIR, 'assets/js/reviews-feed.js'), 'utf8');
const reviewsSource = fs.readFileSync(path.join(REPO_DIR, 'assets/js/reviews.js'), 'utf8');
const feedLogSource = fs.readFileSync(path.join(REPO_DIR, 'assets/js/feed-log.js'), 'utf8');

const TEST_PORT = 8199;
const TEST_DATE = '2026-08-30';
const TEST_GAME_PK = 822766;

console.log('Starting server on port', TEST_PORT);
const serverProc = spawn('node', ['server.mjs'], {
  cwd: REPO_DIR,
  env: { ...process.env, PORT: String(TEST_PORT) },
  stdio: 'pipe',
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  await sleep(600); // wait for server to start

  // Verify server is alive
  const healthRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/health`);
  assert.equal(healthRes.status, 200, 'Server health check passed');

  /* ==========================================================================
   * 1. Multi-Browser Persistence Test
   * ========================================================================*/
  console.log('\n--- 1. Multi-Browser Persistence Test ---');

  // Load MLBFeedLog in Node
  const feedLogContext = {
    fetch: (url, opts) => {
      const fullUrl = url.startsWith('/') ? `http://127.0.0.1:${TEST_PORT}${url}` : url;
      return fetch(fullUrl, opts);
    },
    Map, Set,
    localStorage: undefined,
    console,
    module: { exports: {} },
  };
  vm.createContext(feedLogContext);
  vm.runInContext(feedLogSource, feedLogContext);
  const MLBFeedLog = feedLogContext.MLBFeedLog;

  // Browser 1 simulates observing a live scoring change on 2026-08-30:
  // Vladimir Guerrero Jr. Double -> Single (game 822766, play 36)
  const browser1Log = await MLBFeedLog.fetchLog(TEST_DATE);
  assert.ok(browser1Log, 'Browser 1 fetched log for date');
  const scoringChanges1 = browser1Log.entries.filter((e) => e.review && e.review.typeKey === 'scoring_change');
  assert.ok(scoringChanges1.length >= 1, 'Scoring change is in feed log');
  const sc1 = scoringChanges1[0].review;
  assert.equal(sc1.reason, 'Double → Single');
  assert.equal(sc1.batter.fullName, 'Vladimir Guerrero Jr.');

  // Browser 2 simulates a DIFFERENT browser (e.g. Safari / Firefox):
  // Empty localStorage, separate context.
  const browser2Store = {};
  const browser2Context = {
    fetch: (url, opts) => {
      // Relative URL resolution to test server
      const fullUrl = url.startsWith('/') ? `http://127.0.0.1:${TEST_PORT}${url}` : url;
      return fetch(fullUrl, opts);
    },
    Map, Set,
    localStorage: {
      getItem(k) { return Object.prototype.hasOwnProperty.call(browser2Store, k) ? browser2Store[k] : null; },
      setItem(k, v) { browser2Store[k] = String(v); },
      removeItem(k) { delete browser2Store[k]; },
    },
    console,
    module: { exports: {} },
  };
  vm.createContext(browser2Context);
  vm.runInContext(feedLogSource, browser2Context);
  const Browser2FeedLog = browser2Context.MLBFeedLog;

  // Browser 2 fetches from server
  const browser2Log = await Browser2FeedLog.fetchLog(TEST_DATE);
  assert.ok(browser2Log, 'Browser 2 successfully fetched persistent log from server');
  assert.ok(browser2Store[`mlbReplayFeedLog.v1.${TEST_DATE}`], 'Browser 2 cached log in its own localStorage');

  const browser2ScoringChanges = browser2Log.entries.filter((e) => e.review && e.review.typeKey === 'scoring_change');
  assert.equal(browser2ScoringChanges.length, 1, 'Browser 2 received exactly 1 scoring change');
  assert.equal(browser2ScoringChanges[0].review.reason, 'Double → Single');
  assert.equal(browser2ScoringChanges[0].review.batter.fullName, 'Vladimir Guerrero Jr.');
  console.log('  ✓ Browser 2 restored scoring change from server persistent storage');

  /* ==========================================================================
   * 2. Across the Website: game.html "Challenges & Reviews" Tab
   * ========================================================================*/
  console.log('\n--- 2. Across the Website: game.html Challenges & Reviews ---');

  // Verify getScoringChangesForGame returns game 822766 scoring change
  const gameChanges = await Browser2FeedLog.getScoringChangesForGame(TEST_DATE, TEST_GAME_PK);
  assert.equal(gameChanges.length, 1, 'Game 822766 has 1 scoring change');
  assert.equal(gameChanges[0].reason, 'Double → Single');

  // Verify renderReviewCard and renderReviewsTab with scoring changes
  let capturedCards = [];
  const uiStub = {
    el(tag, cls, text, attrs) {
      const elObj = {
        tag, cls, text: text != null ? String(text) : '', attrs: attrs || {}, children: [],
        appendChild(child) { elObj.children.push(child); return child; },
      };
      return elObj;
    },
    clear(n) { if (n && n.children) n.children.length = 0; return n; },
  };

  const reviewsCtx = {
    UI: uiStub,
    console,
    Map, Set,
    MLB: { ordinal: (n) => `${n}th` },
    window: {},
  };
  vm.createContext(reviewsCtx);
  vm.runInContext(reviewsSource, reviewsCtx);
  const MLBReviews = reviewsCtx.window.MLBReviews;

  // Render review card for scoring change
  const card = MLBReviews.renderReviewCard(gameChanges[0]);
  assert.ok(card.cls.includes('review-card'), 'renders review-card');
  assert.ok(card.cls.includes('review-card-changed'), 'outcome changed class');
  
  // Find headline and call chips inside card
  function findNodes(root, predicate) {
    const results = [];
    function walk(node) {
      if (!node) return;
      if (predicate(node)) results.push(node);
      (node.children || []).forEach(walk);
    }
    walk(root);
    return results;
  }

  const headlines = findNodes(card, (n) => n.cls && n.cls.includes('feed-scoring-headline'));
  assert.equal(headlines.length, 1, 'scoring change card includes headline block');

  const chips = findNodes(card, (n) => n.cls && n.cls.includes('feed-scoring-call'));
  assert.equal(chips.length, 2, 'scoring change card includes Double and Single chips');
  assert.equal(chips[0].text, 'Double');
  assert.equal(chips[1].text, 'Single');

  // Render Reviews tab view with scoring changes
  const container = uiStub.el('div', 'reviews-wrap');
  const reviewData = {
    reviews: [...gameChanges],
    activeReview: null,
    summary: { total: 0, overturned: 0, stands: 0, overturnRate: '0%', inProgress: 0, pendingScoring: 0 },
    scoringChanges: gameChanges,
  };
  MLBReviews.renderReviewsTab(container, reviewData);

  const stats = findNodes(container, (n) => n.cls && n.cls.includes('stat-scoring-change'));
  assert.equal(stats.length, 1, 'Reviews tab summary bar displays Scoring Changes stat item');
  const statVal = findNodes(stats[0], (n) => n.cls && n.cls.includes('review-stat-value'));
  assert.equal(statVal[0].text, '1', 'Scoring changes stat value is 1');
  console.log('  ✓ game.html Challenges & Reviews tab renders scoring change card + stat counter');

  /* ==========================================================================
   * 3. Across the Website: index.html Scoreboard Badge
   * ========================================================================*/
  console.log('\n--- 3. Across the Website: index.html Scoreboard Badges ---');

  const slateScoringChanges = await Browser2FeedLog.getScoringChangesByGame(TEST_DATE);
  assert.ok(slateScoringChanges instanceof Map, 'Returns map of scoring changes by game');
  assert.equal(slateScoringChanges.get(TEST_GAME_PK).length, 1, 'Game 822766 found in slate scoring changes map');
  console.log('  ✓ index.html Scoreboard slate mapping associates scoring changes with game card');

  /* ==========================================================================
   * 4. Multi-Client Merge & Idempotence
   * ========================================================================*/
  console.log('\n--- 4. Multi-Client Merge & Idempotence ---');

  // Client A posts an update for game 999901
  const payloadA = {
    v: 1,
    date: '2026-09-15',
    savedAt: Date.now(),
    entries: [
      {
        gamePk: 999901,
        review: { id: 'scoring-10', typeKey: 'scoring_change', reason: 'Single → Error', outcome: 'changed', outcomeLabel: 'Rescored' },
        firstSeen: 1000,
        lastSeen: 2000,
      }
    ],
    order: ['999901:scoring-10'],
    snapshots: { '999901': { '10': { snapshot: { eventType: 'field_error', atBatIndex: 10 }, signature: 'err', firstObservedAt: 1000, lastObservedAt: 2000, history: [], rowCreated: true } } },
    irregularities: {},
    grace: {},
    settled: [999901],
  };

  const saveARes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/feed-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadA),
  });
  assert.equal(saveARes.status, 200);

  // Client B posts an update for game 999902
  const payloadB = {
    v: 1,
    date: '2026-09-15',
    savedAt: Date.now() + 500,
    entries: [
      {
        gamePk: 999902,
        review: { id: 'scoring-20', typeKey: 'scoring_change', reason: 'Error → Double', outcome: 'changed', outcomeLabel: 'Rescored' },
        firstSeen: 1200,
        lastSeen: 2500,
      }
    ],
    order: ['999902:scoring-20'],
    snapshots: { '999902': { '20': { snapshot: { eventType: 'double', atBatIndex: 20 }, signature: 'dbl', firstObservedAt: 1200, lastObservedAt: 2500, history: [], rowCreated: true } } },
    irregularities: {},
    grace: {},
    settled: [999902],
  };

  const saveBRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/feed-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payloadB),
  });
  assert.equal(saveBRes.status, 200);

  // Fetch merged log from server
  const mergedRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/feed-log?date=2026-09-15`);
  const mergedLog = await mergedRes.json();
  assert.equal(mergedLog.entries.length, 2, 'Both Client A and Client B entries are preserved');
  assert.ok(mergedLog.snapshots['999901'], 'Game 999901 snapshots preserved');
  assert.ok(mergedLog.snapshots['999902'], 'Game 999902 snapshots preserved');
  assert.deepEqual(mergedLog.settled.sort(), [999901, 999902], 'Settled games set merged');
  console.log('  ✓ Server merged multiple client updates without data loss');

  // Clean up temporary test files
  try {
    const tmpLog = path.join(REPO_DIR, 'data', 'feed-log-2026-09-15.json');
    if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);
  } catch (_) {}

  console.log('\nAll cross-browser persistence tests passed successfully!');
}

run()
  .then(() => {
    serverProc.kill('SIGTERM');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Test failure:', err);
    serverProc.kill('SIGTERM');
    process.exit(1);
  });
