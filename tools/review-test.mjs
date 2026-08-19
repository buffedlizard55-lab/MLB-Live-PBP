#!/usr/bin/env node
/* ============================================================================
 * review-test.mjs — deterministic test suite for MLB replay reviews, manager
 * challenges, crew chief reviews, and ABS (Automated Ball-Strike) challenges.
 *
 * Run: node tools/review-test.mjs
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/reviews.js', import.meta.url), 'utf8');
const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Math, Number, String, Object, Array,
  MLB: {
    ordinal: (n) => `${n}${['th','st','nd','rd','th','th','th','th','th','th'][n%10] || 'th'}`,
  },
  UI: {
    el: (tag, cls, text) => ({ tag, cls, text, children: [], appendChild(c) { this.children.push(c); return c; } }),
    clear: (node) => { if (node) node.children = []; return node; },
  },
  window: {},
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'assets/js/reviews.js' });

const MLBReviews = context.MLBReviews || context.window.MLBReviews;
assert.ok(MLBReviews, 'MLBReviews module should load');

/* -------------------------------------------------- 1. Normalization tests */

assert.equal(MLBReviews.normalizeType('Manager Challenge', '').key, 'manager');
assert.equal(MLBReviews.normalizeType('Crew Chief Review', '').key, 'crew_chief');
assert.equal(MLBReviews.normalizeType('ABS Challenge', '').key, 'abs');
assert.equal(MLBReviews.normalizeType('Automated Ball-Strike System', '').key, 'abs');
assert.equal(MLBReviews.normalizeType('Umpire Review', '').key, 'crew_chief');

/* Real reviewType codes observed on statsapi.mlb.com (2026-08-19):
 *   MJ = ABS pitch challenge (games 823342, 823667, 824075)
 *   MA = manager challenge (game 823341, "Tigers challenged (tag play)…")
 *   MF = manager challenge (game 824075, "Royals challenged (play at 1st)…") */
assert.equal(MLBReviews.normalizeType('MJ', 'Ball').key, 'abs');
assert.equal(MLBReviews.normalizeType('MJ', 'Called Strike').label, 'ABS Challenge');
assert.equal(MLBReviews.normalizeType('MJ', 'challenged (pitch result), call on the field was overturned').key, 'abs');
assert.equal(MLBReviews.normalizeType('MA', 'Tigers challenged (tag play), call on the field was overturned').key, 'manager');
assert.equal(MLBReviews.normalizeType('MF', 'Royals challenged (play at 1st), call on the field was overturned').key, 'manager');
// Unknown codes must NOT be surfaced raw to users.
assert.equal(MLBReviews.normalizeType('ZZ', 'Something happened').label, 'Replay Review');

/* -------------------------------------------------- 2. Outcome determination */

assert.equal(MLBReviews.determineOutcome({ isOverturned: true }, '').key, 'overturned');
assert.equal(MLBReviews.determineOutcome({ isOverturned: false }, '').key, 'stands');
assert.equal(MLBReviews.determineOutcome({ inProgress: true }, '').key, 'in_progress');
assert.equal(MLBReviews.determineOutcome(null, 'Call was overturned after manager challenge.').key, 'overturned');
assert.equal(MLBReviews.determineOutcome(null, 'Call stands after crew chief review.').key, 'stands');
assert.equal(MLBReviews.determineOutcome(null, 'Call confirmed on the field.').key, 'confirmed');

/* -------------------------------------------------- 3. Feed Extraction Tests */

