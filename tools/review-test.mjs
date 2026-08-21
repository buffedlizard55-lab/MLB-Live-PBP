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
 *   MF = manager challenge (game 824075, "Royals challenged (play at 1st)…")
 *   NH = boundary-call review, crew-chief-initiated potential home run /
 *        fair-foul at the wall (game 824801, atBatIndex 57: Alonso's foul
 *        ball down the line, call stands after review) */
assert.equal(MLBReviews.normalizeType('MJ', 'Ball').key, 'abs');
assert.equal(MLBReviews.normalizeType('MJ', 'Called Strike').label, 'ABS Challenge');
assert.equal(MLBReviews.normalizeType('MJ', 'challenged (pitch result), call on the field was overturned').key, 'abs');
assert.equal(MLBReviews.normalizeType('MA', 'Tigers challenged (tag play), call on the field was overturned').key, 'manager');
assert.equal(MLBReviews.normalizeType('MF', 'Royals challenged (play at 1st), call on the field was overturned').key, 'manager');
assert.equal(MLBReviews.normalizeType('NH', 'Foul').key, 'boundary');
assert.equal(MLBReviews.normalizeType('NH', 'Foul').label, 'Boundary Call');
// A bare "Foul" description only means a ball/strike topic for an ABS (MJ)
// review — for a boundary (NH) review it is the boundary-call category.
assert.equal(MLBReviews.extractReason('Foul'), 'Ball / Strike Call (ABS)');
assert.equal(MLBReviews.extractReason('Foul', 'boundary'), 'Home Run / Boundary Call');
assert.equal(MLBReviews.extractReason('Foul', 'abs'), 'Ball / Strike Call (ABS)');
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
  count: { balls: 1, strikes: 2, outs: 1 },
  matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
  playEvents: [
    {
      isPitch: true,
      count: { balls: 1, strikes: 0 },
      details: { description: 'Ball', hasReview: true },
      reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 116 },
    },
  ],
};

// Game 824075 atBatIndex 33 — play-level ABS challenge, reviewType "MJ",
// WITH pitch-result text, plus a duplicate event-level entry that must lose.
const absPlayLevel = {
  about: { atBatIndex: 33, inning: 5, halfInning: 'bottom', hasReview: false },
  result: {
    description: 'Michael Massey challenged (pitch result), call on the field was overturned: Michael Massey walks.',
  },
  count: { balls: 4, strikes: 2, outs: 1 },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 118 },
  matchup: { batter: { id: 621020, fullName: 'Michael Massey' }, pitcher: { id: 660787, fullName: 'Yerry De los Santos' } },
  playEvents: [
    { isPitch: true, count: { balls: 1, strikes: 0 } },
    { isPitch: true, count: { balls: 2, strikes: 0 } },
    { isPitch: true, count: { balls: 2, strikes: 1 } },
    { isPitch: true, count: { balls: 3, strikes: 1 } },
    { isPitch: true, count: { balls: 3, strikes: 2 } },
    {
      isPitch: true,
      count: { balls: 4, strikes: 2 },
      details: { description: 'Ball', hasReview: true },
      reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 118 },
    },
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
// First pitch of the PA → 0-0 before; event.count is AFTER the pitch (GUMBO).
assert.equal(evAbs.countBefore.balls, 0);
assert.equal(evAbs.countBefore.strikes, 0);
assert.equal(evAbs.countAfter.balls, 1);
assert.equal(evAbs.countAfter.strikes, 0);
// Bottom inning, DET (away) challenged → fielding side = catcher or pitcher.
assert.equal(evAbs.challenger.role, 'defense');
assert.equal(evAbs.challenger.label, 'Catcher or pitcher');

