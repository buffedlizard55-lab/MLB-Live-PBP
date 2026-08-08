#!/usr/bin/env node
/* ============================================================================
 * hit-model-test.mjs — deterministic checks for the discriminative two-sided
 * hit forecast (model v2).
 *
 * Run: node tools/hit-model-test.mjs
 *
 * Evaluates the browser script in a tiny VM; no network or DOM required.
 * Beyond direction/invariant checks, this suite encodes the SPREAD
 * requirements that motivated v2: stacked edges must separate clearly,
 * and live context (count, times-through-order, form) must move the number.
 * ==========================================================================*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/props.js', import.meta.url), 'utf8');
const context = {
  console: { warn() {}, error() {}, log() {} },
  Map,
  Math,
  Number,
  String,
  Object,
  Array,
  Promise,
  URLSearchParams,
  window: {},
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'assets/js/props.js' });

const { Props } = context.window;
assert.ok(Props, 'Props module should load');

/* ------------------------------------------------- season-only basics (v1 API) */

const highContactBatter = { xBA: '.320', avg: '.310', atBats: 560 };
const lowContactBatter = { xBA: '.195', avg: '.205', atBats: 560 };
const hitFriendlyPitcher = { xBA: '.305', avg: '.300', atBats: 680 };
const hitSuppressingPitcher = { xBA: '.190', avg: '.200', atBats: 680 };

const favorable = Props.modelHitProbability(
  highContactBatter, hitFriendlyPitcher, 'L', 'R');
const unfavorable = Props.modelHitProbability(
  lowContactBatter, hitSuppressingPitcher, 'R', 'R');
assert.equal(favorable.coverage, 'two-sided', 'both supplied player sides should be used');
assert.ok(favorable.probability > unfavorable.probability + 0.10,
  `extreme matchups must separate by >10 pts even without splits (got ${favorable.prob} vs ${unfavorable.prob})`);

const againstWeakPitcher = Props.modelHitProbability(
  highContactBatter, hitFriendlyPitcher, 'R', 'R');
const againstStrongPitcher = Props.modelHitProbability(
  highContactBatter, hitSuppressingPitcher, 'R', 'R');
assert.ok(againstWeakPitcher.probability > againstStrongPitcher.probability + 0.025,
  'pitcher hit-allowed data must independently influence the result');

assert.ok(Math.abs((favorable.probability + favorable.noHitProbability) - 1) < 1e-12,
  'hit and no-hit values must remain complementary');

const switchHitter = Props.modelHitProbability(
  highContactBatter, hitFriendlyPitcher, 'S', 'R');
const sameHanded = Props.modelHitProbability(
  highContactBatter, hitFriendlyPitcher, 'R', 'R');
assert.ok(switchHitter.probability > sameHanded.probability,
  'without split data, switch hitters should keep the documented flat platoon edge');

const noData = Props.modelHitProbability({}, {}, '', '');
assert.equal(noData.coverage, 'baseline', 'missing data should be an explicit baseline fallback');
assert.equal(noData.prob, '24.5', 'baseline fallback should remain stable and transparent');
assert.equal(noData.tier.key, 'neutral', 'league-average rates should be the neutral tier');

// Original modelHitProbability(stats, batterHand, pitcherHand) callers still work.
const legacy = Props.modelHitProbability(highContactBatter, 'L', 'R');
assert.equal(legacy.coverage, 'batter-only', 'legacy call should gracefully become a one-side fallback');

/* --------------------------------------- the headline is the per-PA rate now */

const contextInning1 = { inning: 1, halfInning: 'top', battingOrderPos: 1, isHomeBatting: false, gameState: 'Live' };
const contextInning9 = { inning: 9, halfInning: 'top', battingOrderPos: 9, isHomeBatting: false, gameState: 'Live' };
const contextFinal = { inning: 9, halfInning: 'bottom', battingOrderPos: 5, isHomeBatting: true, gameState: 'Final' };

const probInning1 = Props.modelHitProbability(highContactBatter, hitFriendlyPitcher, 'L', 'R', contextInning1);
const probInning9 = Props.modelHitProbability(highContactBatter, hitFriendlyPitcher, 'L', 'R', contextInning9);
const probFinal = Props.modelHitProbability(highContactBatter, hitFriendlyPitcher, 'L', 'R', contextFinal);

