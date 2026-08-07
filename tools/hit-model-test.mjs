#!/usr/bin/env node
/* ============================================================================
 * hit-model-test.mjs — deterministic checks for the two-sided hit forecast.
 *
 * Run: node tools/hit-model-test.mjs
 *
 * This evaluates the browser script in a tiny VM; no network requests or DOM
 * are required. The cases intentionally cover model direction, the complement
 * invariant, graceful data fallbacks, parser aliases, and legacy API support.
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

const highContactBatter = { xBA: '.320', avg: '.310', atBats: 560 };
const lowContactBatter = { xBA: '.195', avg: '.205', atBats: 560 };
const hitFriendlyPitcher = { xBA: '.305', avg: '.300', atBats: 680 };
const hitSuppressingPitcher = { xBA: '.190', avg: '.200', atBats: 680 };

const favorable = Props.modelHitProbability(
  highContactBatter, hitFriendlyPitcher, 'L', 'R');
const unfavorable = Props.modelHitProbability(
  lowContactBatter, hitSuppressingPitcher, 'R', 'R');
assert.equal(favorable.coverage, 'two-sided', 'both supplied player sides should be used');
assert.ok(favorable.probability > unfavorable.probability + 0.08,
  'a stronger batter against a weaker pitcher should raise the forecast materially');

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
  'switch hitters should receive the documented platoon edge');

const noData = Props.modelHitProbability({}, {}, '', '');
assert.equal(noData.coverage, 'baseline', 'missing data should be an explicit baseline fallback');
assert.equal(noData.prob, '24.5', 'baseline fallback should remain stable and transparent');

// Original modelHitProbability(stats, batterHand, pitcherHand) callers still work.
const legacy = Props.modelHitProbability(highContactBatter, 'L', 'R');
assert.equal(legacy.coverage, 'batter-only', 'legacy call should gracefully become a one-side fallback');

const batterFeedFixture = {
  stats: [
    { type: { displayName: 'Expected Statistics' }, splits: [{ stat: { avg: '.287' } }] },
    { type: { displayName: 'season' }, splits: [{ stat: { avg: '.278', atBats: 300, ops: '.811' } }] },
    { type: { displayName: 'Statcast' }, splits: [{ stat: { launchSpeed: '91.4', launchAngle: '14.2' } }] },
  ],
};
const pitcherFeedFixture = {
  stats: [
    { type: { displayName: 'expectedStatistics' }, splits: [{ stat: { estimatedBaAgainst: '.226' } }] },
    { type: { displayName: 'season' }, splits: [{ stat: { hits: 89, atBats: 382 } }] },
  ],
};
const batterStats = Props.parseBatterStats(batterFeedFixture);
const pitcherStats = Props.parsePitcherStats(pitcherFeedFixture);
assert.equal(batterStats.xBA, '.287', 'parser should accept expected-stat avg aliases');
assert.equal(batterStats.avg, '.278', 'parser should retain season AVG');
assert.equal(pitcherStats.xBA, '.226', 'pitcher parser should read xBA-against');
assert.equal(pitcherStats.avg, '.233', 'pitcher parser should derive opponent AVG from hits / AB');

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

// Role + season are part of the cache key, which prevents a hitter response
// from ever being reused as a pitcher's opponent-AVG input.
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

// Render against a tiny DOM shim to verify the tab consumes a full feed
// (liveData + gameData), rather than silently expecting the wrong object shape.
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
  gameData: { game: { season: '2026' }, players: {} },
  liveData: {
    plays: {
      allPlays: [],
      currentPlay: {
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

console.log('two-sided hit-model tests passed');
