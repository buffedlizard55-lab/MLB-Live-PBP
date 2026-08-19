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