// Play-level MJ with text → ABS Challenge, play-level entry wins (rich text).
const plAbs = byAtBat(33);
assert.equal(plAbs.length, 1, 'event + play-level MJ dedupe to one entry');
assert.equal(plAbs[0].description, absPlayLevel.result.description);
assert.equal(plAbs[0].reason, 'pitch result');
assert.equal(plAbs[0].countBefore.balls, 3);
assert.equal(plAbs[0].countBefore.strikes, 2);
assert.equal(plAbs[0].countAfter.balls, 4);
assert.equal(plAbs[0].countAfter.strikes, 2);
assert.equal(plAbs[0].challenger.role, 'batter');
assert.equal(plAbs[0].challenger.label, 'Batter Michael Massey');
assert.equal(MLBReviews.absContextLines(plAbs[0]).join(' | '),
  'Count before challenge: 3-2 | Batter Michael Massey challenged | After call overturned: 4-2');

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

/* ------------------- 3c. Boundary-call review (real shape, 2026-08-19) --- */

// Game 824801 (NYY @ BAL), atBatIndex 57, bottom of the 7th, score tied 3-3.
// Pete Alonso's drive down the left-field line was ruled FOUL; the umpires
// initiated a crew-chief review and the call STOOD. Captured shape: the
// review rides on the "Foul" PITCH event (details.hasReview:true,
// reviewDetails.reviewType "NH", isOverturned:false) while the play's own
// description carries no review text at all ("Pete Alonso strikes out
// swinging."). This is the observed boundary-call pattern: a bare pitch
// description must NOT be labeled as an ABS ball/strike topic here.
const boundaryPlay = {
  about: { atBatIndex: 57, inning: 7, halfInning: 'bottom', hasReview: false, isComplete: true },
  result: { description: 'Pete Alonso strikes out swinging.', event: 'Strikeout' },
  count: { balls: 1, strikes: 3, outs: 3 },
  matchup: { batter: { id: 624413, fullName: 'Pete Alonso' }, pitcher: { id: 687396, fullName: 'Brent Headrick' } },
  playEvents: [
    {
      isPitch: true,
      startTime: '2026-08-20T01:00:27.963Z',
      details: { call: { code: 'F', description: 'Foul' }, description: 'Foul', hasReview: true },
      reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'NH' },
    },
    { isPitch: true, details: { description: 'Swinging Strike' } },
  ],
};

const boundaryFeed = {
  gameData: {
    status: { detailedState: 'Final', abstractGameState: 'Final' },
    teams: {
      away: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
      home: { id: 110, name: 'Baltimore Orioles', abbreviation: 'BAL' },
    },
  },
  liveData: { plays: { allPlays: [boundaryPlay], currentPlay: null } },
};
const boundaryExtracted = MLBReviews.extractReviews(boundaryFeed);
assert.equal(boundaryExtracted.reviews.length, 1, 'the NH boundary review extracts as one entry');
const nh = boundaryExtracted.reviews[0];
assert.equal(nh.typeKey, 'boundary');
assert.equal(nh.reviewType, 'Boundary Call');
assert.equal(nh.outcome, 'stands');           // isOverturned:false — call stood
assert.equal(nh.outcomeLabel, 'Call Stands');
assert.equal(nh.reason, 'Home Run / Boundary Call', 'bare "Foul" is NOT labeled an ABS ball/strike topic');
assert.equal(nh.batter.fullName, 'Pete Alonso');
assert.equal(nh.teamId, null, 'crew-chief-initiated: no challengeTeamId on the observed shape');
assert.equal(boundaryExtracted.summary.byType.boundary, 1);
assert.equal(MLBReviews.absContextLines(nh).length, 0, 'boundary reviews render no ABS count context');

