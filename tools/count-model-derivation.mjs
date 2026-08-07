#!/usr/bin/env node
/* ============================================================================
 * count-model-derivation.mjs — documentation + sanity checks for the live,
 * in-at-bat count adjustment used by assets/js/props.js.
 *
 * WHY THE TABLE IS EMPIRICALLY ANCHORED (not a pure transition chain):
 * A homogeneous Markov chain over the 12 ball-strike states gives the correct
 * SURVIVAL structure, but its constant per-pitch rates make hitter's counts
 * look *worse* than pitcher's counts for hits — the opposite of reality —
 * because real hitters see better pitches and swing more freely when ahead.
 *
 * The final table (COUNT_FACTORS below, embedded in props.js) is anchored to
 * three published empirical results:
 *   1. FanGraphs, "The Count Is King" (wOBA produced after each count, where
 *      3-0's +73% is mostly WALK value — walks end a PA without a hit, so the
 *      hit-only factor at 3-ball counts is deliberately dampened).
 *   2. SABR / Stanford PITCHf/x study: AVG ahead .313, even .285, behind .218
 *      → behind/even ≈ 0.77, ahead/even ≈ 1.10 (our factors below match).
 *   3. Two-strike hitting ~.180-.190 league-wide (0-2/1-2/2-2 sit ~0.74-0.80
 *      of the 0-0 base — matching), and the widely published ~.160 AVG after
 *      0-2 at PA end (our odds-space factor of 0.74 maps a .245 base → ~.19).
 * ==========================================================================*/

const P = {
  calledStrike: 0.175,
  swingingStrike: 0.110,
  foul: 0.175,
  ball: 0.335,
  inPlayOut: 0.136,
  inPlayHit: 0.069,
};

const MEMO = {};
function hitProb(balls, strikes) {
  if (balls === 4 || strikes === 3) return 0;
  const key = `${balls}-${strikes}`;
  if (MEMO[key] != null) return MEMO[key];
  let value;
  if (strikes === 2) {
    // Foul self-loop solved algebraically: v·(1−foul) = ball·v(b+1,2) + inPlayHit
    value = (P.ball * hitProb(balls + 1, strikes) + P.inPlayHit) / (1 - P.foul);
  } else {
    value =
      P.ball * hitProb(balls + 1, strikes) +
      (P.calledStrike + P.swingingStrike + P.foul) * hitProb(balls, strikes + 1) +
      P.inPlayHit;
  }
  MEMO[key] = value;
  return value;
}

const STATES = [];
for (let b = 0; b <= 3; b += 1) for (let s = 0; s <= 2; s += 1) STATES.push(`${b}-${s}`);

console.log('== homogeneous chain (structure reference only — NOT used in app) ==');
STATES.forEach((c) => console.log(`${c}: ${hitProb(Number(c[0]), Number(c[2])).toFixed(3)}`));

// ---------------------------------------------------------------------------
// FINAL TABLE USED BY props.js — odds multipliers relative to a fresh 0-0
// count: finalOdds = matchupOdds × factor. Constraints: monotone in balls
// within each strike level for pre-3-ball counts; 3-0 dampened (auto-take
// means the next pitch is rarely hittable and most of the count's value is
// the walk, which scores ZERO hits).
// ---------------------------------------------------------------------------
const COUNT_FACTORS = {
  '0-0': 1.00,
  '0-1': 0.93,
  '0-2': 0.74,
  '1-0': 1.07,
  '1-1': 1.00,
  '1-2': 0.77,
  '2-0': 1.15,
  '2-1': 1.08,
  '2-2': 0.80,
  '3-0': 1.12,
  '3-1': 1.16,
  '3-2': 0.92,
};

// Sanity: implied in-at-bat probabilities for a league-average .245 matchup.
console.log('\n== implied P(hit this PA) for a league-average matchup ==');
const L = 0.245;
STATES.forEach((c) => {
  const odds = (L / (1 - L)) * COUNT_FACTORS[c];
  const p = odds / (1 + odds);
  console.log(`${c}: factor ${COUNT_FACTORS[c].toFixed(2)} → ${p.toFixed(3)}  (${((p - L) * 100).toFixed(1)} pts vs 0-0)`);
});

const balls = (c) => Number(c[0]);
const strikes = (c) => Number(c[2]);
STATES.forEach((c) => {
  if (balls(c) < 3) {
    const next = `${balls(c) + 1}-${strikes(c)}`;
    if (!(COUNT_FACTORS[next] >= COUNT_FACTORS[c] - 1e-9)) {
      console.warn(`WARN: non-monotone in balls: ${c} → ${next}`);
    }
  }
  if (strikes(c) < 2) {
    const next = `${balls(c)}-${strikes(c) + 1}`;
    if (!(COUNT_FACTORS[next] <= COUNT_FACTORS[c] + 1e-9)) {
      console.warn(`WARN: non-monotone in strikes: ${c} → ${next}`);
    }
  }
});
console.log('\ndone');
