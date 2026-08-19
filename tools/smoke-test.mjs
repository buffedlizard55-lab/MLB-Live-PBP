#!/usr/bin/env node
/* ============================================================================
 * smoke-test.mjs — end-to-end check of the live MLB StatsAPI data layer.
 *
 * Fetches the same endpoints the app uses and validates the JSON shapes the
 * renderers depend on. Fails (exit 1) if anything is missing, so a broken
 * upstream API change fails CI instead of silently breaking the site.
 *
 * Run:  node tools/smoke-test.mjs [YYYY-MM-DD]
 * ==========================================================================*/

const V1 = 'https://statsapi.mlb.com/api/v1';
const V11 = 'https://statsapi.mlb.com/api/v1.1';

const date = process.argv[2] || new Date().toISOString().slice(0, 10);

let failures = 0;

function check(label, ok, extra) {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${label}${ok || !extra ? '' : ` — ${extra}`}`);
  if (!ok) failures += 1;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/* ---------------------------------------------------------------- schedule */

console.log(`\n== schedule for ${date} ==`);
let games = [];
try {
  const sched = await getJSON(
    `${V1}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,decisions`);
  check('schedule fetched', !!sched, 'no data object');
  check('schedule has dates array', Array.isArray(sched.dates));
  games = sched.dates && sched.dates[0] ? sched.dates[0].games : [];
  check('schedule returns games', Array.isArray(games), `${games.length} games`);
  if (games.length) {
    const g = games[0];
    check('game has gamePk', typeof g.gamePk === 'number', `gamePk=${g.gamePk}`);
    check('game has teams.away/home', !!(g.teams && g.teams.away && g.teams.home));
    check('game has status', !!(g.status && g.status.abstractGameState));
    check('game has leagueRecord', !!(g.teams.away.leagueRecord && g.teams.home.leagueRecord));
  }
} catch (err) {
  check('schedule fetched', false, err.message);
}

/* ---------------------------------------------------------------- live feed */

console.log('\n== live feed ==');
let feedPk = null;
try {
  const sched = await getJSON(`${V1}/schedule?sportId=1&date=${date}`);
  const list = sched.dates && sched.dates[0] ? sched.dates[0].games : [];
  if (!list.length) {
    console.log('  (no games this date — skipping feed test)');
  } else {
    // prefer a live game, else the first game
    feedPk = (list.find((g) => g.status.abstractGameState === 'Live') || list[0]).gamePk;

    let feed;
    try {
      feed = await getJSON(`${V11}/game/${feedPk}/feed/live`);
      check('feed/live v1.1 fetched', !!feed);
    } catch (e) {
      check('feed/live v1.1 fetched', false, e.message);
      feed = await getJSON(`${V1}/game/${feedPk}/feed/live`);
      check('feed/live v1 fallback fetched', !!feed);
    }

    check('feed has gameData.status', !!(feed.gameData && feed.gameData.status),
      JSON.stringify(feed.gameData && feed.gameData.status));
    check('feed has gameData.teams', !!(feed.gameData && feed.gameData.teams &&
      feed.gameData.teams.away && feed.gameData.teams.home));
    check('feed has players map', !!(feed.gameData && feed.gameData.players));

    const plays = feed.liveData && feed.liveData.plays;
    check('feed has liveData.plays', !!plays);
    check('feed has allPlays array', !!(plays && Array.isArray(plays.allPlays)),
      `${plays && plays.allPlays ? plays.allPlays.length : 0} plays`);

    const first = plays && plays.allPlays && plays.allPlays[0];
    if (first) {
      check('play has result.description', !!(first.result && first.result.description));
      check('play has about (inning/halfInning)', !!(first.about && first.about.inning &&
        (first.about.halfInning === 'top' || first.about.halfInning === 'bottom')));
      check('play has count', !!(first.count && 'balls' in first.count && 'strikes' in first.count));
      check('play has matchup.batter/pitcher',
        !!(first.matchup && first.matchup.batter && first.matchup.pitcher),
        first.matchup && first.matchup.batter && first.matchup.batter.fullName);
    }

    const cp = plays && plays.currentPlay;
    if (cp) {
      check('currentPlay has matchup', !!(cp.matchup && cp.matchup.batter && cp.matchup.pitcher),
        cp.matchup && cp.matchup.batter && cp.matchup.batter.fullName);
      check('currentPlay has count', !!(cp.count && 'balls' in cp.count));
    } else {
      console.log('  (no currentPlay in feed)');
    }

    const ls = feed.liveData && feed.liveData.linescore;
    check('feed has linescore', !!ls);
    if (ls) {
      check('linescore has teams totals', !!(ls.teams && ls.teams.away && ls.teams.home));
      check('linescore has innings array', Array.isArray(ls.innings), `${ls.innings.length} innings`);
      check('linescore has inningState', typeof ls.inningState === 'string');
    }

    const box = feed.liveData && feed.liveData.boxscore;
    check('feed has boxscore', !!box);
    if (box && box.teams) {
      for (const side of ['away', 'home']) {
        const t = box.teams[side];
        check(`boxscore ${side} has players`, !!(t && t.players));
        check(`boxscore ${side} has battingOrder`, Array.isArray(t && t.battingOrder),
          `${t && t.battingOrder ? t.battingOrder.length : 0} hitters`);
        check(`boxscore ${side} has teamStats`, !!(t && t.teamStats &&
          t.teamStats.batting && t.teamStats.pitching));
      }
    }

    /* replay-review / challenge data (shapes verified 2026-08-19) */
    const gd2 = feed.gameData || {};
    if (gd2.review) {
      const r = gd2.review;
      check('gameData.review has per-team counts',
        !!r.away && typeof r.away.used === 'number' && typeof r.away.remaining === 'number' &&
        !!r.home && typeof r.home.used === 'number' && typeof r.home.remaining === 'number',
        JSON.stringify(r));
    } else {
      check('gameData.review present', false, 'missing gameData.review');
    }
    const abs = gd2.absChallenges;
    if (abs) {
      check('gameData.absChallenges has usedSuccessful/usedFailed/remaining',
        !!abs.away && typeof abs.away.usedSuccessful === 'number' &&
        typeof abs.away.usedFailed === 'number' && typeof abs.away.remaining === 'number' &&
        !!abs.home && typeof abs.home.usedSuccessful === 'number' &&
        typeof abs.home.usedFailed === 'number' && typeof abs.home.remaining === 'number',
        JSON.stringify(abs));
    } else {
      check('gameData.absChallenges present', false, 'missing gameData.absChallenges');
    }

    // Scan every play for review markers; a feed from an active/recent date
    // will usually have at least the structures (empty is OK for a clean game).
    let reviewDetailCount = 0;
    let hasReviewEventCount = 0;
    for (const p of plays.allPlays || []) {
      if (p.reviewDetails) reviewDetailCount += 1;
      for (const e of p.playEvents || []) {
        if (e.reviewDetails) reviewDetailCount += 1;
        if (e.details && e.details.hasReview === true) hasReviewEventCount += 1;
      }
    }
    console.log(`  (reviewDetails entries: ${reviewDetailCount}, details.hasReview events: ${hasReviewEventCount})`);
    check('reviewDetails shape sane',
      !(plays.allPlays || []).some((p) => p.reviewDetails && typeof p.reviewDetails.isOverturned !== 'boolean' && !p.reviewDetails.inProgress),
      'reviewDetails should carry isOverturned or inProgress');
  }
} catch (err) {
  check('live feed test', false, err.message);
}

/* ------------------------------------------------------- hit-model stats */

console.log('\n== hit-model people stats (the exact URLs props.js sends) ==');
for (const [label, url] of [
  ['hitting bundle', `${V1}/people/592450/stats?stats=expectedStatistics%2Cseason%2CstatSplits%2CgameLog&group=hitting&sitCodes=vl%2Cvr&season=${date.slice(0, 4)}`],
  ['pitching bundle', `${V1}/people/656302/stats?stats=expectedStatistics%2Cseason%2CstatSplits%2CgameLog&group=pitching&sitCodes=vl%2Cvr&season=${date.slice(0, 4)}`],
]) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await res.json();
    check(`${label} HTTP 200`, res.status === 200, `HTTP ${res.status}`);
    check(`${label} returns stats array`, Array.isArray(body && body.stats), body && body.message);
    check(`${label} includes expectedStatistics`, (body && body.stats || []).some((s) =>
      /expected/i.test(((s && s.type) || {}).displayName || '')), 'missing expectedStatistics');
  } catch (err) {
    check(`${label} fetched`, false, err.message);
  }
}

/* schedule hydrate=review regression guard (the scoreboard / feed rely on it) */
console.log('\n== schedule hydrate=review ==');
try {
  const sched = await getJSON(`${V1}/schedule?sportId=1&date=${date}&hydrate=review`);
  const list = sched.dates && sched.dates[0] ? sched.dates[0].games : [];
  const bad = list.filter((g) => !g.review || !g.review.away || typeof g.review.away.used !== 'number');
  check('every game carries review.away/home.used/remaining', bad.length === 0,
    `${bad.length} games missing review hydration`);
} catch (err) {
  check('schedule hydrate=review fetched', false, err.message);
}

/* official team names / abbreviations (replay feed regression guard, 2026-08-19):
 * the schedule's team objects carry ONLY { id, name, link } — the replay feed
 * rendered `${team.abbreviation}` from them and showed "undefined @ undefined".
 * Official full names must come from the schedule; official abbreviations from
 * GET /teams. Both are asserted here so an upstream shape change fails CI. */
console.log('\n== official team names + abbreviations ==');
try {
  const dir = await getJSON(`${V1}/teams?sportId=1&season=${date.slice(0, 4)}`);
  const clubs = dir.teams || [];
  check('teams directory returns 30 clubs', clubs.length === 30, `${clubs.length} clubs`);
  check('every club has id + official name + abbreviation',
    clubs.every((t) => typeof t.id === 'number' && typeof t.name === 'string' && t.name.length > 0 &&
      typeof t.abbreviation === 'string' && t.abbreviation.length > 0));

  const ids = new Set(clubs.map((t) => t.id));
  const schedTeams = games.flatMap((g) => [
    g.teams && g.teams.away && g.teams.away.team,
    g.teams && g.teams.home && g.teams.home.team,
  ]).filter(Boolean);
  check('schedule teams carry official full names',
    schedTeams.length > 0 && schedTeams.every((t) => typeof t.name === 'string' && t.name.length > 0),
    `${schedTeams.length} team objects`);
  check('every schedule team id resolves in the teams directory',
    schedTeams.every((t) => ids.has(t.id)));
  const abbrevOnSched = schedTeams.filter((t) => 'abbreviation' in t).length;
  console.log(`  (schedule team objects with an abbreviation field: ${abbrevOnSched}/${schedTeams.length}` +
    ' — the app must not depend on it)');
} catch (err) {
  check('teams directory fetched', false, err.message);
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