// A boundary review and an ABS challenge on the SAME play stay separate
// entries (map key is atBatIndex:typeKey).
const dualBoundaryPlay = JSON.parse(JSON.stringify(boundaryPlay));
dualBoundaryPlay.about.atBatIndex = 58;
dualBoundaryPlay.playEvents.push({
  isPitch: true,
  details: { description: 'Ball', hasReview: true },
  reviewDetails: { isOverturned: true, inProgress: false, reviewType: 'MJ', challengeTeamId: 110 },
});
const dualBoundaryFeed = JSON.parse(JSON.stringify(boundaryFeed));
dualBoundaryFeed.liveData.plays.allPlays = [dualBoundaryPlay];
const dualBoundaryExtracted = MLBReviews.extractReviews(dualBoundaryFeed);
assert.equal(dualBoundaryExtracted.reviews.length, 2, 'NH boundary + MJ ABS on one play = 2 entries');
assert.ok(dualBoundaryExtracted.reviews.some((r) => r.typeKey === 'boundary'));
assert.ok(dualBoundaryExtracted.reviews.some((r) => r.typeKey === 'abs'));
assert.equal(dualBoundaryExtracted.summary.byType.boundary, 1);
assert.equal(dualBoundaryExtracted.summary.byType.abs, 1);

/* ---------------- 3d. Score impact: official fields, conditional only ----- */

// Active safe-at-home review. The official call-on-field result credits one
// run (NYY 6, BOS 5), and the runner movement is explicitly a scoring event.
// The parser may therefore show the conditional 5-5 score if that credited run
// is removed. It must never say that replay WILL overturn the call.
const priorFiveFive = {
  about: { atBatIndex: 50, inning: 8, halfInning: 'top', isComplete: true },
  result: { description: 'Previous play.', awayScore: 5, homeScore: 5 },
  runners: [],
};
const safeAtHomeReview = {
  about: { atBatIndex: 51, inning: 8, halfInning: 'top', isComplete: false },
  result: {
    event: 'Single', eventType: 'single', awayScore: 6, homeScore: 5,
    description: 'Anthony Volpe is safe at home. Play under review.',
  },
  matchup: { batter: { id: 592450, fullName: 'Aaron Judge' }, pitcher: { id: 656302, fullName: 'Brayan Bello' } },
  reviewDetails: { inProgress: true, reviewType: 'MA', challengeTeamId: 111 },
  runners: [{
    movement: { start: '3B', end: 'score', outBase: null, isOut: false },
    details: { event: 'Single', eventType: 'single', isScoringEvent: true, playIndex: 5, runner: { id: 660670, fullName: 'Anthony Volpe' } },
  }],
  playEvents: [{ index: 5, isPitch: true, details: { description: 'In play, run(s)' } }],
};
const activeHomeFeed = {
  gameData: {
    status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' },
    teams: {
      away: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
      home: { id: 111, name: 'Boston Red Sox', abbreviation: 'BOS' },
    },
  },
  liveData: {
    linescore: { teams: { away: { runs: 6 }, home: { runs: 5 } } },
    plays: { allPlays: [priorFiveFive], currentPlay: safeAtHomeReview },
  },
};
const activeHome = MLBReviews.extractReviews(activeHomeFeed).activeReview;
assert.ok(activeHome, 'safe-at-home review is active');
assert.equal(activeHome.scoreImpact.context, 'home_plate');
assert.equal(activeHome.scoreImpact.scoringSide, 'away');
assert.equal(activeHome.scoreImpact.runsAtRisk, 1);
assert.equal(activeHome.scoreImpact.currentScore.away, 6);
assert.equal(activeHome.scoreImpact.possibleScoreIfRemoved.away, 5);
assert.equal(activeHome.scoreImpact.possibleScoreIfRemoved.home, 5);
assert.deepEqual(Array.from(activeHome.scoreImpact.creditedRunnerNames), ['Anthony Volpe']);
const activeHomeDisplay = MLBReviews.scoreImpactPresentation(activeHome);
assert.equal(activeHomeDisplay.title, '1 RUN AT RISK');
assert.match(activeHomeDisplay.detail, /Call-on-field score: NYY 6 – BOS 5/);
assert.match(activeHomeDisplay.detail, /credited run is removed: NYY 5 – BOS 5/);
assert.match(activeHomeDisplay.note, /not a prediction/);
assert.doesNotMatch(activeHomeDisplay.detail + activeHomeDisplay.note, /will be overturned/i);
const renderedHomeImpact = MLBReviews.renderScoreImpact(activeHome, 'feed');
const renderedImpactText = (node) => [
  node && node.text,
  ...((node && node.children) || []).flatMap((child) => renderedImpactText(child)),
].filter(Boolean).join(' | ');
assert.match(renderedHomeImpact.cls, /score-impact-at-risk/);
assert.match(renderedHomeImpact.cls, /feed-score-impact/);
assert.match(renderedImpactText(renderedHomeImpact), /1 RUN AT RISK/);
assert.match(renderedImpactText(renderedHomeImpact), /NYY 6 – BOS 5/);

