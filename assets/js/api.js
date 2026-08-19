/* ============================================================================
 * api.js — MLB StatsAPI client
 * ----------------------------------------------------------------------------
 * Wraps the same public, undocumented JSON API that powers mlb.com Gameday:
 *
 *   GET https://statsapi.mlb.com/api/v1/schedule    -> list of games for a date
 *   GET https://statsapi.mlb.com/api/v1.1/game/{pk}/feed/live
 *                                  -> full live feed: play-by-play, linescore,
 *                                     boxscore, decisions, player/team metadata
 *   GET https://statsapi.mlb.com/api/v1/game/{pk}/playByPlay|boxscore|linescore
 *                                  -> fallback endpoints (older versions)
 *
 * No API key or authentication is required. The API is open-CORS, so it can
 * be called straight from a static site (e.g. GitHub Pages) in the browser.
 * ==========================================================================*/
'use strict';

const MLB = (() => {
  const V1  = 'https://statsapi.mlb.com/api/v1';
  const V11 = 'https://statsapi.mlb.com/api/v1.1';
  const SPORT_ID = 1; // Major League Baseball

  const LOGO_CDN = 'https://www.mlbstatic.com/team-logos';
  const HEADSHOT_CDN =
    'https://img.mlbstatic.com/mlb-photos/image/upload/w_213,d_people:generic:headshot:silo:current.png,q_auto:best,f_auto/v1/people';

  /* ------------------------------------------------------------------ utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Fetch JSON with a timeout + simple exponential retry. */
  async function getJSON(url, { timeout = 8000, retries = 1, signal, cache = 'no-store' } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          cache,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} for ${url}`);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      // A caller cancellation is deliberate; don't retry or mask it.
      if (signal && signal.aborted) throw lastErr;
      if (attempt < retries) await sleep(400 * (2 ** attempt));
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------- endpoints */

  /**
   * Schedule for a calendar date (local "official date").
   * Hydrations mirror what mlb.com's scoreboard fetches:
   *   - probablePitcher : starting pitchers for preview cards
   *   - linescore       : live inning / count / score for scoreboard cards
   *   - decisions       : W/L/S pitchers on finished games
   */
  async function getSchedule(dateStr, options = {}) {
    const url = `${V1}/schedule?sportId=${SPORT_ID}&date=${dateStr}` +
                '&hydrate=probablePitcher,linescore,decisions,review,team';
    const data = await getJSON(url, options);
    const dates = (data && data.dates) || [];
    return dates.length ? dates[0].games || [] : [];
  }

  /**
   * Full live feed for one game (the "Gameday" payload).
   * Tries v1.1 first (the version the schedule links to), falls back to v1,
   * then assembles a bundle from the older split endpoints.
   */
  function isLegacyFeedMiss(err) {
    // Only try the older endpoints when this feed version is actually unavailable.
    // Retrying a network/timeout failure against four endpoints is slower and adds load.
    return err && [400, 404, 410].includes(err.status);
  }

  async function getLiveFeed(gamePk, options = {}) {
    try {
      return await getJSON(`${V11}/game/${gamePk}/feed/live`, options);
    } catch (err1) {
      if (!isLegacyFeedMiss(err1)) throw err1;
      try {
        return await getJSON(`${V1}/game/${gamePk}/feed/live`, options);
      } catch (err2) {
        if (!isLegacyFeedMiss(err2)) throw err2;
        const [pbp, box, ls] = await Promise.all([
          getJSON(`${V1}/game/${gamePk}/playByPlay`, options),
          getJSON(`${V1}/game/${gamePk}/boxscore`, options),
          getJSON(`${V1}/game/${gamePk}/linescore`, options),
        ]);
        return {
          gamePk,
          gameData: {},
          liveData: { plays: pbp, boxscore: box, linescore: ls, decisions: {} },
        };
      }
    }
  }

  /**
   * Official team directory for a season: resolves teamId -> full club
   * metadata { id, name, abbreviation, teamName, locationName }.
   *
   * Why this exists (verified against live responses, 2026-08-19): the
   * SCHEDULE endpoint's `teams.away.team` objects carry only
   * `{ id, name, link }` — NO `abbreviation`. The official abbreviations
   * therefore come from this directory instead of being invented. Cached per
   * season for the page's lifetime; one small request per page load.
   */
  const teamsCache = {};

  async function getTeams(season) {
    const seasonId = season || new Date().getFullYear();
    if (!teamsCache[seasonId]) {
      teamsCache[seasonId] = getJSON(`${V1}/teams?sportId=${SPORT_ID}&season=${seasonId}`)
        .then((data) => {
          const byId = {};
          ((data && data.teams) || []).forEach((t) => {
            if (t && t.id != null) {
              byId[t.id] = {
                id: t.id,
                name: t.name || null,
                abbreviation: t.abbreviation || null,
                teamName: t.teamName || null,
                locationName: t.locationName || null,
              };
            }
          });
          return byId;
        })
        .catch((err) => {
          delete teamsCache[seasonId]; // allow a retry on a later poll
          throw err;
        });
    }
    return teamsCache[seasonId];
  }

  /**
   * Play-by-play only for one game (allPlays + currentPlay + scoringPlays).
   * Much leaner than feed/live (no boxscore/players), and carries the same
   * review data: play-level reviewDetails, event-level details.hasReview and
   * currentPlay. Used by the all-games Replay Feed to scan many games quickly.
   * Falls back to feed/live if the split endpoint is unavailable.
   */
  async function getPlayByPlay(gamePk, options = {}) {
    try {
      return await getJSON(`${V1}/game/${gamePk}/playByPlay`, options);
    } catch (err) {
      if (!isLegacyFeedMiss(err)) throw err;
      const feed = await getLiveFeed(gamePk, options);
      return (feed.liveData && feed.liveData.plays) || {};
    }
  }

  /* -------------------------------------------------------------- CDN URLs */

  /** Team logo SVG (light-on-dark cap variant, then plain, then a colored circle fallback). */
  function teamLogoUrl(teamId) {
    return `${LOGO_CDN}/team-cap-on-dark/${teamId}.svg`;
  }
  function teamLogoFallbackUrl(teamId) {
    return `${LOGO_CDN}/${teamId}.svg`;
  }

  /** Player headshot. */
  function headshotUrl(personId) {
    return `${HEADSHOT_CDN}/${personId}/headshot/67/current`;
  }

  /* ------------------------------------------------------------- formatters */

  const ORDINALS = ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'];

  function ordinal(n) {
    if (n == null) return '';
    const n10 = n % 100;
    const suffix = (n10 >= 11 && n10 <= 13) ? 'th' : ORDINALS[n % 10] || 'th';
    return `${n}${suffix}`;
  }

  /** "2026-08-07T22:40:00Z" -> local "7:40 PM" */
  function localTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function localDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function localDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }

  /**
   * Compact inning label from a linescore, mlb.com style:
   *   "Top 5", "Bottom 5", "Mid 5" — and "Final", "Final/10" for done games.
   */
  function inningLabel(linescore, status) {
    if (!linescore) return '';
    if (status && status.abstractGameState === 'Final') {
      const n = (linescore.innings || []).length;
      return n > 9 ? `Final/${n}` : 'Final';
    }
    const st = (linescore.inningState || '').toLowerCase();
    const num = linescore.currentInning != null
      ? String(linescore.currentInning)
      : linescore.currentInningOrdinal || '';
    if (st === 'top') return `Top ${num}`;
    if (st === 'bottom') return `Bot ${num}`;
    if (st === 'middle') return `Mid ${num}`;
    if (st === 'end') return `End ${num}`;
    return num ? `${st} ${num}` : '';
  }

  /** "▲ 5" / "▼ 5" / "◆ 5" glyph + label for scoreboard cards. */
  function inningGlyph(linescore) {
    if (!linescore) return '';
    const st = (linescore.inningState || '').toLowerCase();
    const num = linescore.currentInning != null
      ? String(linescore.currentInning)
      : linescore.currentInningOrdinal || '';
    if (st === 'top') return `▲ ${num}`;
    if (st === 'bottom') return `▼ ${num}`;
    if (st === 'middle') return `◆ ${num}`;
    return '';
  }

  /** Home/Away split used everywhere: keys 'away' and 'home'. */
  function sides() { return ['away', 'home']; }

  /** Score of a game from the schedule object. */
  function scoreOf(game, side) {
    const t = game.teams && game.teams[side];
    return t && typeof t.score === 'number' ? t.score : null;
  }

  return {
    getSchedule, getLiveFeed, getPlayByPlay, getTeams,
    teamLogoUrl, teamLogoFallbackUrl, headshotUrl,
    ordinal, localTime, localDate, localDateTime,
    inningLabel, inningGlyph, sides, scoreOf,
  };
})();