assert.ok(Math.abs(probInning1.probability - probInning9.probability) < 1e-9,
  'the per-PA headline rate must not drift with inning/score (that was the v1 clustering bug)');
assert.ok(probInning1.gameFlowProbability > probInning9.gameFlowProbability,
  'the remaining-PAs projection should still reward many remaining at-bats');
assert.equal(probFinal.gameFlowProbability, 0.0,
  'the remaining-PAs projection goes to 0 for finished games');
assert.ok(probFinal.probability > 0.01,
  'the per-PA headline stays meaningful for chips on finished games');
assert.ok(probInning1.probability < 0.42 && probInning9.probability > 0.10,
  'per-PA probabilities stay inside the realistic band');

/* ------------------------------------------------- DISCRIMINATION (v2 core) */

// Stacked edges: platoon splits + recent form widen the gap far beyond v1.
const eliteBatter = {
  xBA: '.320', avg: '.310', atBats: 560,
  splits: { vr: { avg: '.360', atBats: 400 } },
  recent: { avg: '.380', atBats: 30 },
};
const generousPitcher = {
  xBA: '.305', avg: '.300', atBats: 680,
  splits: { vr: { avg: '.340', atBats: 300 } },
};
const overwhelmedBatter = {
  xBA: '.195', avg: '.205', atBats: 560,
  splits: { vr: { avg: '.170', atBats: 400 } },
  recent: { avg: '.150', atBats: 30 },
};
const dominantPitcher = {
  xBA: '.190', avg: '.200', atBats: 680,
  splits: { vr: { avg: '.175', atBats: 300 } },
};

const stackedGood = Props.modelHitProbability(eliteBatter, generousPitcher, 'R', 'R');
const stackedBad = Props.modelHitProbability(overwhelmedBatter, dominantPitcher, 'R', 'R');
assert.ok(stackedGood.probability - stackedBad.probability >= 0.20,
  `fully differentiated matchups should separate by ≥20 pts (got ${stackedGood.prob} vs ${stackedBad.prob})`);
assert.ok(stackedGood.probability >= 0.32, 'elite stack should project a genuinely high hit chance');
assert.ok(stackedBad.probability <= 0.20, 'overwhelmed stack should project a genuinely low hit chance');
assert.notEqual(stackedGood.tier.key, stackedBad.tier.key, 'extremes must earn different tiers');
assert.ok(['elite', 'favorable'].includes(stackedGood.tier.key), 'elite stack earns a positive tier');
assert.ok(['tough', 'dominated'].includes(stackedBad.tier.key), 'overwhelmed stack earns a negative tier');

// Splits must add SOMETHING beyond season aggregates (not necessarily a huge
// margin, because light regression already lets season data discriminate well
// on its own — the wider test is the absolute separation above).
const seasonGap = favorable.probability - unfavorable.probability;
assert.ok((stackedGood.probability - stackedBad.probability) > seasonGap,
  'real platoon splits + form must add at least some separation beyond season aggregates');

// Driver chips explain each material adjustment.
const driverIds = stackedGood.adjustments.map((adj) => adj.id);
assert.ok(driverIds.includes('level') && driverIds.includes('platoon') && driverIds.includes('form'),
  'adjustments should name the season level, platoon, and form drivers');
assert.ok(stackedGood.adjustments.find((adj) => adj.id === 'platoon').points > 0.005,
  'platoon splits should create a visible positive driver for the elite stack');