// Active three-run home-run boundary review. Every numeric field is supplied
// by result.awayScore/homeScore + three runners marked isScoringEvent=true.
const threeRunBoundary = {
  about: { atBatIndex: 1, inning: 1, halfInning: 'top', isComplete: false },
  result: {
    event: 'Home Run', eventType: 'home_run', awayScore: 3, homeScore: 0,
    description: 'Aaron Judge homers. Two runners score.',
  },
  matchup: { batter: { id: 592450, fullName: 'Aaron Judge' }, pitcher: { id: 656302, fullName: 'Brayan Bello' } },
  runners: [
    { movement: { end: 'score', isOut: false }, details: { isScoringEvent: true, playIndex: 4, runner: { id: 1, fullName: 'Runner One' } } },
    { movement: { end: 'score', isOut: false }, details: { isScoringEvent: true, playIndex: 4, runner: { id: 2, fullName: 'Runner Two' } } },
    { movement: { end: 'score', isOut: false }, details: { isScoringEvent: true, playIndex: 4, runner: { id: 592450, fullName: 'Aaron Judge' } } },
  ],
  playEvents: [{
    index: 4,
    isPitch: true,
    details: { description: 'In play, run(s)', hasReview: true },
    reviewDetails: { inProgress: true, reviewType: 'NH' },
  }],
};
const threeRunBoundaryFeed = {
  gameData: {
    status: { detailedState: 'In Review', abstractGameState: 'Live' },
    teams: {
      away: { id: 147, name: 'New York Yankees', abbreviation: 'NYY' },
      home: { id: 111, name: 'Boston Red Sox', abbreviation: 'BOS' },
    },
  },
  liveData: {
    linescore: { teams: { away: { runs: 3 }, home: { runs: 0 } } },
    plays: { allPlays: [{ about: { atBatIndex: 0 }, result: { awayScore: 0, homeScore: 0 } }], currentPlay: threeRunBoundary },
  },
};
const activeBoundary = MLBReviews.extractReviews(threeRunBoundaryFeed).activeReview;
assert.equal(activeBoundary.typeKey, 'boundary');
assert.equal(activeBoundary.scoreImpact.runsAtRisk, 3);
assert.equal(activeBoundary.scoreImpact.possibleScoreIfRemoved.away, 0);
const boundaryDisplay = MLBReviews.scoreImpactPresentation(activeBoundary);
assert.equal(boundaryDisplay.title, '3 RUNS AT RISK');
assert.match(boundaryDisplay.detail, /NYY 3 – BOS 0/);
assert.match(boundaryDisplay.detail, /NYY 0 – BOS 0/);
assert.match(boundaryDisplay.note, /may also place runners/,
  'HR-to-double runner placement is not predicted');

