#!/usr/bin/env node
/* ============================================================================
 * api-rate-limit-test.mjs — deterministic tests for the HTTP-429 self
 * throttle added to assets/js/api.js on 2026-09-05 (see docs/latency-audit.md
 * addendum): the MLB StatsAPI publishes no rate limit and needs no key, but
 * it CAN answer 429 — the service's own "slow down" signal. The client must
 * honor it: after ANY 429, every getJSON() call waits out the remainder of a
 * 60s quiet period before spending another request, and normal 2xx/4xx/5xx
 * traffic never trips it.
 *
 * api.js is booted in a VM with a stubbed fetch, a recording setTimeout
 * (so the test can SEE the backoff sleep), and a controllable Date.now().
 *
 * Run: node tools/api-rate-limit-test.mjs
 * ==========================================================================*/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSource = readFileSync(path.join(here, '..', 'assets', 'js', 'api.js'), 'utf8');

/* ------------------------------------------------ fake clock + recording timers */

let fakeNow = 1_000_000; // arbitrary epoch ms
class FakeDate extends Date {
  static now() { return fakeNow; }
}

const timers = new Map();
let timerId = 0;
const cleared = new Set();
const sleepsSeen = [];

function fakeSetTimeout(fn, ms) {
  timerId += 1;
  timers.set(timerId, { fn, ms: Number.isFinite(ms) ? ms : 0 });
  return timerId;
}
function fakeClearTimeout(id) {
  cleared.add(id);
  timers.delete(id);
}
/** Resolve pending timers immediately (advancing the fake clock), recording
 *  any timer that was NEVER cleared with a delay >= threshold — those are
 *  deliberate sleeps (the 429 backoff), not abort-timeout guards. */
async function drain(sleepThresholdMs = 1000) {
  for (;;) {
    let slept = 0;
    for (const [id, t] of [...timers.entries()]) {
      fakeNow += t.ms;
      timers.delete(id);
      if (t.ms >= sleepThresholdMs && !cleared.has(id)) {
        sleepsSeen.push(t.ms);
        slept += t.ms;
      }
      if (typeof t.fn === 'function') t.fn();
      await new Promise((r) => setImmediate(r));
    }
    if (!timers.size) break;
  }
}

/* ------------------------------------------------------ stub fetch (recording) */

const fetchLog = [];
let respond = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

async function fakeFetch(url) {
  fetchLog.push(url);
  const r = respond();
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.json,
  };
}

/* ------------------------------------------------------------------- boot */

const context = {
  console: { warn() {}, error() {}, log() {} },
  Map, Set, Math, Number, String, Object, Array, URLSearchParams, RegExp, JSON,
  Date: FakeDate,
  fetch: fakeFetch,
  AbortController,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
  setInterval: fakeSetTimeout,
  clearInterval: fakeClearTimeout,
};
context.window = context;
vm.createContext(context);
vm.runInContext(apiSource, context, { filename: 'assets/js/api.js' });
// Top-level `const MLB` lives in the vm's global lexical scope (not on the
// global object), so read it back with a script expression (same trick as
// tools/api-fields-test.mjs).
const MLB = vm.runInContext('MLB', context);

assert.equal(typeof MLB.rateLimitedForMs, 'function', 'rateLimitedForMs is exported');

/* 1. Fresh state: no backoff armed, a normal call never sleeps. */
{
  assert.equal(MLB.rateLimitedForMs(), 0, 'no quiet period before any 429');
  const data = await MLB.getSchedule('2026-09-05', { retries: 0 });
  assert.ok(Array.isArray(data), 'schedule call succeeds');
  await drain();
  assert.equal(sleepsSeen.length, 0, 'a 2xx path never sleeps');
  assert.equal(MLB.rateLimitedForMs(), 0);
  console.log('  1 normal 2xx traffic never sleeps — ok');
}

/* 2. A 429 arms the quiet period and still surfaces the error. */
{
  respond = () => ({ status: 429, json: { error: 'slow down' } });
  let threw = null;
  try { await MLB.getSchedule('2026-09-05', { retries: 0 }); }
  catch (err) { threw = err; }
  assert.ok(threw && threw.status === 429, 'the 429 propagates to the caller');
  const remaining = MLB.rateLimitedForMs();
  assert.ok(remaining > 59_000 && remaining <= 60_000,
    `quiet period ~60s armed (got ${remaining}ms)`);
  console.log('  2 a 429 arms the ~60s quiet period — ok');
}

/* 3. The NEXT call on ANY endpoint first waits out the quiet period. */
{
  respond = () => ({ status: 200, json: { allPlays: [], currentPlay: null } });
  const before = fetchLog.length;
  const promise = MLB.getPlayByPlay(823342, { retries: 0, timeout: 5000 });
  await drain();
  const pbp = await promise;
  assert.ok(pbp && Array.isArray(pbp.allPlays), 'the throttled call completes after waiting');
  assert.equal(fetchLog.length, before + 1, 'exactly one request was spent');
  assert.equal(sleepsSeen.length, 1,
    'the request was preceded by exactly ONE deliberate backoff sleep');
  assert.ok(sleepsSeen[0] >= 59_000 && sleepsSeen[0] <= 60_000,
    `the sleep covered the remaining quiet period (got ${sleepsSeen[0]}ms)`);
  console.log('  3 next request waits out the quiet period first — ok');
}

/* 4. The quiet period is time-based: after it expires, no sleep. */
{
  sleepsSeen.length = 0;
  fakeNow += 61_000;
  assert.equal(MLB.rateLimitedForMs(), 0, 'quiet period expired');
  await MLB.getTeams(2026);
  await drain();
  assert.equal(sleepsSeen.length, 0, 'no sleep once the window cleared');
  console.log('  4 backoff expires with time — ok');
}

/* 5. A 429 on one endpoint throttles every endpoint (one shared budget). */
{
  respond = () => ({ status: 429, json: {} });
  // NB: season 2027 is not cached (test 4 cached 2026), so this really fetches.
  // getTeams uses getJSON's default retries:1, so drive it through drain()
  // (which advances the fake clock through the 150ms retry backoff).
  const p = (async () => { try { await MLB.getTeams(2027); } catch (err) { /* expected */ } })();
  await drain();
  await p;
  assert.ok(MLB.rateLimitedForMs() > 0, 'shared flag armed by /teams 429');
  respond = () => ({ status: 200, json: { gameData: {} } });
  sleepsSeen.length = 0;
  const promise = MLB.getGameStatus(823342, { retries: 0 });
  await drain();
  await promise;
  assert.equal(sleepsSeen.length, 1, 'the per-game projection was throttled too');
  console.log('  5 one shared budget across endpoints — ok');
}

/* 6. Ordinary failures (404 / 500) never arm the backoff. */
{
  fakeNow += 61_000;
  for (const status of [404, 500, 503]) {
    respond = () => ({ status, json: {} });
    try { await MLB.getSchedule('2026-09-05', { retries: 0 }); }
    catch (err) { /* expected */ }
    assert.equal(MLB.rateLimitedForMs(), 0, `HTTP ${status} does not arm the backoff`);
  }
  console.log('  6 non-429 failures never arm the backoff — ok');
}

console.log('\napi rate-limit backoff tests passed');