/* ----------------------------------- SPREAD (regression guard for the v2 goal) */
// A realistic matchup grid must produce a useful spread — the v1 model
// clustered every matchup within ~10 points, which made the forecast useless
// for distinguishing a great spot from a terrible one. The user asked for
// the band to reach the 16-80% range, so we encode the lower bound of that
// intent here: realistic archetypes must span at least 15 percentage points
// of per-PA probability, and the per-PA band itself must be reachable.
const archetypes = [
  // elite batter, dominant pitcher
  [{ xBA: '.330', avg: '.320', atBats: 520, splits: { vr: { avg: '.345', atBats: 350 } } },
   { xBA: '.190', avg: '.195', atBats: 640, splits: { vr: { avg: '.180', atBats: 320 } } }],
  // elite batter, league-average arm
  [{ xBA: '.330', avg: '.320', atBats: 520, splits: { vr: { avg: '.345', atBats: 350 } } },
   { xBA: '.248', avg: '.250', atBats: 600, splits: { vr: { avg: '.250', atBats: 300 } } }],
  // league-average batter, league-average arm
  [{ xBA: '.245', avg: '.242', atBats: 480, splits: { vr: { avg: '.248', atBats: 320 } } },
   { xBA: '.248', avg: '.250', atBats: 600, splits: { vr: { avg: '.250', atBats: 300 } } }],
  // weak batter, ace pitcher
  [{ xBA: '.210', avg: '.205', atBats: 400, splits: { vr: { avg: '.195', atBats: 250 } } },
   { xBA: '.190', avg: '.195', atBats: 640, splits: { vr: { avg: '.180', atBats: 320 } } }],
  // overmatched call-up, ace pitcher
  [{ xBA: '.180', avg: '.170', atBats: 70, splits: { vr: { avg: '.150', atBats: 50 } } },
   { xBA: '.190', avg: '.195', atBats: 640, splits: { vr: { avg: '.180', atBats: 320 } } }],
];
const probs = archetypes.map(([b, p]) => Props.modelHitProbability(b, p, 'R', 'R').probability);
const minP = Math.min(...probs);
const maxP = Math.max(...probs);
assert.ok(maxP - minP >= 0.14,
  `realistic archetypes must span ≥14 pts of per-PA probability (got ${(minP * 100).toFixed(1)}–${(maxP * 100).toFixed(1)}%)`);
assert.ok(minP < 0.20,
  `the worst realistic matchup must dip below 20% (got ${(minP * 100).toFixed(1)}%)`);
assert.ok(maxP > 0.32,
  `the best realistic matchup must reach above 32% (got ${(maxP * 100).toFixed(1)}%)`);

/* ------------------------------------------------------------ platoon splits */

const splitBatter = { xBA: '.260', avg: '.255', atBats: 500, splits: { vr: { avg: '.340', atBats: 400 } } };
const plainBatter = { xBA: '.260', avg: '.255', atBats: 500 };
const avgPitcher = { xBA: '.245', avg: '.248', atBats: 600 };
const withEdge = Props.modelHitProbability(splitBatter, avgPitcher, 'R', 'R');
const withoutEdge = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R');
assert.ok(withEdge.probability > withoutEdge.probability + 0.008,
  'a real platoon-split edge must raise the forecast over the flat adjustment');

// Pitcher-side split works independently and in the right direction.
const pitcherSplitEdge = { xBA: '.245', avg: '.248', atBats: 600, splits: { vl: { avg: '.330', atBats: 350 } } };
const leftyFriendly = Props.modelHitProbability(plainBatter, pitcherSplitEdge, 'L', 'R');
const rightyNeutral = Props.modelHitProbability(plainBatter, pitcherSplitEdge, 'R', 'R');
assert.ok(leftyFriendly.probability > rightyNeutral.probability + 0.004,
  'a pitcher who struggles vs LHB must raise lefty forecasts (vl = vs left-handed batters)');

// Switch hitters bat opposite: vs LHP they bat right → pitcher vr split applies.
const pitcherVrEdge = { xBA: '.245', avg: '.248', atBats: 600, splits: { vr: { avg: '.330', atBats: 350 } } };
const switchVsLhp = Props.modelHitProbability(plainBatter, pitcherVrEdge, 'S', 'L');
assert.ok(switchVsLhp.probability > rightyNeutral.probability + 0.004,
  'switch hitters must map to the pitcher split for the side they bat from');

/* ------------------------------------------------------------- recent form */

const hotBatter = { xBA: '.250', avg: '.250', atBats: 500, recent: { avg: '.420', atBats: 32 } };
const coldBatter = { xBA: '.250', avg: '.250', atBats: 500, recent: { avg: '.120', atBats: 32 } };
const hot = Props.modelHitProbability(hotBatter, avgPitcher, 'R', 'R');
const cold = Props.modelHitProbability(coldBatter, avgPitcher, 'R', 'R');
assert.ok(hot.probability > cold.probability + 0.008,
  'hot/cold recent form must spread the forecast');