// Observed NH foul shape: no scoring event means no invented run total. The
// UI reports that score impact is pending instead of claiming a run removal.
const activeFoulBoundary = JSON.parse(JSON.stringify(boundaryPlay));
activeFoulBoundary.about.isComplete = false;
activeFoulBoundary.playEvents[0].reviewDetails = { inProgress: true, reviewType: 'NH' };
activeFoulBoundary.result.awayScore = 3;
activeFoulBoundary.result.homeScore = 3;
const activeFoulFeed = JSON.parse(JSON.stringify(boundaryFeed));
activeFoulFeed.gameData.status = { detailedState: 'In Review', abstractGameState: 'Live' };
activeFoulFeed.liveData.linescore = { teams: { away: { runs: 3 }, home: { runs: 3 } } };
activeFoulFeed.liveData.plays = { allPlays: [], currentPlay: activeFoulBoundary };
const activeFoul = MLBReviews.extractReviews(activeFoulFeed).activeReview;
assert.equal(activeFoul.scoreImpact.runsAtRisk, 0);
const foulDisplay = MLBReviews.scoreImpactPresentation(activeFoul);
assert.equal(foulDisplay.title, 'BOUNDARY CALL — SCORE IMPACT PENDING');
assert.match(foulDisplay.note, /no run-removal total is shown/i);

// A run on an earlier action in the same PA is not attached to a later
// event-level review: details.playIndex must match event.index.
const unrelatedRunPlay = {
  about: { atBatIndex: 2, inning: 2, halfInning: 'top', isComplete: false },
  result: { event: 'Single', eventType: 'single', awayScore: 1, homeScore: 0, description: 'Play under review.' },
  runners: [{
    movement: { end: 'score', isOut: false },
    details: { isScoringEvent: true, playIndex: 1, runner: { id: 9, fullName: 'Earlier Runner' } },
  }],
  playEvents: [{
    index: 5, isPitch: true, details: { description: 'Ball', hasReview: true },
    reviewDetails: { inProgress: true, reviewType: 'MJ', challengeTeamId: 147 },
  }],
};
const unrelatedImpact = MLBReviews.deriveScoreImpact({
  play: unrelatedRunPlay,
  event: unrelatedRunPlay.playEvents[0],
  typeKey: 'abs',
  outcome: { key: 'in_progress' },
  previousScore: { away: 0, home: 0 },
  fallbackScore: null,
  teamNames: {},
  teamIdBySide: {},
});
assert.equal(unrelatedImpact.runsAtRisk, 0,
  'an earlier run in the PA must not be assigned to the reviewed pitch');
const scoreDeltaOnlyImpact = MLBReviews.deriveScoreImpact({
  play: {
    about: { atBatIndex: 3, halfInning: 'top' },
    result: { event: 'Walk', eventType: 'walk', awayScore: 1, homeScore: 0 },
    runners: [],
  },
  event: null,
  typeKey: 'manager',
  outcome: { key: 'in_progress' },
  previousScore: { away: 0, home: 0 },
  fallbackScore: null,
  teamNames: {},
  teamIdBySide: {},
});
assert.equal(scoreDeltaOnlyImpact.runsAtRisk, 0,
  'a whole-PA score delta without a tied scoring-runner record is not enough');
const earlierActionPlay = {
  result: { event: 'Single', eventType: 'single' },
  runners: [
    { details: { event: 'Wild Pitch', eventType: 'wild_pitch', isScoringEvent: true, playIndex: 2 } },
    { details: { event: 'Single', eventType: 'single', isScoringEvent: false, playIndex: 5 } },
  ],
};
assert.equal(MLBReviews.reviewedScoringRunners(earlierActionPlay, null, 'manager').length, 0,
  'play-level review excludes an earlier wild-pitch run in the same PA');
assert.equal(MLBReviews.readScorePair({ awayScore: 6, homeScore: 5 }).away, 6);
assert.equal(MLBReviews.readScorePair({ teams: { away: { runs: 3 }, home: { runs: 0 } } }).home, 0);
assert.equal(MLBReviews.readScorePair({ awayScore: 6 }), null,
  'partial score pairs are rejected rather than filled');

/* -------------------------------------------------- 4. Scoreboard Inspection */

const schedGameReview = {
  status: { detailedState: 'Manager Challenge', abstractGameState: 'Live' },
};
const schedGameNormal = {
  status: { detailedState: 'In Progress', abstractGameState: 'Live' },
};
assert.equal(MLBReviews.inspectScheduleGame(schedGameReview).hasActiveReview, true);
assert.equal(MLBReviews.inspectScheduleGame(schedGameNormal).hasActiveReview, false);

