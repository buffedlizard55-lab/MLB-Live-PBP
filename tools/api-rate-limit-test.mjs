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
// Real-clock epoch minus fake-clock epoch, so a date string BUILT from fake
// time parses back to the same fake instant (Date.parse stays coherent with
// Date.now — needed by the Retry-After HTTP-date case).
const realEpochOffset = Date.now() - fakeNow;
class FakeDate extends Date {
  static now() { return fakeNow; }
  static parse(str) {
    const real = Date.parse(str);
    return Number.isFinite(real) ? real - realEpochOffset : NaN;
  }
}

/** HTTP-date string for a fake-clock instant (fake now + ms). RFC 9110
 *  HTTP-dates carry whole seconds, so the parsed delay can be up to 999ms
 *  shorter than requested — assertions below allow for that. */
function fakeDateString(ms) {
  return new Date(realEpochOffset + fakeNow + ms).toUTCString();
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
    // Real fetch exposes a Headers object; a stub that omits it must not
    // break the Retry-After probe (guarded in api.js).
    headers: r.headers,
  };
}

/** Minimal Headers stand-in exposing only what api.js reads. */
function fakeHeaders(map) {
  return { get: (name) => (map[String(name).toLowerCase()] ?? null) };
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

/* 7. Retry-After is the SERVER's own instruction: a short window is honored
 * exactly (waits the server's number, not a flat 60s), which is what makes a
 * 429 cost 2s instead of 60s when the API says so. */
{
  fakeNow += 10 * 60 * 1000;
  assert.equal(MLB.rateLimitedForMs(), 0, 'fresh state before the header case');
  respond = () => ({ status: 429, json: {}, headers: fakeHeaders({ 'retry-after': '2' }) });
  try { await MLB.getSchedule('2026-09-05', { retries: 0 }); } catch (err) { /* expected */ }
  const remaining = MLB.rateLimitedForMs();
  assert.ok(remaining > 1900 && remaining <= 2000,
    `Retry-After: 2 -> a ~2s quiet period, not 60s (got ${remaining}ms)`);
  respond = () => ({ status: 200, json: { allPlays: [], currentPlay: null } });
  sleepsSeen.length = 0;
  const promise = MLB.getPlayByPlay(823342, { retries: 0, timeout: 5000 });
  await drain();
  await promise;
  assert.equal(sleepsSeen.length, 1, 'the follow-up request still waits first');
  assert.ok(sleepsSeen[0] > 1900 && sleepsSeen[0] <= 2000,
    `it waited the server-named 2s (got ${sleepsSeen[0]}ms)`);
  console.log('  7 Retry-After (seconds) replaces the default window — ok');
}

/* 8. An HTTP-date Retry-After is parsed too, and the window is clamped on
 * both ends: a bogus "0" still waits the 1s floor (never hammer), an absurd
 * 10-minute value is capped at 5 minutes (never park the page forever). */
{
  /** Fire one 429 carrying `headerValue` (a value, or () => value, so a
   *  date string can be built from the CURRENT fake clock) and return the
   *  quiet period it armed. Deliberately NOT driven through drain(): with
   *  retries:0 there is no backoff sleep to flush, the abort guard is cleared
   *  when the fetch rejects, and advancing the fake clock here would spend
   *  part of the very window being measured. */
  async function armWith(headerValue) {
    fakeNow += 10 * 60 * 1000; // expire any previous window (so no pre-sleep)
    const value = typeof headerValue === 'function' ? headerValue() : headerValue;
    respond = () => ({ status: 429, json: {}, headers: fakeHeaders({ 'retry-after': value }) });
    try { await MLB.getPlayByPlay(823342, { retries: 0, timeout: 5000 }); }
    catch (err) { /* expected: the 429 propagates */ }
    return MLB.rateLimitedForMs();
  }

  const parsedDate = MLB.parseRetryAfter(fakeDateString(4000));
  assert.ok(parsedDate > 3000 && parsedDate <= 4000,
    `HTTP-date form parsed to ~4s of fake-clock delay (got ${parsedDate}ms)`);
  const dated = await armWith(() => fakeDateString(4000));
  assert.ok(dated > 3000 && dated <= 4000,
    `date form armed a ~4s (whole-second) window (got ${dated}ms)`);

  const floored = await armWith('0');
  assert.ok(floored > 900 && floored <= 1000,
    `Retry-After: 0 is floored at 1s, never "retry now" (got ${floored}ms)`);

  const capped = await armWith('600');
  assert.ok(capped > 299_000 && capped <= 300_000,
    `Retry-After: 600 is capped at 5min (got ${capped}ms)`);

  // A malformed header falls back to the documented default 60s.
  const fallback = await armWith('soon-ish');
  assert.ok(fallback > 59_000 && fallback <= 60_000,
    `unparseable Retry-After -> default 60s (got ${fallback}ms)`);
  assert.equal(MLB.parseRetryAfter('soon-ish'), null, 'unparseable -> null (use the default)');
  assert.equal(MLB.parseRetryAfter(null), null, 'absent -> null (use the default)');
  assert.equal(MLB.parseRetryAfter(''), null, 'empty -> null (use the default)');
  assert.equal(MLB.parseRetryAfter('0'), 0, 'a valid "0" parses to 0 (floored at the call site)');
  console.log('  8 date form + clamps [1s, 5min] + malformed fallback — ok');
}

console.log('\napi rate-limit backoff tests passed');
