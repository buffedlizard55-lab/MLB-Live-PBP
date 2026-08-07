/* ============================================================================
 * scoreboard.js — today's games, mlb.com scoreboard style
 * ==========================================================================*/
'use strict';

(() => {
  const POLL_MS = 30000; // quiet refresh of the scoreboard

  let dateStr = todayStr();
  let games = [];
  let filter = 'all';
  let pollTimer = null;

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
    const listEl = $('#game-list');
    const banner = $('#banner');
    const statusLine = $('#status-line');

    UI.clear(listEl).appendChild(spinner());
    UI.clear(banner);
    statusLine.textContent = 'Loading…';

    try {
      games = await MLB.getSchedule(dateStr);
      render();
      statusLine.textContent =
        `${games.length} game${games.length === 1 ? '' : 's'} · ` +
        `${games.filter((g) => g.status.abstractGameState === 'Live').length} in progress · ` +
        `updated ${new Date().toLocaleTimeString()}`;
    } catch (err) {
      console.error(err);
      UI.clear(listEl);
      banner.appendChild(
        UI.el('div', 'banner-error',
          `Couldn't reach the MLB StatsAPI (${err.message || err}). ` +
          'Check your connection and try again.'));
      banner.appendChild(UI.el('button', 'btn', 'Retry', { onclick: 'Scoreboard.retry()' }));
      statusLine.textContent = 'Load failed';
    }
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    const listEl = $('#game-list');
    UI.clear(listEl);

    const byState = { Preview: [], Live: [], Final: [], Other: [] };
    games.forEach((g) => {
      const key = byState[g.status.abstractGameState] ? g.status.abstractGameState : 'Other';
      byState[key].push(g);
    });

    const ordered =
      [...byState.Live, ...byState.Preview, ...byState.Final, ...byState.Other];

    const filtered = filter === 'all' ? ordered : ordered.filter((g) => {
      if (filter === 'live') return g.status.abstractGameState === 'Live';
      if (filter === 'scheduled') return g.status.abstractGameState === 'Preview';
      if (filter === 'final') return g.status.abstractGameState === 'Final';
      return true;
    });

    const counts = {
      all: games.length,
      live: byState.Live.length,
      scheduled: byState.Preview.length,
      final: byState.Final.length,
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

  function renderTabs(counts) {
    const tabs = [
      ['all', `All (${counts.all})`],
      ['live', `Live (${counts.live})`],
      ['scheduled', `Scheduled (${counts.scheduled})`],
      ['final', `Final (${counts.final})`],
    ];
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

    const card = UI.el('a', `card game-card ${isLive ? 'card-live' : ''}`);
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
    prevDay() { shiftDate(-1); syncUrl(); load(); },
    nextDay() { shiftDate(1); syncUrl(); load(); },
    today() {
      dateStr = todayStr();
      syncUrl();
      load();
    },
    pickDate() {
      const d = $('#date-picker').value;
      if (d) { dateStr = d; syncUrl(); load(); }
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

    const dateLabel = $('#date-label');
    const labelDate = new Date(`${dateStr}T12:00:00`);
    dateLabel.textContent = labelDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    load();
    pollTimer = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
  });
})();
