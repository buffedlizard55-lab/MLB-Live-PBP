/* ============================================================================
 * scoreboard.js — today's games, mlb.com scoreboard style
 * ==========================================================================*/
'use strict';

(() => {
  // Live scoreboard: 3s. While any game's official status says challenge/
  // review: 1.5s so the ticker is not waiting on the ordinary live interval.
  const LIVE_POLL_MS = 3000;
  const REVIEW_POLL_MS = 1500;
  const IDLE_POLL_MS = 30000;

  let dateStr = todayStr();
  let games = [];
  let filter = 'all';
  let pollTimer = null;
  let requestInFlight = false;

  /* ------------------------------------------------------------------ state */

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function shiftDate(days) {
    const d = new Date(`${dateStr}T12:00:00`);
    d.setDate(d.getDate() + days);
    dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /* ------------------------------------------------------------------ fetch */

  async function load() {
    // Never let an older response overwrite a newly selected date.
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
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

  function scheduleNext(overrideMs) {
    clearTimeout(pollTimer);
    const hasLiveGame = games.some((g) => g.status.abstractGameState === 'Live');
    const hasActiveReview = games.some((g) => {
      const inspection = window.MLBReviews
        ? window.MLBReviews.inspectScheduleGame(g)
        : { hasActiveReview: false };
      return inspection.hasActiveReview;
    });
    const interval = overrideMs || (hasActiveReview ? REVIEW_POLL_MS
      : hasLiveGame ? LIVE_POLL_MS : IDLE_POLL_MS);
    pollTimer = setTimeout(() => {
      if (!document.hidden) load();
      else scheduleNext();
    }, interval);
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
      const inspection = window.MLBReviews ? window.MLBReviews.inspectScheduleGame(g) : { hasActiveReview: false };
      if (inspection.hasActiveReview || /challenge|review/i.test((g.status && g.status.detailedState) || '')) {
        gamesWithReviews.push(g);
      }
    });

    // Scoreboard Review Alert Banner if any games are currently under review/challenge
    renderActiveReviewsBanner(gamesWithReviews);

    const ordered =
      [...byState.Live, ...byState.Preview, ...byState.Final, ...byState.Other];

    const filtered = filter === 'all' ? ordered : ordered.filter((g) => {
      if (filter === 'live') return g.status.abstractGameState === 'Live';
      if (filter === 'scheduled') return g.status.abstractGameState === 'Preview';
      if (filter === 'final') return g.status.abstractGameState === 'Final';
      if (filter === 'challenges') {
        const inspection = window.MLBReviews ? window.MLBReviews.inspectScheduleGame(g) : { hasActiveReview: false };
        return inspection.hasActiveReview || /challenge|review/i.test((g.status && g.status.detailedState) || '');
      }
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
    setFilter(f) {
      filter = f;
      render();
    },
    prevDay() { shiftDate(-1); syncUrl(); updateDateLabel(); games = []; load(); },
    nextDay() { shiftDate(1); syncUrl(); updateDateLabel(); games = []; load(); },
    today() {
      dateStr = todayStr();
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
      if (!document.hidden) load();
    });
    load();
  });
})();
