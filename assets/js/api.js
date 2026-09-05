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

  /* ------------------------------------------------------------------ rate
   * The StatsAPI publishes no rate limit and needs no key, but it CAN answer
   * HTTP 429 ("Too Many Requests") — the service's own "slow down" signal.
   * Honoring it is part of being a good citizen: after ANY 429, every
   * endpoint funneled through getJSON() waits out the remainder of a 60s
   * quiet period before issuing its next request, so a page that polls at
   * 250ms automatically throttles itself to ~1 request per minute per
   * outstanding call until the window clears. The flag is process-wide (all
   * endpoints share one host and one budget). Normal 2xx/4xx/5xx traffic
   * never trips it.
   */
  const RATE_LIMIT_BACKOFF_MS = 60 * 1000;
  let lastRateLimitedAt = 0;

  /** Milliseconds remaining in the current 429 quiet period (0 = none). */
  function rateLimitedForMs() {
    return lastRateLimitedAt
      ? Math.max(0, lastRateLimitedAt + RATE_LIMIT_BACKOFF_MS - Date.now())
      : 0;
  }

  /** Fetch JSON with a timeout + simple exponential retry. */
  async function getJSON(url, { timeout = 8000, retries = 1, signal, cache = 'no-store' } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      // Honor a prior 429 before spending another request. This delays the
      // call itself (rather than throwing) so callers keep their ordinary
      // error handling; the timeout budget below still applies to the fetch.
      const quiet = rateLimitedForMs();
      if (quiet > 0) await sleep(quiet);
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
          if (res.status === 429) lastRateLimitedAt = Date.now();
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
      // Short backoff: a retry after 400ms still lands faster than the next
      // poll, so keep it as low as the network stack tolerates (150ms).
      if (attempt < retries) await sleep(150 * (2 ** attempt));
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
    // The schedule is small; a 5s abort cap (instead of the 8s feed default)
    // so a stalled schedule request fails fast and retries quickly.
    const data = await getJSON(url, { timeout: 5000, ...options });
    const dates = (data && data.dates) || [];
    return dates.length ? dates[0].games || [] : [];
  }

  /**
   * Review-status-only schedule sweep for a date — the cheapest possible
   * "is ANY game under review right now?" request.
   *
   * Why it exists (verified live, statsapi.mlb.com, 2026-09-02):
   *   - The official game status flips the instant a review is CALLED, while
   *     the play text the parsers also read is written when the review
   *     RESOLVES. Status is therefore the earliest signal available.
   *   - `status.statusCode` / `codedGameState` are the registry vocabulary
   *     from GET /api/v1/gameStatus (M* manager challenge, N* umpire review,
   *     IH instant replay, MJ/NJ ABS pitch challenge). See
   *     REVIEW_STATUS_BY_CODE in reviews.js.
   *   - A `fields` projection with NO hydrations returns gamePk + status for
   *     the whole slate in ~2.4 KB (1 response chunk) where the hydrated
   *     schedule getSchedule() uses is ~8 chunks. That size is what makes a
   *     250 ms watcher cadence affordable; polling the hydrated schedule at
   *     that rate would be ~30x the bytes for the same two fields.
   *
   * Response shape actually observed:
   *   { dates: [ { games: [ { gamePk, status: { abstractGameState,
   *     codedGameState, detailedState, statusCode, startTimeTBD,
   *     abstractGameCode } } ] } ] }
   * `reason` is additionally whitelisted: the registry attaches it to every
   * review state ("Tag play", "Home run", "Pitch Result", …) and it is
   * absent otherwise, so the projection must name it or the reason is lost.
   */
  const REVIEW_STATUS_FIELDS = [
    'dates', 'games', 'gamePk', 'season',
    'status', 'abstractGameState', 'codedGameState', 'detailedState',
    'statusCode', 'reason', 'startTimeTBD', 'abstractGameCode',
  ];

  async function getReviewStatus(dateStr, options = {}) {
    const url = `${V1}/schedule?sportId=${SPORT_ID}&date=${dateStr}` +
                `&fields=${REVIEW_STATUS_FIELDS.join(',')}`;
    // Small payload, so fail fast: a stalled sweep must not hold the watcher
    // loop. The next tick (250ms later) retries; the ordinary schedule cache
    // keeps working meanwhile.
    const data = await getJSON(url, { timeout: 2500, retries: 0, ...options });
    const dates = (data && data.dates) || [];
    return dates.length ? dates[0].games || [] : [];
  }

  /**
   * Official status of ONE game — a ~150-byte projection of feed/live.
   *
   * Verified live (statsapi.mlb.com, 2026-09-02, game 824470 in progress):
   *   GET /api/v1.1/game/824470/feed/live?fields=gameData,status,
   *       abstractGameState,codedGameState,detailedState,statusCode,reason,
   *       startTimeTBD,abstractGameCode
   *   -> {"gameData":{"status":{"abstractGameState":"Live",
   *      "codedGameState":"I","detailedState":"In Progress",
   *      "statusCode":"I","startTimeTBD":false,"abstractGameCode":"L"}}}
   *
   * The game page uses this to learn that a review started WITHOUT waiting
   * for the 1-2 MB full feed it otherwise downloads every cycle: the status
   * is the field that flips first (see REVIEW_STATUS_BY_CODE in reviews.js),
   * and it is the only field this projection asks for.
   */
  const GAME_STATUS_FIELDS = 'fields=gameData,status,abstractGameState,' +
    'codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode';

  async function getGameStatus(gamePk, options = {}) {
    const opts = { timeout: 2500, retries: 0, ...options };
    try {
      return await getJSON(`${V11}/game/${gamePk}/feed/live?${GAME_STATUS_FIELDS}`, opts);
    } catch (err) {
      if (!isLegacyFeedMiss(err)) throw err;
      return await getJSON(`${V1}/game/${gamePk}/feed/live?${GAME_STATUS_FIELDS}`, opts);
    }
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
   * Official per-team challenge counters for one game, via a `fields`
   * projection of feed/live so the response is tiny (~200 bytes):
   *
   *   gameData.review        -> manager-challenge counters
   *                             { hasChallenges, away/home: { used, remaining } }
   *   gameData.absChallenges -> ABS pitch-challenge counters
   *                             { hasChallenges, away/home:
   *                               { usedSuccessful, usedFailed, remaining } }
   *
   * Both shapes verified live (statsapi.mlb.com, 2026-08-28: games 824638
   * in-progress, 824879 and 823503 final). The SCHEDULE endpoint's
   * `hydrate=review` carries only the manager counters — it does NOT expose
   * absChallenges (verified 2026-08-28), which is why this call exists.
   * Pre-ABS seasons (e.g. 2025 game 776162) have no `absChallenges` at all;
   * callers must treat that as "no ABS data", never as zero.
   */
  async function getChallengeCounts(gamePk, options = {}) {
    const fields = 'fields=gameData,review,absChallenges,hasChallenges,away,home,' +
                   'used,remaining,usedSuccessful,usedFailed';
    // ~200-byte projection: a 4s abort cap so a stalled side-fetch never
    // delays the review feed (the caller treats this as a non-blocking hint).
    try {
      return await getJSON(`${V11}/game/${gamePk}/feed/live?${fields}`, { timeout: 4000, ...options });
    } catch (err) {
      if (!isLegacyFeedMiss(err)) throw err;
      return await getJSON(`${V1}/game/${gamePk}/feed/live?${fields}`, { timeout: 4000, ...options });
    }
  }

  /**
   * Play-by-play only for one game (allPlays + currentPlay + scoringPlays).
   * Much leaner than feed/live (no boxscore/players), and carries the same
   * review data: play-level reviewDetails, event-level details.hasReview and
   * currentPlay. Used by the all-games Replay Feed to scan many games quickly
   * (every poll, ~15 games in parallel) and by game.js's review probe — so
   * PAYLOAD SIZE IS THE LATENCY. A `fields` projection is therefore the
   * default; it was verified live against statsapi.mlb.com on 2026-08-30:
   *   - game 823342 (full): 76 API chunks unprojected vs 26 projected (≈3x
   *     smaller), and the projected response still carries the captured ABS
   *     review at atBatIndex 15 verbatim:
   *       playEvents[].reviewDetails = { isOverturned:false, inProgress:false,
   *                                      reviewType:"MJ", challengeTeamId:116 }
   *     plus details.hasReview, details.eventType/event/description, count,
   *     matchup.batter/pitcher{id,fullName}, runners[].movement/details and
   *     about/result exactly as the unprojected call returns them.
   *   - game 822688 (live): the same projection returns every field the
   *     feed's extractReviews() reads.
   *
   * The field list below is NOT guessed. The REQUIRED names are properties
   * the projected payload is actually read by, line by line (cites in
   * tools/api-fields-test.mjs):
   *   reviews.js extractReviews / processPlay / buildAbsContext /
   *   deriveScoreImpact / reviewedScoringRunners / findReviewedPitch /
   *   scoreBeforePlay / buildPendingScoringEntry  (assets/js/reviews.js)
   *   game.js reviewProbeState                       (assets/js/game.js)
   * A few extra leaf names (isTopInning, rbi, isOut, batSide, pitchHand,
   * call, start, end) are explicitly listed as a belt-and-braces GUARD: the
   * statsapi `fields` parameter is a whitelist applied at any depth, and a
   * named container (about/result/matchup/details/count/reviewDetails/
   * runners/movement) returns its full child objects — so an extra leaf
   * costs bytes only if the API ever prunes a container's children.
   * tools/api-fields-test.mjs pins every whitelisted name to REQUIRED
   * (read) or GUARD (deliberate) — nothing unaccounted.
   */
  const PBP_FIELDS = [
    'allPlays', 'currentPlay',
    // about (play / currentPlay)
    'about', 'atBatIndex', 'inning', 'halfInning', 'isTopInning',
    'startTime', 'endTime', 'isComplete', 'hasReview',
    // result
    'result', 'type', 'event', 'eventType', 'description',
    'rbi', 'awayScore', 'homeScore', 'isOut',
    // matchup
    'matchup', 'batter', 'pitcher', 'id', 'fullName', 'batSide', 'pitchHand',
    // playEvents + pitch data
    'playEvents', 'index', 'isPitch', 'pitchData', 'startSpeed',
    // event details
    'details', 'call',
    // counts
    'count', 'balls', 'strikes', 'outs',
    // review markers (manager ABS / under-review / official-scorer pending
    // detection reads eventType/event/description on details AND result)
    'reviewDetails', 'inProgress', 'isOverturned', 'reviewType', 'challengeTeamId',
    // scoring runners (run-at-risk model; official-scoring-change tracker's
    // movement signature reads originBase → end / outBase)
    'runners', 'movement', 'start', 'end', 'outBase', 'originBase',
    'runner', 'isScoringEvent', 'playIndex',
  ];

  async function getPlayByPlay(gamePk, options = {}) {
    const opts = { timeout: 5000, ...options };
    try {
      return await getJSON(
        `${V1}/game/${gamePk}/playByPlay?fields=${PBP_FIELDS.join(',')}`, opts);
    } catch (errProjected) {
      if (!isLegacyFeedMiss(errProjected)) throw errProjected;
      // A 4xx on the projection can mean this game/version rejected a field
      // name. Fall back to the SAME lean endpoint WITHOUT `fields` (one extra
      // round-trip, rare) before the heavier feed/live fallback — never mask
      // a real review because of a projection quirk.
      try {
        return await getJSON(`${V1}/game/${gamePk}/playByPlay`, opts);
      } catch (errUnprojected) {
        if (!isLegacyFeedMiss(errUnprojected)) throw errUnprojected;
        const feed = await getLiveFeed(gamePk, opts);
        return (feed.liveData && feed.liveData.plays) || {};
      }
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
    getSchedule, getReviewStatus, getGameStatus, getLiveFeed, getPlayByPlay,
    getTeams, getChallengeCounts,
    rateLimitedForMs,
    teamLogoUrl, teamLogoFallbackUrl, headshotUrl,
    ordinal, localTime, localDate, localDateTime,
    inningLabel, inningGlyph, sides, scoreOf,
  };
})();
