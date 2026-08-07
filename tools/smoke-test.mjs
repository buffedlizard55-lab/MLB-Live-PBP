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
  }
} catch (err) {
  check('live feed test', false, err.message);
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