/* ------------- 5. Schedule-shaped feeds: no fabricated team data ---------- */

// The all-games Replay Feed calls extractReviews with a pseudo-feed built
// from the SCHEDULE (verified live 2026-08-19: teams.*.team = { id, name,
// link } only — no abbreviation). extractReviews must pass the official full
// name through and leave the abbreviation null for the caller to resolve
// from MLB.getTeams(); the old `name.slice(0, 3)` fallback invented wrong
// codes ("SAN" for the Padres, "CHI" for both Chicago clubs, "LOS" for both
// LA clubs).
const scheduleShapedFeed = {
  gameData: {
    status: { detailedState: 'Final', abstractGameState: 'Final' },
    teams: {
      away: { id: 135, name: 'San Diego Padres' },   // real schedule shape
      home: { id: 121, name: 'New York Mets' },
    },
  },
  liveData: {
    plays: {
      allPlays: [{
        about: { atBatIndex: 15, inning: 2, halfInning: 'bottom', hasReview: false },
        result: { description: 'Jared Triolo grounds out, third baseman to first baseman.' },
        matchup: { batter: { id: 668804, fullName: 'Bryan Reynolds' }, pitcher: { id: 695549, fullName: 'Jackson Jobe' } },
        playEvents: [
          { isPitch: true, details: { description: 'Ball', hasReview: true },
            reviewDetails: { isOverturned: false, inProgress: false, reviewType: 'MJ', challengeTeamId: 135 } },
        ],
      }],
      currentPlay: null,
    },
  },
};
const schedExtracted = MLBReviews.extractReviews(scheduleShapedFeed);
assert.equal(schedExtracted.reviews.length, 1);
assert.equal(schedExtracted.reviews[0].teamName, 'San Diego Padres', 'official full name passes through');
assert.equal(schedExtracted.reviews[0].teamAbbrev, null, 'no fabricated abbreviation (old code produced "SAN")');

// Every string the renderers put on screen must be official text — sweep all
// extracted entries (synthetic §3 feed + real-shaped §3b feed) for the
// literal string "undefined" leaking into any rendered field.
const RENDERED_FIELDS = ['reviewType', 'reason', 'description', 'outcomeLabel', 'teamName', 'inningLabel'];
const allReviews = [...extracted.reviews, ...realExtracted.reviews, ...schedExtracted.reviews,
  ...boundaryExtracted.reviews, ...dualBoundaryExtracted.reviews];
assert.ok(allReviews.length > 0, 'fixtures produced reviews to sweep');
for (const r of allReviews) {
  for (const field of RENDERED_FIELDS) {
    const v = r[field];
    assert.ok(v == null || !String(v).includes('undefined'),
      `rendered field "${field}" leaked "undefined": ${JSON.stringify(v)}`);
  }
  const absLines = MLBReviews.absContextLines(r);
  absLines.forEach((line) => {
    assert.ok(!String(line).includes('undefined') && !String(line).includes('null'),
      `ABS context line leaked placeholder: ${line}`);
  });
}

/* ----------------------------- 6. ABS count / challenger helpers --------- */

assert.equal(MLBReviews.formatCount({ balls: 3, strikes: 2 }), '3-2');
assert.equal(MLBReviews.formatCount(null), null);
assert.equal(MLBReviews.formatCount({ balls: 1 }), null);
assert.equal(MLBReviews.readPitchCount({ balls: 2, strikes: 1, outs: 0 }).strikes, 1);
assert.equal(MLBReviews.readPitchCount({ balls: '2', strikes: 1 }), null, 'string counts are not numbers — reject');
assert.equal(MLBReviews.readPitchCount({}), null);