const sampleFeed = {
  gameData: {
    status: { detailedState: 'In Progress', abstractGameState: 'Live' },
    teams: {
      away: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
      home: { id: 111, name: 'Boston Red Sox', abbreviation: 'BOS' },
    },
  },
  liveData: {
    plays: {
      allPlays: [
        // Play 1: Standard Manager Challenge (Overturned)
        {
          about: { atBatIndex: 12, inning: 3, halfInning: 'top', hasReview: true, isComplete: true },
          result: { description: 'Aaron Judge singles. Juan Soto challenged (tag play at 2nd base): Call was overturned.' },
          matchup: {
            batter: { id: 592450, fullName: 'Aaron Judge' },
            pitcher: { id: 656302, fullName: 'Brayan Bello' },
          },
          reviewDetails: {
            reviewType: 'Manager Challenge',
            isOverturned: true,
            challengeTeamId: 147,
          },
          playEvents: [
            { isPitch: true, details: { description: 'Ball' } },
            {
              isPitch: false,
              details: { description: 'Manager challenge (tag play at 2nd base): Call was overturned to safe.', hasReview: true, eventType: 'review' },
              reviewDetails: { reviewType: 'Manager Challenge', isOverturned: true, challengeTeamId: 147 },
            },
          ],
        },
        // Play 2: ABS Challenge on a Pitch
        {
          about: { atBatIndex: 25, inning: 6, halfInning: 'bottom', hasReview: true, isComplete: true },
          result: { description: 'Rafael Devers strikes out swinging.' },
          matchup: {
            batter: { id: 646240, fullName: 'Rafael Devers' },
            pitcher: { id: 543037, fullName: 'Gerrit Cole' },
          },
          playEvents: [
            {
              isPitch: true,
              pitchData: { startSpeed: 98.4 },
              details: {
                description: 'Called Strike. ABS Challenge: Ball called strike overturned to ball.',
                hasReview: true,
                call: { code: 'B', description: 'Ball' },
              },
              reviewDetails: {
                reviewType: 'ABS Challenge',
                isOverturned: true,
              },
            },
          ],
        },
        // Play 3: Crew Chief Review (Call Stands)
        {
          about: { atBatIndex: 32, inning: 8, halfInning: 'top', hasReview: true, isComplete: true },
          result: { description: 'Giancarlo Stanton flies out to deep left. Crew chief review (home run): Call stands.' },
          matchup: {
            batter: { id: 519317, fullName: 'Giancarlo Stanton' },
            pitcher: { id: 622065, fullName: 'Kenley Jansen' },
          },
          reviewDetails: {
            reviewType: 'Crew Chief Review',
            isOverturned: false,
          },
        },
      ],
      currentPlay: {
        about: { atBatIndex: 40, inning: 9, halfInning: 'bottom', isComplete: false },
        result: { description: 'Play at 1st base is under review.' },
        matchup: {
          batter: { id: 677951, fullName: 'Triston Casas' },
          pitcher: { id: 641793, fullName: 'Clay Holmes' },
        },
        reviewDetails: {
          reviewType: 'Manager Challenge',
          inProgress: true,
          challengeTeamId: 111,
        },
        playEvents: [],
      },
    },
  },
};

const extracted = MLBReviews.extractReviews(sampleFeed);
assert.equal(extracted.reviews.length, 4, 'should extract all 4 review events');
assert.ok(extracted.activeReview, 'should identify the in-progress review on current play');
assert.equal(extracted.activeReview.reviewType, 'Manager Challenge');
assert.equal(extracted.activeReview.inProgress, true);
assert.equal(extracted.activeReview.teamAbbrev, 'BOS');

assert.equal(extracted.summary.total, 4);
assert.equal(extracted.summary.overturned, 2); // Judge tag overturned, ABS pitch overturned
assert.equal(extracted.summary.stands, 1);     // Stanton HR check stands
assert.equal(extracted.summary.inProgress, 1); // Casas review in progress

assert.equal(extracted.summary.byType.manager, 2);
assert.equal(extracted.summary.byType.abs, 1);
assert.equal(extracted.summary.byType.crew_chief, 1);

/* --------------------------------------- 3b. Real feed shapes (2026-08-19) */

// Game 823341 atBatIndex 34 — play-level manager challenge, reviewType "MA".
const maPlay = {
  about: { atBatIndex: 34, inning: 6, halfInning: 'bottom', hasReview: false },
  result: {
    description: "Tigers challenged (tag play), call on the field was overturned: Jared Triolo reaches on a fielder's choice out, third baseman Kevin McGonigle to catcher Eduardo Valencia. Jake Mangum out at home. Rafael Flores Jr. to 3rd.",
  },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MA', challengeTeamId: 116 },
  matchup: { batter: { id: 663757, fullName: 'Trent Grisham' }, pitcher: { id: 656302, fullName: 'Dylan Cease' } },
};

// Game 823342 atBatIndex 15 — event-level ABS challenge, reviewType "MJ",
// bare "Ball" description, no review text on the play itself.
const absEventPlay = {
  about: { atBatIndex: 15, inning: 2, halfInning: 'bottom', hasReview: false },
  result: { description: 'Jared Triolo grounds out, third baseman Hao-Yu Lee to first baseman Spencer Torkelson.' },
  matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
  playEvents: [
    { isPitch: true, details: { description: 'Ball', hasReview: true }, reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 116 } },
  ],
};

