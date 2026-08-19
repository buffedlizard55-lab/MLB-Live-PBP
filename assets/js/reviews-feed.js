/* ============================================================================
 * reviews-feed.js — All-Games Replay Review Feed ("chatroom" style)
 * ----------------------------------------------------------------------------
 * Pulls review/challenge events (Manager Challenges, Crew Chief Reviews,
 * Umpire Reviews, ABS pitch challenges) from EVERY game on the selected date
 * and renders them as a live, chat-style feed. New events appear at the top
 * with a highlight; in-progress reviews pulse until they resolve.
 *
 * Data flow (all shapes verified against statsapi.mlb.com, 2026-08-19):
 *   1. Schedule (hydrate=review,linescore,decisions) -> teams + status +
 *      per-team manager-challenge counts (game.review.away/home.used/remaining).
 *   2. Per live/final game: playByPlay (allPlays + currentPlay) -> the same
 *      review payload the game page reads from feed/live:
 *        - play.reviewDetails            (manager challenges: codes "MA"/"MF")
 *        - playEvents[].reviewDetails    (ABS pitch challenges: code "MJ")
 *        - playEvents[].details.hasReview
 *        - currentPlay.reviewDetails     (in-progress review)
 *   3. MLBReviews.extractReviews() normalizes each game's events; the diff
 *      helpers below (buildEventKey / mergeFeedEvents) turn them into a
 *      single, deduped, chronologically-ordered live feed.
 * ==========================================================================*/
'use strict';

/* ------------------------------------------------------------ pure helpers */

/**
 * Stable unique key for one review event across polls.
 * review.id is already per-game stable ("play-<atBatIndex>-main" /
 * "play-<atBatIndex>-ev-<idx>" / "live-active-review"); scoping it by gamePk
 * makes it unique across the whole feed.
 */
function buildEventKey(gamePk, review) {
  return `${gamePk}:${review && review.id}`;
}

/**
 * Merge a game's freshly extracted reviews into feed state.
 * state = { seen: Map<key, {gamePk, review, firstSeen, lastSeen}>, order: [] }
 * Returns { added: [], updated: [], ended: [] } with the same entry objects.
 *  - added   : keys not seen before (new chatroom messages)
 *  - updated : keys whose inProgress/outcome changed since last poll
 *  - ended   : keys that existed before but are gone now (e.g. a synthesized
 *              "live-active-review" that cleared once the review finished)
 */
function mergeFeedEvents(state, gamePk, reviews) {
  const seen = state.seen;
  const order = state.order;
  const now = Date.now();
  const added = [];
  const updated = [];
  const ended = [];

  if (!seen || !order) return { added, updated, ended };

  const currentKeys = new Set();

  (reviews || []).forEach((review) => {
    const key = buildEventKey(gamePk, review);
    currentKeys.add(key);
    const prev = seen.get(key);
    if (!prev) {
      const entry = { gamePk, review, firstSeen: now, lastSeen: now };
      seen.set(key, entry);
      order.push(key);
      added.push(entry);
      return;
    }
    prev.lastSeen = now;
    const changed =
      prev.review.inProgress !== review.inProgress ||
      prev.review.outcome !== review.outcome ||
      prev.review.outcomeLabel !== review.outcomeLabel;
    if (changed) {
      prev.review = review;
      updated.push(prev);
    }
  });

  // Keys that belonged to this game but are no longer present (synthesized
  // active-review entries disappear when the review resolves).
  const keys = [...seen.keys()];
  keys.forEach((key) => {
    if (!key.startsWith(`${gamePk}:`)) return;
    if (!currentKeys.has(key)) {
      seen.delete(key);
      const orderIdx = order.indexOf(key);
      if (orderIdx >= 0) order.splice(orderIdx, 1);
      ended.push(key);
    }
  });

  return { added, updated, ended };
}

/**
 * Sort feed entries for display: newest first. Uses the review's own
 * timestamp (event startTime / play endTime) when available, else first seen.
 */
function sortFeedEntries(entries) {
  const stamp = (entry) => {
    const t = entry.review && entry.review.timestamp;
    const parsed = t ? Date.parse(t) : NaN;
    return Number.isFinite(parsed) ? parsed : (entry.firstSeen || 0);
  };
  return [...entries].sort((a, b) => stamp(b) - stamp(a));
}

/* ------------------------------------------------------------ page logic */

