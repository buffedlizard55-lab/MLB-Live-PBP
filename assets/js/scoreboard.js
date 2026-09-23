/* ============================================================================
 * scoreboard.js — today's games, mlb.com scoreboard style
 * ==========================================================================*/
'use strict';

(() => {
  // Live scoreboard: 1s. While any game's official status says challenge/
  // review: 250ms so the review ticker is not waiting on the ordinary live
  // interval. Cadence is the gap between poll STARTS — scheduleNext()
  // subtracts the request we just finished, so a slow response does not
  // stretch the cycle.
  const LIVE_POLL_MS = 500;
  const REVIEW_POLL_MS = 250;
  const IDLE_POLL_MS = 5000;
  // Standalone review-status watcher (added 2026-09-05 — see
  // docs/latency-audit.md addendum). While any game is live, sweep the
  // `fields`-projected, hydration-free schedule (MLB.getReviewStatus:
  // gamePk + status for the whole slate in ~2.4 KB / 1 chunk — verified live
  // 2026-09-02 and again 2026-09-05) every 250ms, so the 🚨 review ticker /
  // card badges appear the moment MLB flips a status to a review code
  // (M*/N*/IH — the field that changes the instant a review is CALLED)
  // instead of on the next 500ms hydrated-schedule poll. The hydrated
  // schedule keeps its own 500ms cadence for scores/counts; only status
  // flips ride this fast, tiny sweep. Parks at 5s (no requests) when the
  // slate has nothing live and whenever the tab is hidden.
  const REVIEW_STATUS_POLL_MS = 250;
  const REVIEW_STATUS_IDLE_MS = 5000;
  const REVIEW_STATUS_TIMEOUT_MS = 2500;

  let dateStr = todayStr();
  let games = [];
  let filter = 'all';
  let pollTimer = null;
  let requestInFlight = false;
  let lastCycleStartedAt = 0;
  // Review-status watcher state: its own timer (never shares pollTimer), an
  // in-flight guard so a sweep can never overlap itself, and the last
  // observed gamePk -> status signature the diff runs against.
  let reviewStatusTimer = null;
  let reviewStatusInFlight = false;
  let reviewStatusCodes = new Map();
  let scoringChangesByGame = new Map();

  async function loadScoringChangesForSlate(requestDate) {
    if (!window.MLBFeedLog) return;
    try {
      const map = await window.MLBFeedLog.getScoringChangesByGame(requestDate);
      if (requestDate === dateStr && map && map.size) {
        scoringChangesByGame = map;
        render();
      }
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ state */

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function shiftDate(days) {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    scoringChangesByGame.clear();
  }

  /* ------------------------------------------------------------------ fetch */

  async function load() {
    // Never let an older response overwrite a newly selected date.
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
    lastCycleStartedAt = Date.now();
    const listEl = $('#game-list');
    const banner = $('#banner');
    const statusLine = $('#status-line');

    // Keep cards on screen during background refreshes; it is faster and avoids flicker.
    if (!games.length) UI.clear(listEl).appendChild(spinner());
    UI.clear(banner);
    if (!games.length) statusLine.textContent = 'Loading…';

    try {
      const nextGames = await MLB.getSchedule(requestDate);
      if (requestDate !== dateStr) return;
      games = nextGames;
      loadScoringChangesForSlate(requestDate);
      render();
      statusLine.textContent =
        `${games.length} game${games.length === 1 ? '' : 's'} · ` +
        `${games.filter((g) => g.status.abstractGameState === 'Live').length} in progress · ` +
        `updated ${new Date().toLocaleTimeString()}`;
      scheduleNext();
    } catch (err) {
      if (requestDate !== dateStr) return;
      console.error(err);
      if (!games.length) UI.clear(listEl);
      banner.appendChild(UI.el('div', 'banner-error',
        `Couldn't reach the MLB StatsAPI (${err.message || err}). ` +
        'Check your connection and try again.'));
      banner.appendChild(UI.el('button', 'btn', 'Retry', { onclick: 'Scoreboard.retry()' }));
      statusLine.textContent = 'Load failed — retrying soon';
      scheduleNext(10000);
    } finally {
      requestInFlight = false;
      // A date click during an in-flight request is served immediately afterward.
      if (requestDate !== dateStr) load();
    }
  }

  /**
   * Is this game under review RIGHT NOW?
   *
   * Single source of truth for the whole page: MLBReviews' registry lookup
   * (official `status.statusCode` / `codedGameState` from
   * GET /api/v1/gameStatus — M* manager challenge, N* umpire review, IH
   * instant replay, MJ/NJ ABS pitch challenge), with the same self-contained
   * fallback the Replay Feed uses when reviews.js has not loaded. The old
   * `/challenge|review/i` word match missed "Instant Replay" (crew-chief
   * review, statusCode IH) outright, so those reviews never raised the
   * ticker, never counted in the Challenges tab, and never dropped this page
   * to the 250ms cadence.
   */
  function gameIsUnderReview(game) {
    const status = (game && game.status) || null;
    if (!status) return false;
    if (window.MLBReviews && typeof window.MLBReviews.isReviewGameStatus === 'function') {
      return window.MLBReviews.isReviewGameStatus(status);
    }
    const code = String(status.statusCode || '').trim().toUpperCase();
    if (/^[MN][A-Z]$/.test(code) || code === 'IH') return true;
    const coded = String(status.codedGameState || '').trim().toUpperCase();
    if (coded === 'M' || coded === 'N') return true;
    return /challenge|review|instant replay/i.test(String(status.detailedState || ''));
  }

  function scheduleNext(overrideMs) {
    clearTimeout(pollTimer);
    const hasLiveGame = games.some((g) => g.status.abstractGameState === 'Live');
    const hasActiveReview = games.some(gameIsUnderReview);
    const interval = overrideMs != null ? overrideMs
      : (hasActiveReview ? REVIEW_POLL_MS : hasLiveGame ? LIVE_POLL_MS : IDLE_POLL_MS);
    // Cadence is the gap between poll STARTS (same semantics as the game page
    // and the Replay Feed): subtract the request we just finished so a slow
    // response does not stretch the cycle — a review banner otherwise waits
    // request + interval instead of interval.
    const elapsed = lastCycleStartedAt ? Date.now() - lastCycleStartedAt : 0;
    const wait = overrideMs != null ? overrideMs : Math.max(0, interval - elapsed);
    pollTimer = setTimeout(() => {
      if (!document.hidden) load();
      else scheduleNext();
    }, wait);
  }

  /* ------------------------------------------------ review-status watcher */

  /**
   * Diff one projected sweep against the last observed signatures.
   * Pure (no closure state) so the policy is directly testable — exposed on
   * window.Scoreboard._scheduleStatusFlips for tools/page-status-watcher-test.mjs.
   * A signature is the tuple of every status field the scoreboard renders or
   * branches on, so ANY meaningful official flip (review called/resolved,
   * delayed, final) reports changed:true. Returns the fresh signature map.
   */
  function scheduleStatusFlips(prevCodes, list) {
    const codes = new Map();
    (list || []).forEach((g) => {
      if (!g || g.gamePk == null || !g.status) return;
      const s = g.status;
      codes.set(g.gamePk, [
        s.abstractGameState || '', s.codedGameState || '', s.statusCode || '',
        s.detailedState || '', s.reason || '',
      ].join('|'));
    });
    let changed = false;
    if (prevCodes && prevCodes.size === codes.size) {
      codes.forEach((sig, pk) => {
        if (prevCodes.get(pk) !== sig) changed = true;
      });
    } else if (prevCodes && prevCodes.size !== codes.size) {
      changed = true;
    } else if (!prevCodes && codes.size) {
      changed = true; // first sweep after boot: adopt, but paint nothing new
    }
    return { changed, codes };
  }

  /** Watcher cadence: fast only while a review is possible (a review cannot
   *  start on a game that has not started); idle otherwise and when hidden.
   *  Uses the last sweep's own observation too, so the cadence is correct
   *  even before the first hydrated schedule lands (games empty at boot). */
  let lastSweepHadLive = false;

  function reviewStatusIntervalMs() {
    if (document.hidden) return REVIEW_STATUS_IDLE_MS;
    const canReview = lastSweepHadLive || games.some((g) => g && g.status &&
      (g.status.abstractGameState === 'Live' || gameIsUnderReview(g)));
    return canReview ? REVIEW_STATUS_POLL_MS : REVIEW_STATUS_IDLE_MS;
  }

  function scheduleReviewStatus(initialFast) {
    clearTimeout(reviewStatusTimer);
    // A hidden tab parks at the idle cadence instead of spinning at 250ms.
    // The timer is SELF-PERPETUATING (every path — including the hidden park
    // and pollReviewStatus's finally — re-arms it, recomputing the cadence
    // from current state), so nothing else may re-arm it: resetting the
    // phase from every 500ms schedule poll would stretch the 250ms sweep to
    // ~2/s (caught by tools/page-status-watcher-test.mjs §A3). It is started
    // exactly once per "shown" lifetime: at boot and on visibilitychange→show.
    // `initialFast` covers the cold-boot hole: at DOMContentLoaded `games` is
    // empty so the computed cadence would park at 5s — arming the FIRST tick
    // at 250ms instead means a page opened mid-review adopts the slate's
    // status immediately (one ~2.4 KB request even on an idle slate).
    const wait = initialFast ? REVIEW_STATUS_POLL_MS : reviewStatusIntervalMs();
    reviewStatusTimer = setTimeout(() => {
      if (document.hidden) { scheduleReviewStatus(); return; }
      pollReviewStatus();
    }, wait);
  }

  function stopReviewStatus() {
    clearTimeout(reviewStatusTimer);
    reviewStatusTimer = null;
  }

  /**
   * One sweep. Never throws: a failed sweep is silently retried on the next
   * tick (fail-fast timeout, no retry) and the hydrated schedule keeps the
   * page correct on its own cadence no matter what happens here. On a real
   * status flip the fresh official status is merged into `games`
   * field-by-field (a projected sweep must never delete a field the
   * hydrated schedule supplied) and the page re-renders immediately — the
   * 🚨 ticker, the per-card review badges and the Challenges tab then show
   * the review ~250ms after MLB flips the status, not on the next 500ms
   * schedule poll. scheduleNext() runs right after so the main poll also
   * drops to its 250ms review cadence.
   */
  async function pollReviewStatus() {
    // No endpoint = no feature (api.js always ships it on index.html).
    if (!MLB.getReviewStatus) { stopReviewStatus(); return; }
    if (reviewStatusInFlight) { scheduleReviewStatus(); return; }
    const requestDate = dateStr;
    reviewStatusInFlight = true;
    try {
      const list = await MLB.getReviewStatus(requestDate,
        { timeout: REVIEW_STATUS_TIMEOUT_MS, retries: 0 });
      if (requestDate === dateStr) {
        // The sweep's own result drives the next cadence (see
        // reviewStatusIntervalMs) — the projected slate knows what is live
        // even before the hydrated schedule lands.
        lastSweepHadLive = (list || []).some((g) => g && g.status &&
          (g.status.abstractGameState === 'Live' || gameIsUnderReview(g)));
        const diff = scheduleStatusFlips(reviewStatusCodes, list);
        const firstSweep = reviewStatusCodes.size === 0 && diff.codes.size > 0;
        reviewStatusCodes = diff.codes;
        // games.length guard: right after a date switch the hydrated slate
        // has not landed yet (games = []) — there is nothing to merge into
        // or render, and load() will paint the new date correctly.
        if (diff.changed && !firstSweep && games.length) {
          mergeReviewStatusIntoGames(list);
          render();
          scheduleNext(); // re-evaluate cadence (e.g. drop to 250ms review poll)
        }
      }
    } catch (err) {
      // Deliberately quiet: see the doc comment above.
    } finally {
      reviewStatusInFlight = false;
      scheduleReviewStatus();
    }
  }

  /** Copy the watcher's fresh official status onto the matching `games`
   *  entries so render()/scheduleNext() see it without waiting for the next
   *  hydrated-schedule poll. Merged field-by-field (Object.assign onto a
   *  copy), exactly like the Replay Feed's mergeReviewStatusIntoGames. */
  function mergeReviewStatusIntoGames(list) {
    const byStatus = new Map();
    (list || []).forEach((g) => {
      if (g && g.gamePk != null && g.status) byStatus.set(g.gamePk, g.status);
    });
    games.forEach((g) => {
      if (!g || g.gamePk == null) return;
      const fresh = byStatus.get(g.gamePk);
      if (!fresh) return;
      g.status = Object.assign({}, g.status || {}, fresh);
    });
  }

  function updateDateLabel() {
    const labelDate = new Date(`${dateStr}T12:00:00`);
    $('#date-label').textContent = labelDate.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    $('#date-picker').value = dateStr;
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    const listEl = $('#game-list');
    UI.clear(listEl);

    const byState = { Preview: [], Live: [], Final: [], Other: [] };
    const gamesWithReviews = [];

    games.forEach((g) => {
      const key = byState[g.status.abstractGameState] ? g.status.abstractGameState : 'Other';
      byState[key].push(g);
      if (gameIsUnderReview(g)) gamesWithReviews.push(g);
    });

    // Scoreboard Review Alert Banner if any games are currently under review/challenge
    renderActiveReviewsBanner(gamesWithReviews);

    const ordered =
      [...byState.Live, ...byState.Preview, ...byState.Final, ...byState.Other];

    const filtered = filter === 'all' ? ordered : ordered.filter((g) => {
      if (filter === 'live') return g.status.abstractGameState === 'Live';
      if (filter === 'scheduled') return g.status.abstractGameState === 'Preview';
      if (filter === 'final') return g.status.abstractGameState === 'Final';
      if (filter === 'challenges') return gameIsUnderReview(g);
      return true;
    });

    const counts = {
      all: games.length,
      live: byState.Live.length,
      scheduled: byState.Preview.length,
      final: byState.Final.length,
      challenges: gamesWithReviews.length,
    };
    renderTabs(counts);

    if (!filtered.length) {
      listEl.appendChild(
        UI.el('div', 'empty',
          games.length
            ? 'No games in this category.'
            : 'No games scheduled for this date.'));
      return;
    }

    filtered.forEach((game) => listEl.appendChild(gameCard(game)));
    wireScoreBumps();
  }

  function renderActiveReviewsBanner(reviewGames) {
    const banner = $('#banner');
    if (banner.querySelector('.banner-error')) return;
    UI.clear(banner);

    if (!reviewGames || !reviewGames.length) return;

    const bar = UI.el('div', 'scoreboard-review-ticker');
    const badge = UI.el('span', 'review-ticker-badge', '🚨 ACTIVE REVIEWS');
    bar.appendChild(badge);

    const itemsWrap = UI.el('div', 'review-ticker-items');
    reviewGames.forEach((g) => {
      const away = g.teams && g.teams.away && g.teams.away.team;
      const home = g.teams && g.teams.home && g.teams.home.team;
      const ls = g.linescore;
      const inn = ls ? MLB.inningLabel(ls, g.status) : '';
      const detailed = (g.status && g.status.detailedState) || 'In Review';
      const item = UI.el('a', 'review-ticker-link', '', { href: `game.html?gamePk=${g.gamePk}` });
      const sideName = (t, fallback) => {
        if (!t) return fallback;
        const name = t.name || t.teamName;
        const abbr = t.abbreviation;
        if (typeof name === 'string' && name && name !== 'undefined') return name;
        if (typeof abbr === 'string' && abbr && abbr !== 'undefined') return abbr;
        return fallback;
      };
      item.appendChild(UI.el('span', 'ticker-game', `${sideName(away, 'AWY')} vs ${sideName(home, 'HOM')}`));
      if (inn) item.appendChild(UI.el('span', 'ticker-inn', inn));
      item.appendChild(UI.el('span', 'ticker-type', detailed));
      item.appendChild(UI.el('span', 'ticker-cta', 'View →'));
      itemsWrap.appendChild(item);
    });
    const feedLink = UI.el('a', 'ticker-feed-link', '🚨 Open all-games replay feed →', {
      href: 'reviews.html',
      title: 'Chat-style live feed of every challenge / review / ABS pitch challenge across all games',
    });
    itemsWrap.appendChild(feedLink);
    bar.appendChild(itemsWrap);
    banner.appendChild(bar);
  }

  function renderTabs(counts) {
    const tabs = [
      ['all', `All (${counts.all})`],
      ['live', `Live (${counts.live})`],
      ['scheduled', `Scheduled (${counts.scheduled})`],
      ['final', `Final (${counts.final})`],
    ];
    if (counts.challenges > 0) {
      tabs.push(['challenges', `🚨 Challenges (${counts.challenges})`]);
    }
    const wrap = UI.clear($('#tabs'));
    tabs.forEach(([key, label]) => {
      wrap.appendChild(UI.el('button', `tab ${filter === key ? 'tab-on' : ''}`, label, {
        onclick: `Scoreboard.setFilter('${key}')`,
      }));
    });
  }

  /* ------------------------------------------------------------ game cards */

  function gameCard(game) {
    const gd = game.gameDate;
    const status = game.status;
    const isLive = status.abstractGameState === 'Live';
    const isFinal = status.abstractGameState === 'Final';
    const away = game.teams.away;
    const home = game.teams.home;
    const ls = game.linescore || null;
    const inspection = window.MLBReviews ? window.MLBReviews.inspectScheduleGame(game) : { hasActiveReview: false };
    const hasReviewActive = inspection.hasActiveReview;

    const card = UI.el('a', `card game-card ${isLive ? 'card-live' : ''} ${hasReviewActive ? 'card-review-active' : ''}`);
    card.href = `game.html?gamePk=${game.gamePk}`;

    /* header: status chip + start time / venue */
    const head = UI.el('div', 'card-head');
    let chipLabel = null;
    if (isLive && ls) {
      chipLabel = MLB.inningLabel(ls, status);
    } else if (isFinal && ls) {
      chipLabel = MLB.inningLabel(ls, status);
    }
    const chip = UI.statusChip(status, chipLabel);
    head.appendChild(chip);
    head.appendChild(UI.el('span', 'card-meta',
      isLive && ls ? `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''}` :
      isFinal ? (game.venue && game.venue.name || '') :
      `${MLB.localTime(gd)} · ${game.venue && game.venue.name || ''}`));

    /* team rows */
    const body = UI.el('div', 'card-body');
    [['away', away], ['home', home]].forEach(([side, t]) => {
      const row = UI.el('div', `card-row row-${side}`);
      const logo = UI.teamLogo(t.team.id, t.team.name, t.team.abbreviation, 'card-logo');
      row.appendChild(logo);
      const nameWrap = UI.el('span', 'card-team');
      nameWrap.appendChild(UI.el('span', 'card-team-name', t.team.name));
      nameWrap.appendChild(UI.el('span', 'card-record',
        `${t.leagueRecord.wins}-${t.leagueRecord.losses}`));
      row.appendChild(nameWrap);
      const score = UI.el('span', `card-score ${isFinal ? (t.isWinner ? 'score-win' : '') : ''}`);
      score.dataset.score = `${side}:${MLB.scoreOf(game, side)}`;
      score.textContent = MLB.scoreOf(game, side) == null ? '' : MLB.scoreOf(game, side);
      row.appendChild(score);
      body.appendChild(row);
    });

    /* footer: probables / count / decisions */
    const foot = UI.el('div', 'card-foot');
    if (hasReviewActive) {
      foot.appendChild(UI.el('span', 'card-review-indicator',
        `🚨 ${inspection.typeLabel || 'Review in Progress'}`));
    }
    const scChanges = scoringChangesByGame.get(game.gamePk);
    if (scChanges && scChanges.length) {
      foot.appendChild(UI.el('span', 'card-scoring-indicator',
        `✏️ ${scChanges.length} Scoring Change${scChanges.length === 1 ? '' : 's'}`));
    }
    if (isLive && ls) {
      foot.appendChild(UI.countDots(ls.balls, ls.strikes, ls.outs, 'card-count'));
      const last = lastPlayText(game);
      if (last) foot.appendChild(UI.el('span', 'card-last', last));
    } else if (isFinal) {
      const d = game.decisions;
      const pieces = [];
      if (d && d.winner) pieces.push(`W: ${d.winner.fullName}`);
      if (d && d.loser) pieces.push(`L: ${d.loser.fullName}`);
      if (d && d.save) pieces.push(`SV: ${d.save.fullName}`);
      foot.appendChild(UI.el('span', 'card-decisions', pieces.join(' · ') || ''));
    } else {
      const pp = game.probablePitchers;
      const awayP = pp && pp.away;
      const homeP = pp && pp.home;
      if (awayP || homeP) {
        foot.appendChild(UI.el('span', 'card-probables',
          `Probables: ${awayP ? awayP.fullName : 'TBD'} vs ${homeP ? homeP.fullName : 'TBD'}`));
      } else {
        foot.appendChild(UI.el('span', 'card-probables', game.description || ''));
      }
    }
    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    return card;
  }

  /** Latest scoring description available on the schedule item (if hydrated). */
  function lastPlayText(game) {
    const ls = game.linescore;
    if (ls && ls.teams) {
      const desc = ls.lastPlay && ls.lastPlay.result && ls.lastPlay.result.description;
      if (desc) return desc;
    }
    return '';
  }

  /** Flash score changes so a refresh is visible at a glance. */
  function wireScoreBumps() {
    document.querySelectorAll('.card-score').forEach((node) => {
      const prev = node.dataset.prev;
      const cur = node.dataset.score;
      if (prev && prev !== cur) {
        node.classList.add('bump');
        setTimeout(() => node.classList.remove('bump'), 1200);
      }
      node.dataset.prev = cur;
    });
  }

  /* ------------------------------------------------------------------ misc */

  function spinner() {
    const s = UI.el('div', 'spinner');
    return s;
  }

  /* ------------------------------------------------------------------ boot */

  window.Scoreboard = {
    retry() { load(); },
    // Test seam: the pure sweep-diff policy (no closure state), pinned by
    // tools/page-status-watcher-test.mjs.
    _scheduleStatusFlips: scheduleStatusFlips,
    setFilter(f) {
      filter = f;
      render();
    },
    prevDay() { shiftDate(-1); syncUrl(); updateDateLabel(); games = []; load(); },
    nextDay() { shiftDate(1); syncUrl(); updateDateLabel(); games = []; load(); },
    today() {
      dateStr = todayStr();
      scoringChangesByGame.clear();
      syncUrl();
      updateDateLabel();
      games = [];
      load();
    },
    pickDate() {
      const d = $('#date-picker').value;
      if (d) { dateStr = d; syncUrl(); updateDateLabel(); games = []; load(); }
    },
  };

  function syncUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', dateStr);
    window.history.replaceState({}, '', url);
  }

  function $(sel) { return document.querySelector(sel); }

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateStr = d;
    $('#date-picker').value = dateStr;

    updateDateLabel();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // load() re-renders from the hydrated schedule; the watcher (stopped
        // on hide) restarts here for its one sweep-armed lifetime.
        scheduleReviewStatus();
        load();
      } else {
        // No hidden-tab requests at all: park the fast status sweep.
        stopReviewStatus();
      }
    });
    // The status watcher self-perpetuates from this single (fast) arming: it
    // re-evaluates its own cadence every tick — fast while the slate it
    // observes has anything live, 5s otherwise — without ever being reset by
    // the schedule poll's phase.
    scheduleReviewStatus(true);
    load();
  });
})();
