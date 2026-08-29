#!/usr/bin/env node
/* ============================================================================
 * review-probe-test.mjs — sanity checks for the in-review probe signature in
 * game.js (reviewProbeState).
 *
 * game.js is a browser IIFE, so this test extracts the function source from
 * the file (same "pure helper" spirit as the reviews-feed tests) and runs it
 * against synthetic playByPlay payloads shaped exactly like the verified
 * statsapi.mlb.com /playByPlay responses.
 *
 * Run:  node tools/review-probe-test.mjs
 * ==========================================================================*/
import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'assets', 'js', 'game.js'), 'utf8');

const start = src.indexOf('function reviewProbeState(');
assert.ok(start >= 0, 'reviewProbeState exists in game.js');
// Extract the balanced function body.
let depth = 0;
let end = -1;
for (let i = src.indexOf('{', start); i < src.length; i += 1) {
  if (src[i] === '{') depth += 1;
  if (src[i] === '}') depth -= 1;
  if (depth === 0) { end = i + 1; break; }
}
assert.ok(end > start, 'extracted balanced reviewProbeState body');
// eslint-disable-next-line no-eval
const reviewProbeState = new Function(`"use strict"; return (${src.slice(start, end)});`)();

/* fixtures — field paths mirror the live /playByPlay shape */
const pitch = (idx, reviewDetails, hasReview) => ({
  index: idx,
  isPitch: true,
  details: { description: 'Called Strike', hasReview: hasReview !== undefined ? hasReview : false },
  ...(reviewDetails ? { reviewDetails } : {}),
});

const noReview = {
  allPlays: [{
    about: { atBatIndex: 0, hasReview: false },
    playEvents: [pitch(1, null), pitch(2, null)],
  }],
  currentPlay: {
    about: { atBatIndex: 1, hasReview: false },
    playEvents: [pitch(3, null)],
  },
};

/* 1. No review anywhere: not in progress, stable signature. */
{
  const a = reviewProbeState(noReview);
  const b = reviewProbeState(noReview);
  assert.equal(a.hasInProgress, false);
  assert.equal(a.sig, b.sig, 'identical payloads -> identical sig');
}

/* 2. ABS pitch challenge in progress (event-level MJ reviewDetails). */
{
  const active = JSON.parse(JSON.stringify(noReview));
  active.allPlays[0].playEvents[1].reviewDetails = { inProgress: true, reviewType: 'MJ' };
  const a = reviewProbeState(active);
  assert.equal(a.hasInProgress, true, 'in-progress event review detected');
  assert.notEqual(a.sig, reviewProbeState(noReview).sig, 'sig moves when review starts');

  /* 3. The review resolves (overturned) -> no longer in progress, sig moves. */
  const resolved = JSON.parse(JSON.stringify(active));
  resolved.allPlays[0].playEvents[1].reviewDetails = { inProgress: false, isOverturned: true, reviewType: 'MJ' };
  const b = reviewProbeState(resolved);
  assert.equal(b.hasInProgress, false, 'resolved review no longer in progress');
  assert.notEqual(b.sig, a.sig, 'sig moves when the outcome flips');
}

/* 4. Play-level manager challenge in progress (MA). */
{
  const active = JSON.parse(JSON.stringify(noReview));
  active.currentPlay.reviewDetails = { inProgress: true, reviewType: 'MA' };
  const a = reviewProbeState(active);
  assert.equal(a.hasInProgress, true, 'in-progress play-level review detected');
  const resolved = JSON.parse(JSON.stringify(active));
  resolved.currentPlay.reviewDetails = { inProgress: false, isOverturned: false, reviewType: 'MA' };
  assert.equal(reviewProbeState(resolved).hasInProgress, false);
  assert.notEqual(reviewProbeState(resolved).sig, a.sig);
}

/* 5. details.hasReview without reviewDetails (boundary NH arrives later):
 *    not "in progress" for the gate, but the hasReview flag is in the sig so
 *    a later reviewDetails still moves the signature. */
{
  const flagged = JSON.parse(JSON.stringify(noReview));
  flagged.allPlays[0].playEvents[1].details.hasReview = true;
  const a = reviewProbeState(flagged);
  assert.equal(a.hasInProgress, false, 'hasReview alone is not in-progress');
  assert.notEqual(a.sig, reviewProbeState(noReview).sig, 'hasReview flag changes the sig');
  const withDetails = JSON.parse(JSON.stringify(flagged));
  withDetails.allPlays[0].playEvents[1].reviewDetails = { inProgress: true, reviewType: 'NH' };
  const b = reviewProbeState(withDetails);
  assert.equal(b.hasInProgress, true, 'NH boundary review detected once reviewDetails lands');
  assert.notEqual(b.sig, a.sig);
}

/* 6. Malformed / missing input never throws. */
{
  assert.equal(reviewProbeState(null).hasInProgress, false);
  assert.equal(reviewProbeState({}).hasInProgress, false);
  assert.equal(reviewProbeState({ allPlays: [null, undefined], currentPlay: null }).hasInProgress, false);
}

console.log('reviewProbeState tests passed successfully!');