const firstPitch = { isPitch: true, count: { balls: 1, strikes: 0 } };
const firstEnter = MLBReviews.countEnteringPitch([firstPitch], firstPitch);
assert.equal(firstEnter.balls, 0);
assert.equal(firstEnter.strikes, 0);

const p1 = { isPitch: true, count: { balls: 0, strikes: 1 } };
const p2 = { isPitch: true, count: { balls: 1, strikes: 1 } };
const midEnter = MLBReviews.countEnteringPitch([p1, p2], p2);
assert.equal(midEnter.balls, 0);
assert.equal(midEnter.strikes, 1);

const noCountPrev = { isPitch: true };
const reviewedNoPrevCount = { isPitch: true, count: { balls: 2, strikes: 0 } };
assert.equal(MLBReviews.countEnteringPitch([noCountPrev, reviewedNoPrevCount], reviewedNoPrevCount), null,
  'do not invent a before-count when previous pitches have no count field');

const batterChal = MLBReviews.resolveChallenger({
  desc: 'Michael Massey challenged (pitch result), call on the field was overturned: Michael Massey walks.',
  typeKey: 'abs',
  challengeTeamId: 118,
  about: { halfInning: 'bottom' },
  matchup: { batter: { fullName: 'Michael Massey' }, pitcher: { fullName: 'Yerry De los Santos' } },
  teamNames: { 118: { name: 'Kansas City Royals', abbrev: 'KC' } },
  teamIdBySide: { away: 118, home: 136 },
});
assert.equal(batterChal.role, 'batter');
assert.equal(batterChal.label, 'Batter Michael Massey');

const catcherNamed = MLBReviews.resolveChallenger({
  desc: 'Salvador Perez challenged (pitch result), call on the field was overturned.',
  typeKey: 'abs',
  challengeTeamId: 118,
  about: { halfInning: 'top' },
  matchup: { batter: { fullName: 'Aaron Judge' }, pitcher: { fullName: 'Cole Ragans' } },
  teamNames: { 118: { name: 'Kansas City Royals', abbrev: 'KC' } },
  teamIdBySide: { away: 147, home: 118 },
});
assert.equal(catcherNamed.role, 'catcher');
assert.equal(catcherNamed.label, 'Catcher Salvador Perez');

const defenseOnly = MLBReviews.resolveChallenger({
  desc: 'Ball',
  typeKey: 'abs',
  challengeTeamId: 116,
  about: { halfInning: 'bottom' },
  matchup: { batter: { fullName: 'Bryan Reynolds' }, pitcher: { fullName: 'Jackson Jobe' } },
  teamNames: { 116: { name: 'Detroit Tigers', abbrev: 'DET' }, 134: { name: 'Pittsburgh Pirates', abbrev: 'PIT' } },
  teamIdBySide: { away: 116, home: 134 },
});
assert.equal(defenseOnly.role, 'defense');
assert.equal(defenseOnly.label, 'Catcher or pitcher');
assert.equal(defenseOnly.name, null, 'do not invent a catcher name');

const teamChal = MLBReviews.resolveChallenger({
  desc: 'Tigers challenged (tag play), call on the field was overturned.',
  typeKey: 'manager',
  challengeTeamId: 116,
  about: { halfInning: 'bottom' },
  matchup: { batter: { fullName: 'Jared Triolo' }, pitcher: { fullName: 'Tarik Skubal' } },
  teamNames: { 116: { name: 'Detroit Tigers', abbrev: 'DET' } },
  teamIdBySide: { away: 116, home: 134 },
});
assert.equal(teamChal.role, 'team');
assert.equal(teamChal.label, 'Detroit Tigers');

assert.equal(MLBReviews.absContextLines({ typeKey: 'manager' }).length, 0);
assert.equal(MLBReviews.absContextLines({
  typeKey: 'abs',
  inProgress: false,
  outcome: 'stands',
  countBefore: null,
  countAfter: null,
  atBatCount: null,
  challenger: { label: null },
}).length, 0, 'no official fields → no ABS lines');

console.log('MLBReviews tests passed successfully!');