assert.ok(hot.probability < 0.35 && cold.probability > 0.15,
  'form is capped so streaks cannot dominate the season signal');

/* --------------------------------------------------------- live count state */

const liveContext = (balls, strikes) => ({ count: { balls, strikes }, gameState: 'Live' });
const at00 = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', liveContext(0, 0));
const at02 = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', liveContext(0, 2));
const at31 = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', liveContext(3, 1));
assert.ok(at31.probability > at00.probability + 0.015,
  `3-1 must clearly beat 0-0 (got ${at31.prob} vs ${at00.prob})`);
assert.ok(at00.probability > at02.probability + 0.03,
  `0-0 must clearly beat 0-2 (got ${at00.prob} vs ${at02.prob})`);
assert.ok(at02.probability >= 0.08, 'count adjustment respects the live floor');
assert.equal(at00.probability, Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R').probability,
  'a fresh 0-0 count must equal the count-free per-PA rate');
const countDriver = at02.adjustments.find((adj) => adj.id === 'count');
assert.ok(countDriver && countDriver.points < -0.02, 'the count driver chip should explain the 0-2 penalty');

/* -------------------------------------------------- times through the order */

const firstLook = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', { timesFacedToday: 0 });
const thirdLook = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', { timesFacedToday: 2 });
const tenthLook = Props.modelHitProbability(plainBatter, avgPitcher, 'R', 'R', { timesFacedToday: 9 });
assert.ok(Math.abs((thirdLook.probability - firstLook.probability) - 0.015) < 1e-9,
  'the third look should add ~+1.5 pts of same-game familiarity');
assert.equal(tenthLook.probability, thirdLook.probability,
  'familiarity is capped after the third time through the order');

/* ------------------------------------------------------- head-to-head (cap) */

const ownedHim = {
  xBA: '.250', avg: '.250', atBats: 500,
  h2h: { avg: '.850', atBats: 12 },
};
const noHistory = { xBA: '.250', avg: '.250', atBats: 500 };
const withHistory = Props.modelHitProbability(ownedHim, avgPitcher, 'R', 'R');
const withoutHistory = Props.modelHitProbability(noHistory, avgPitcher, 'R', 'R');
const h2hLift = withHistory.probability - withoutHistory.probability;
assert.ok(h2hLift > 0.005, 'a strong head-to-head line should lift the forecast');
assert.ok(h2hLift <= 0.12,
  `head-to-head is bounded as a meaningful but capped signal (got +${(h2hLift * 100).toFixed(1)} pts)`);

/* ------------------------------------------------------------- stat parsing */