// Game 824075 atBatIndex 33 — play-level ABS challenge, reviewType "MJ",
// WITH pitch-result text, plus a duplicate event-level entry that must lose.
const absPlayLevel = {
  about: { atBatIndex: 33, inning: 5, halfInning: 'bottom', hasReview: false },
  result: {
    description: 'Michael Massey challenged (pitch result), call on the field was overturned: Michael Massey walks.',
  },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 118 },
  matchup: { batter: { id: 621020, fullName: 'Michael Massey' }, pitcher: { id: 660787, fullName: 'Yerry De los Santos' } },
  playEvents: [
    { isPitch: true, details: { description: 'Ball', hasReview: true }, reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 118 } },
  ],
};

// Same play can carry BOTH an ABS pitch challenge (event-level MJ) and a
// play-level manager challenge (MA) — both must survive as separate entries.
const dualPlay = {
  about: { atBatIndex: 40, inning: 8, halfInning: 'top', hasReview: false },
  result: { description: 'Royals challenged (play at 1st), call on the field was overturned: runner is safe.' },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MF', challengeTeamId: 118 },
  matchup: { batter: { id: 592450, fullName: 'Aaron Judge' }, pitcher: { id: 656302, fullName: 'Dylan Cease' } },
  playEvents: [
    { isPitch: true, details: { description: 'Called Strike', hasReview: true }, reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 111 } },
  ],
};

const realFeed = {
  gameData: {
    status: { detailedState: 'In Progress', abstractGameState: 'Live' },
    teams: {
      away: { id: 116, name: 'Detroit Tigers', abbreviation: 'DET' },
      home: { id: 134, name: 'Pittsburgh Pirates', abbreviation: 'PIT' },
    },
  },
  liveData: {
    plays: { allPlays: [maPlay, absEventPlay, absPlayLevel, dualPlay], currentPlay: null },
  },
};

const realExtracted = MLBReviews.extractReviews(realFeed);
// MA(34) + MJ-event(15) + MJ-play(33) + MF-play(40) + MJ-event(40) = 5 entries
assert.equal(realExtracted.reviews.length, 5, 'MA + ABS(event) + ABS(play) + dual(MF+MJ) = 5 entries');

const byAtBat = (idx) => realExtracted.reviews.filter((r) => r.atBatIndex === idx);

// MA play-level → Manager Challenge with team + rich reason.
const ma = byAtBat(34)[0];
assert.equal(ma.reviewType, 'Manager Challenge');
assert.equal(ma.typeKey, 'manager');
assert.equal(ma.teamAbbrev, 'DET');
assert.equal(ma.outcome, 'overturned');
assert.equal(ma.reason, 'tag play');

// Event-level MJ → ABS Challenge, NOT the raw "MJ" code.
const evAbs = byAtBat(15)[0];
assert.equal(evAbs.reviewType, 'ABS Challenge');
assert.equal(evAbs.typeKey, 'abs');
assert.equal(evAbs.teamAbbrev, 'DET');
assert.equal(evAbs.outcome, 'stands'); // isOverturned:false
assert.equal(evAbs.inProgress, false);

// Play-level MJ with text → ABS Challenge, play-level entry wins (rich text).
const plAbs = byAtBat(33);
assert.equal(plAbs.length, 1, 'event + play-level MJ dedupe to one entry');
assert.equal(plAbs[0].description, absPlayLevel.result.description);
assert.equal(plAbs[0].reason, 'pitch result');

// Dual play → both ABS (MJ) and Manager (MF) entries survive.
const dual = byAtBat(40);
assert.equal(dual.length, 2, 'ABS + manager on same play are separate entries');
assert.ok(dual.some((r) => r.typeKey === 'abs'), 'has ABS entry');
assert.ok(dual.some((r) => r.typeKey === 'manager'), 'has manager entry');

// Summary counts match.
assert.equal(realExtracted.summary.total, 5);
assert.equal(realExtracted.summary.overturned, 3); // MA(34) + MJ-play(33) + MF(40)
assert.equal(realExtracted.summary.stands, 2);     // MJ-event(15,40) both stood
assert.equal(realExtracted.summary.byType.abs, 3);
assert.equal(realExtracted.summary.byType.manager, 2);

/* -------------------------------------------------- 4. Scoreboard Inspection */

const schedGameReview = {
  status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' },
};
const schedGameNormal = {
  status: { detailedState: 'In Progress', abstractGameState: 'Live' },
};
assert.equal(MLBReviews.inspectScheduleGame(schedGameReview).hasActiveReview, true);
assert.equal(MLBReviews.inspectScheduleGame(schedGameNormal).hasActiveReview, false);

console.log('MLBReviews tests passed successfully!');
