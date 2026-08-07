#!/usr/bin/env node
/* ============================================================================
 * model-calibration-report.mjs — print the forecast across a slate of
 * archetypes to eyeball spread, tiers, and live-context movement.
 * Run: node tools/model-calibration-report.mjs
 * ==========================================================================*/

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/js/props.js', import.meta.url), 'utf8');
const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Math, Number, String, Object, Array, Promise, URLSearchParams,
  window: {},
};
vm.createContext(context);
vm.runInContext(source, context);
const { Props } = context.window;

const BATTERS = {
  'Elite hitter (Judge-ish)': { xBA: '.310', avg: '.300', atBats: 520, splits: { vr: { avg: '.330', atBats: 350 } } },
  'Good hitter': { xBA: '.272', avg: '.265', atBats: 500, splits: { vr: { avg: '.280', atBats: 330 } } },
  'League-average hitter': { xBA: '.245', avg: '.242', atBats: 480, splits: { vr: { avg: '.248', atBats: 320 } } },
  'Weak hitter': { xBA: '.218', avg: '.210', atBats: 450, splits: { vr: { avg: '.205', atBats: 300 } } },
  'Overmatched call-up': { xBA: '.185', avg: '.175', atBats: 90, splits: { vr: { avg: '.150', atBats: 60 } } },
};
const PITCHERS = {
  'Ace (Skenes-ish)': { xBA: '.200', avg: '.205', atBats: 650, splits: { vr: { avg: '.186', atBats: 320 } } },
  'Solid starter': { xBA: '.240', avg: '.245', atBats: 620, splits: { vr: { avg: '.242', atBats: 310 } } },
  'League-average arm': { xBA: '.250', avg: '.252', atBats: 600, splits: { vr: { avg: '.255', atBats: 300 } } },
  'Homer-prone long man': { xBA: '.285', avg: '.295', atBats: 400, splits: { vr: { avg: '.310', atBats: 200 } } },
};

function row(batterName, pitcherName, ctx = null) {
  const m = Props.modelHitProbability(BATTERS[batterName], PITCHERS[pitcherName], 'R', 'R', ctx);
  const tier = m.tier.label.padEnd("Pitcher's edge".length);
  return `${batterName.padEnd(26)} vs ${pitcherName.padEnd(22)} ${m.prob.padStart(5)}%  ${tier}`;
}

console.log('== MATCHUP GRID (per-PA hit probability, neutral count) ==');
Object.keys(BATTERS).forEach((b) => {
  Object.keys(PITCHERS).forEach((p) => console.log(row(b, p)));
  console.log('');
});

console.log('== LIVE CONTEXT: good hitter vs solid starter ==');
[['fresh 0-0', null],
 ['ahead 2-0', { count: { balls: 2, strikes: 0 } }],
 ['ahead 3-1', { count: { balls: 3, strikes: 1 } }],
 ['behind 0-2', { count: { balls: 0, strikes: 2 } }],
 ['third look today', { timesFacedToday: 2 }],
].forEach(([label, ctx]) => {
  const m = Props.modelHitProbability(BATTERS['Good hitter'], PITCHERS['Solid starter'], 'R', 'R', ctx);
  console.log(`${label.padEnd(26)} ${m.prob.padStart(5)}%  (${m.tier.label})`);
});

console.log('\n== FORM + HISTORY: league-average hitter, hot streak, owns the pitcher ==');
const m = Props.modelHitProbability(
  { ...BATTERS['League-average hitter'], recent: { avg: '.390', atBats: 30 }, h2h: { avg: '.450', atBats: 20 } },
  PITCHERS['League-average arm'], 'R', 'R', null);
console.log(`hot + h2h: ${m.prob}% vs baseline batter: ${Props.modelHitProbability(BATTERS['League-average hitter'], PITCHERS['League-average arm'], 'R', 'R').prob}%`);
console.log(`drivers: ${m.adjustments.map((a) => `${a.id} ${(a.points * 100).toFixed(1)}`).join(' · ')}`);