const batterFeedFixture = {
  stats: [
    { type: { displayName: 'Expected Statistics' }, splits: [{ stat: { avg: '.287' } }] },
    { type: { displayName: 'season' }, splits: [{ stat: { avg: '.278', atBats: 300, ops: '.811' } }] },
    { type: { displayName: 'Statcast' }, splits: [{ stat: { launchSpeed: '91.4', launchAngle: '14.2' } }] },
    {
      type: { displayName: 'statSplits' },
      splits: [
        { split: { code: 'vl' }, stat: { avg: '.341', atBats: 123 } },
        { split: { code: 'vr' }, stat: { avg: '.328', atBats: 418 } },
      ],
    },
    {
      type: { displayName: 'gameLog' },
      splits: [
        { date: '2026-08-06', stat: { hits: 2, atBats: 4 } },
        { date: '2026-07-30', stat: { hits: 1, atBats: 4 } },
        { date: '2026-08-02', stat: { hits: 0, atBats: 3 } },
      ],
    },
  ],
};
const pitcherFeedFixture = {
  stats: [
    { type: { displayName: 'expectedStatistics' }, splits: [{ stat: { estimatedBaAgainst: '.226' } }] },
    { type: { displayName: 'season' }, splits: [{ stat: { hits: 89, atBats: 382 } }] },
    {
      type: { displayName: 'statSplits' },
      splits: [
        { split: { code: 'vl' }, stat: { avg: '.210', atBats: 362 } },
        { split: { code: 'vr' }, stat: { avg: '.186', atBats: 322 } },
      ],
    },
  ],
};
const batterStats = Props.parseBatterStats(batterFeedFixture);
const pitcherStats = Props.parsePitcherStats(pitcherFeedFixture);
assert.equal(batterStats.xBA, '.287', 'parser should accept expected-stat avg aliases');
assert.equal(batterStats.avg, '.278', 'parser should retain season AVG');
assert.equal(pitcherStats.xBA, '.226', 'pitcher parser should read xBA-against');
assert.equal(pitcherStats.avg, '.233', 'pitcher parser should derive opponent AVG from hits / AB');
assert.equal(batterStats.splits.vl.avg, 0.341, 'statSplits vl should populate the batter split pool');
assert.equal(batterStats.splits.vr.atBats, 418, 'split sample sizes should be retained');
assert.equal(pitcherStats.splits.vl.avg, 0.210, 'pitcher statSplits should populate vs-hand pools');
assert.equal(batterStats.recentLog.length, 3, 'gameLog entries should be captured for recent form');
assert.equal(batterStats.recentLog[0].date, '2026-07-30', 'recent form should be sorted chronologically');

// Recent form respects the game being modeled (no "future" games leak in).
const logProfile = {
  xBA: '.250', avg: '.250', atBats: 500,
  recentLog: [
    { date: '2026-07-01', hits: 0, atBats: 4 },
    { date: '2026-07-02', hits: 0, atBats: 4 },
    { date: '2026-07-03', hits: 1, atBats: 4 },
    { date: '2026-07-29', hits: 5, atBats: 5 }, // hot game AFTER the cutoff below
  ],
};
const formBeforeHotGame = Props.modelHitProbability(
  logProfile, avgPitcher, 'R', 'R', { gameDate: '2026-07-15T23:00:00Z' });
const formAfterHotGame = Props.modelHitProbability(
  logProfile, avgPitcher, 'R', 'R', { gameDate: '2026-07-30T23:00:00Z' });
assert.ok(formBeforeHotGame.probability < formAfterHotGame.probability,
  'form only counts games played up to the modeled game date');
assert.ok(formBeforeHotGame.form.batter.available &&
  formBeforeHotGame.form.batter.rawAvg < 0.15,
  'the cutoff forecast should only see the cold stretch');

/* ------------------------------------------------------ head-to-head parser */

const h2hFixture = {
  stats: [
    { type: { displayName: 'vsPlayerTotal' }, splits: [{ stat: { avg: '.429', atBats: 21 } }] },
    { type: { displayName: 'vsPlayer' }, splits: [{ season: '2025', stat: { hits: 9, atBats: 21 } }] },
  ],
};
const h2hParsed = Props.parseHeadToHead(h2hFixture);
assert.equal(h2hParsed.atBats, 21, 'career head-to-head should prefer the total line');
assert.equal(h2hParsed.avg, 0.429, 'career head-to-head rate should parse');
assert.equal(Props.parseHeadToHead({ stats: [] }), null, 'no history should be explicit');
const h2hSeasonsOnly = Props.parseHeadToHead({
  stats: [{ type: { displayName: 'vsPlayer' }, splits: [
    { stat: { hits: 5, atBats: 10 } },
    { stat: { hits: 3, atBats: 10 } },
  ] }],
});
assert.equal(h2hSeasonsOnly.atBats, 20, 'season lines should sum without a total');
assert.equal(h2hSeasonsOnly.avg, 0.4, 'summed head-to-head rate should be hits / AB');

/* ----------------------------------------------------------------- arsenal */

const arsenal = Props.getPitcherArsenal([
  {
    matchup: { pitcher: { id: 44 } },
    playEvents: [
      { isPitch: true, details: { type: { code: 'FF', description: 'Four-Seam Fastball' } }, pitchData: { startSpeed: 96 } },
      { isPitch: true, details: { type: { code: 'SL', description: 'Slider' } }, pitchData: { startSpeed: 85 } },
    ],
  },
  {
    matchup: { pitcher: { id: 99 } },
    playEvents: [{ isPitch: true, details: { type: { code: 'CH' } } }],
  },
], 44);
assert.equal(arsenal.totalPitches, 2, 'arsenal should only count the selected pitcher');
assert.equal(arsenal.mix[0].code, 'FF', 'arsenal should retain pitch types');