(() => {
  const LIVE_POLL_MS = 20000;
  const IDLE_POLL_MS = 60000;

  let dateStr = todayStr();
  let games = [];
  let filter = 'all';
  let pollTimer = null;
  let requestInFlight = false;
  let settledGames = new Set();     // Final games: fetched once, immutable
  const feedState = { seen: new Map(), order: [] };

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function shiftDate(days) {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    resetFeed();
  }

  function resetFeed() {
    feedState.seen.clear();
    feedState.order.length = 0;
    settledGames = new Set();
  }

  function $ (sel) { return document.querySelector(sel); }

  function el(tag, cls, text, attrs) { return UI.el(tag, cls, text, attrs); }

  /* ------------------------------------------------------------- polling */

  async function load() {
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
    const statusLine = $('#status-line');
    setLivePulse(true);

    try {
      const scheduleGames = await MLB.getSchedule(requestDate);
      if (requestDate !== dateStr) return;
      games = scheduleGames;

      const candidates = games.filter((g) => {
        const state = g.status && g.status.abstractGameState;
        return state === 'Live' || state === 'Final';
      });

      // Sequential-ish fetch with small concurrency: playByPlay is the same
      // CORS-open endpoint the game page already uses, but be polite.
      const batches = [];
      for (let i = 0; i < candidates.length; i += 5) batches.push(candidates.slice(i, i + 5));
      for (const batch of batches) {
        await Promise.all(batch.map((g) => ingestGame(g)));
        if (requestDate !== dateStr) return;
      }

      render();
      statusLine.textContent =
        `${games.length} game${games.length === 1 ? '' : 's'} · ` +
        `${feedState.order.length} review event${feedState.order.length === 1 ? '' : 's'} · ` +
        `updated ${new Date().toLocaleTimeString()}`;
      scheduleNext();
    } catch (err) {
      console.error(err);
      if (requestDate !== dateStr) return;
      statusLine.textContent = `Couldn't reach the MLB StatsAPI (${err.message || err}) — retrying…`;
      scheduleNext(10000);
    } finally {
      requestInFlight = false;
      setLivePulse(false);
      if (requestDate !== dateStr) load();
    }
  }

  async function ingestGame(game) {
    const gamePk = game.gamePk;
    const state = game.status && game.status.abstractGameState;
    if (state === 'Final' && settledGames.has(gamePk)) return;

    let pbp;
    try {
      pbp = await MLB.getPlayByPlay(gamePk);
    } catch (err) {
      // A game that just started may not have a playByPlay yet; skip quietly.
      return;
    }
    if (state === 'Final') settledGames.add(gamePk);

    const pseudoFeed = {
      gameData: {
        status: game.status || {},
        teams: {
          away: game.teams && game.teams.away && game.teams.away.team
            ? { id: game.teams.away.team.id, name: game.teams.away.team.name, abbreviation: game.teams.away.team.abbreviation }
            : null,
          home: game.teams && game.teams.home && game.teams.home.team
            ? { id: game.teams.home.team.id, name: game.teams.home.team.name, abbreviation: game.teams.home.team.abbreviation }
            : null,
        },
      },
      liveData: { plays: pbp, linescore: null },
    };

    const reviewData = window.MLBReviews
      ? window.MLBReviews.extractReviews(pseudoFeed)
      : { reviews: [], activeReview: null };
    const result = mergeFeedEvents(feedState, gamePk, reviewData.reviews);
    if (result.added.length || result.updated.length || result.ended.length) {
      renderFeedUpdates(result);
    }
  }

  /* ------------------------------------------------------------ rendering */

  function render() {
    renderStats();
    renderActiveStrip();
    renderTabs();
    renderFeed();
    updateDateLabel();
  }

  function renderStats() {
    const entries = [...feedState.seen.values()];
    const wrap = UI.clear($('#feed-stats'));
    const stat = (label, value, cls) => {
      const b = el('div', `review-stat-item ${cls || ''}`);
      b.appendChild(el('span', 'review-stat-label', label));
      b.appendChild(el('strong', 'review-stat-value', String(value)));
      return b;
    };
    wrap.appendChild(stat('Events', entries.length));
    wrap.appendChild(stat('ABS Challenges', entries.filter((e) => e.review.typeKey === 'abs').length, 'stat-abs'));
    wrap.appendChild(stat('Manager Challenges', entries.filter((e) => e.review.typeKey === 'manager').length, 'stat-manager'));
    wrap.appendChild(stat('Overturned', entries.filter((e) => e.review.outcome === 'overturned').length, 'stat-overturned'));
    wrap.appendChild(stat('Stands / Upheld', entries.filter((e) => e.review.outcome === 'stands').length, 'stat-stands'));
    const inProgress = entries.filter((e) => e.review.inProgress);
    if (inProgress.length) {
      wrap.appendChild(stat('Under Review', inProgress.length, 'stat-active-pulse'));
    }
  }

  function renderActiveStrip() {
    const wrap = UI.clear($('#active-strip'));
    const activeGames = new Map();

    feedState.seen.forEach((entry, key) => {
      if (entry.review.inProgress) {
        if (!activeGames.has(entry.gamePk)) activeGames.set(entry.gamePk, []);
        activeGames.get(entry.gamePk).push(entry);
      }
    });
    // A game whose status itself says "Manager Challenge"/"In Review".
    games.forEach((g) => {
      const detailed = (g.status && g.status.detailedState) || '';
      if (/challenge|review/i.test(detailed) && !activeGames.has(g.gamePk)) {
        activeGames.set(g.gamePk, []);
      }
    });

    if (!activeGames.size) return;
    const bar = el('div', 'feed-active-strip');
    bar.appendChild(el('span', 'feed-active-badge', '🚨 LIVE REVIEW'));
    activeGames.forEach((entries, gamePk) => {
      const g = games.find((x) => x.gamePk === gamePk);
      if (!g) return;
      const away = g.teams && g.teams.away && g.teams.away.team;
      const home = g.teams && g.teams.home && g.teams.home.team;
      const label = entries.length
        ? entries[0].review.reviewType
        : (g.status && g.status.detailedState) || 'Review';
      const item = el('a', 'feed-active-link', '',
        { href: `game.html?gamePk=${gamePk}` });
      item.appendChild(el('span', 'feed-active-game',
        `${away ? away.abbreviation : 'AWY'} @ ${home ? home.abbreviation : 'HOM'}`));
      item.appendChild(el('span', 'feed-active-type', label));
      if (entries.length && entries[0].review.reason) {
        item.appendChild(el('span', 'feed-active-reason', entries[0].review.reason));
      }
      bar.appendChild(item);
    });
    wrap.appendChild(bar);
  }

  function renderTabs() {
    const entries = [...feedState.seen.values()];
    const counts = {
      all: entries.length,
      abs: entries.filter((e) => e.review.typeKey === 'abs').length,
      manager: entries.filter((e) => e.review.typeKey === 'manager').length,
      crew: entries.filter((e) => e.review.typeKey === 'crew_chief').length,
      live: entries.filter((e) => e.review.inProgress).length,
    };
    const tabs = [
      ['all', `All (${counts.all})`],
      ['abs', `ABS (${counts.abs})`],
      ['manager', `Challenges (${counts.manager})`],
      ['crew', `Reviews (${counts.crew})`],
      ['live', `● Under Review (${counts.live})`],
    ];

    const wrap = UI.clear($('#feed-tabs'));
    tabs.forEach(([key, label]) => {
      wrap.appendChild(el('button', `tab ${filter === key ? 'tab-on' : ''}`, label, {
        onclick: `ReplayFeed.setFilter('${key}')`,
      }));
    });
  }

  function renderFeed() {
    const wrap = UI.clear($('#feed-list'));
    const entries = [...feedState.seen.values()].filter(matchesFilter);
    if (!entries.length) {
      wrap.appendChild(el('div', 'empty',
        games.length
          ? 'No challenges or replay reviews in this category yet — events will appear here live.'
          : 'No games scheduled for this date.'));
      return;
    }
    sortFeedEntries(entries).forEach((entry) => wrap.appendChild(feedRow(entry)));
  }

  function matchesFilter(entry) {
    if (filter === 'all') return true;
    if (filter === 'live') return entry.review.inProgress;
    return entry.review.typeKey === filter;
  }

  /** One chatroom message for one review event. */
  function feedRow(entry) {
    const r = entry.review;
    const game = games.find((g) => g.gamePk === entry.gamePk) || null;
    const row = el('div', `feed-row feed-type-${r.typeKey} ${r.inProgress ? 'feed-row-live' : `feed-outcome-${r.outcome}`}`);
    row.dataset.key = buildEventKey(entry.gamePk, r);

    /* left: time */
    const time = el('div', 'feed-time');
    const t = r.timestamp || new Date(entry.firstSeen).toISOString();
    time.appendChild(el('span', 'feed-time-txt', timeLabel(t)));
    time.appendChild(el('span', 'feed-time-hm', new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    row.appendChild(time);

    /* main body */
    const body = el('div', 'feed-body');

    const head = el('div', 'feed-head');
    if (game) {
      const away = game.teams && game.teams.away && game.teams.away.team;
      const home = game.teams && game.teams.home && game.teams.home.team;
      const link = el('a', 'feed-game', '',
        { href: `game.html?gamePk=${entry.gamePk}`, title: 'Open game' });
      link.appendChild(el('span', 'feed-game-txt',
        `${away ? away.abbreviation : 'AWY'} @ ${home ? home.abbreviation : 'HOM'}`));
      if (game.linescore && game.linescore.teams) {
        const ls = game.linescore;
        link.appendChild(el('span', 'feed-game-score',
          `${ls.teams.away && ls.teams.away.runs != null ? ls.teams.away.runs : '–'}–${ls.teams.home && ls.teams.home.runs != null ? ls.teams.home.runs : '–'}`));
      }
      head.appendChild(link);
    }
    head.appendChild(el('span', `chip-review-type chip-${r.typeKey}`, r.reviewType));
    if (r.teamAbbrev) head.appendChild(el('span', 'feed-team', r.teamAbbrev));
    if (r.inningLabel) head.appendChild(el('span', 'feed-inn', r.inningLabel));
    head.appendChild(outcomePill(r));
    body.appendChild(head);

    const title = el('div', 'feed-reason', r.reason);
    body.appendChild(title);

    const desc = el('div', 'feed-desc', r.description);
    body.appendChild(desc);

    if (r.batter || r.pitcher) {
      const foot = el('div', 'feed-foot');
      if (r.batter) foot.appendChild(el('span', 'feed-player', `Batter: ${r.batter.fullName}`));
      if (r.pitcher) foot.appendChild(el('span', 'feed-player', `Pitcher: ${r.pitcher.fullName}${r.pitchVelo ? ` (${r.pitchVelo} mph)` : ''}`));
      body.appendChild(foot);
    }

    row.appendChild(body);
    return row;
  }

  function outcomePill(r) {
    const cls = r.inProgress ? 'outcome-in-progress' :
      r.outcome === 'overturned' ? 'outcome-overturned' :
      r.outcome === 'confirmed' ? 'outcome-confirmed' : 'outcome-stands';
    const icon = r.inProgress ? '⚡ ' : r.outcome === 'overturned' ? '✓ ' : '✗ ';
    return el('span', `review-outcome-pill ${cls}`, `${icon}${r.outcomeLabel}`);
  }

  /**
   * Render incremental updates (new/updated/ended) without rebuilding the
   * whole list. New messages get a one-time flash animation.
   */
  function renderFeedUpdates(result) {
    const list = $('#feed-list');
    const empty = list.querySelector('.empty');
    if (empty) { renderFeed(); return; }

    // Rebuild is cheap at this scale; keep the flash on rows that are new.
    renderFeed();
    const escapeKey = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape : (s) => s;
    result.added.forEach((entry) => {
      const row = list.querySelector(`.feed-row[data-key="${escapeKey(buildEventKey(entry.gamePk, entry.review))}"]`);
      if (row) row.classList.add('feed-new');
    });

    // Keep the header stats + active strip + tabs in sync.
    renderStats();
    renderActiveStrip();
    renderTabs();
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function updateDateLabel() {
    const labelDate = new Date(`${dateStr}T12:00:00`);
    $('#date-label').textContent = labelDate.toLocaleDateString([], {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    $('#date-picker').value = dateStr;
  }

  function setLivePulse(on) {
    const dot = $('#live-dot');
    if (dot) dot.classList.toggle('on', on);
  }

  function scheduleNext(overrideMs) {
    clearTimeout(pollTimer);
    const hasLive = games.some((g) => g.status && g.status.abstractGameState === 'Live');
    pollTimer = setTimeout(() => {
      if (!document.hidden) load();
      else scheduleNext();
    }, overrideMs || (hasLive ? LIVE_POLL_MS : IDLE_POLL_MS));
  }

  function syncUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', dateStr);
    window.history.replaceState({}, '', url);
  }

  /* ----------------------------------------------------------------- boot */

  window.ReplayFeed = {
    setFilter(f) { filter = f; renderFeed(); },
    prevDay() { shiftDate(-1); syncUrl(); updateDateLabel(); load(); },
    nextDay() { shiftDate(1); syncUrl(); updateDateLabel(); load(); },
    today() { dateStr = todayStr(); syncUrl(); updateDateLabel(); resetFeed(); load(); },
    pickDate() {
      const d = $('#date-picker').value;
      if (d) { dateStr = d; syncUrl(); updateDateLabel(); resetFeed(); load(); }
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateStr = d;
    updateDateLabel();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
    });
    load();
  });

  /* Node test export (pure helpers only). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildEventKey, mergeFeedEvents, sortFeedEntries };
  }
})();