/* ------------------------------------------------------- same-game familiarity */

const familiarityPlays = [
  { about: { isComplete: true }, matchup: { batter: { id: 7 }, pitcher: { id: 8 } } },
  { about: { isComplete: true }, matchup: { batter: { id: 7 }, pitcher: { id: 8 } } },
  { about: { isComplete: false }, matchup: { batter: { id: 7 }, pitcher: { id: 8 } } }, // live PA — not yet
  { about: { isComplete: true }, matchup: { batter: { id: 7 }, pitcher: { id: 9 } } },
];
assert.equal(Props.timesFacedToday(familiarityPlays, 7, 8), 2,
  'timesFacedToday counts only completed PAs between the pair');

/* ------------------------------------------------------------- fetch caching */

const requests = [];
context.fetch = async (url) => {
  requests.push(String(url));
  return {
    ok: true,
    json: async () => ({ stats: [] }),
  };
};
await Props.fetchPlayerStats(42, 'hitting', '2026');
await Props.fetchPlayerStats(42, 'hitting', '2026');
await Props.fetchPlayerStats(42, 'pitching', '2026');
assert.equal(requests.length, 2, 'same player/group/season should share one in-flight cache entry');
assert.match(requests[0], /group=hitting/, 'hitting cache entry should request hitter data');
assert.match(requests[1], /group=pitching/, 'pitching cache entry should request pitcher data');
assert.match(requests[1], /season=2026/, 'forecast requests should preserve the game season');
assert.match(requests[0], /stats=statcast%2CexpectedStatistics%2Cseason%2CstatSplits%2CgameLog/,
  'hitter bundle should include splits and game logs');
assert.match(requests[0], /sitCodes=vl%2Cvr/, 'bundle should request platoon sitCodes');
assert.ok(!requests[1].includes('statcast%2C'), 'pitcher bundle should skip hitter-only Statcast groups');

await Props.fetchHeadToHead(7, 8);
await Props.fetchHeadToHead(7, 8);
await Props.fetchHeadToHead(7, 9);
const h2hRequests = requests.slice(2);
assert.equal(h2hRequests.length, 2, 'head-to-head fetches should dedupe per batter/pitcher pair');
assert.match(h2hRequests[0], /stats=vsPlayer/, 'head-to-head should use the vsPlayer feed');
assert.match(h2hRequests[0], /opposingPlayerId=8/, 'head-to-head targets the opposing pitcher');

/* ------------------------------------------------------------ render (DOM shim) */

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.isConnected = true;
    this.className = '';
    this.textContent = '';
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
}

context.document = { createElement: (tagName) => new FakeElement(tagName) };
context.fetch = async (url) => ({
  ok: true,
  json: async () => String(url).includes('group=pitching') ? pitcherFeedFixture : batterFeedFixture,
});
const container = new FakeElement('div');
Props.render(container, {
  gameData: { game: { season: '2026' }, players: {}, datetime: { dateTime: '2026-08-06T23:00:00Z' } },
  liveData: {
    plays: {
      allPlays: [],
      currentPlay: {
        count: { balls: 2, strikes: 1 },
        matchup: {
          batter: { id: 7, fullName: 'Test Batter' },
          pitcher: { id: 8, fullName: 'Test Pitcher' },
          batSide: { code: 'L' },
          pitchHand: { code: 'R' },
        },
      },
    },
    linescore: {
      offense: { batter: { id: 7, fullName: 'Test Batter' } },
      defense: { pitcher: { id: 8, fullName: 'Test Pitcher' } },
    },
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(container.children.length, 3, 'forecast tab should render forecast, pitcher, and batter sections');
assert.match(container.children[0].className, /matchup-forecast-section/,
  'first rendered section should be the two-sided forecast');

console.log('discriminative hit-model (v2) tests passed');
