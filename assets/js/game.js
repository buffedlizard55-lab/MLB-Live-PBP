/* ============================================================================
 * game.js — single-game "Gameday" view
 * Renders: score header, live "at bat" module (batter, pitcher, count,
 * runners), linescore, box score, and the play-by-play timeline.
 * Polls the live feed while the game is in progress.
 * ==========================================================================*/
'use strict';

(() => {
  // Five seconds keeps the count and pitch events responsive without hammering the feed.
  const LIVE_POLL_MS = 5000;
  const PREVIEW_POLL_MS = 120000;
  const FINAL_POLL_MS = 300000;

  let gamePk = null;
  let feed = null;
  let pollTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = 0;
  let lastToken = null;
  let activeTab = 'plays';
  let requestInFlight = false;

  /* ------------------------------------------------------------------ boot */

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    gamePk = params.get('gamePk');
    if (!gamePk || !/^\d+$/.test(gamePk)) {
      $('#main').appendChild(UI.el('div', 'empty',
        'No game selected. Pick a game from the scoreboard.'));
      $('#main').appendChild(UI.el('a', 'btn', '← Back to scoreboard', { href: 'index.html' }));
      return;
    }
    wireTabs();
    $('#refresh-btn').addEventListener('click', () => load(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        load(true);
        startPolling();
      } else {
        stopPolling();
      }
    });
    load(true);
  });

  /* ----------------------------------------------------------------- fetch */

  async function load(showSpinner) {
    if (!gamePk || requestInFlight) return;
    requestInFlight = true;
    if (showSpinner && !feed) $('#loading').classList.add('visible');
    try {
      const data = await MLB.getLiveFeed(gamePk);
      const token = feedToken(data);
      const changed = token !== lastToken || !feed;
      feed = data;
      lastToken = token;
      // A live feed can be large. Keep the existing DOM when no baseball state changed.
      if (changed) {
        renderAll();
      } else {
        renderStatusLine();
      }
      $('#loading').classList.remove('visible');
      scheduleNext();
    } catch (err) {
      console.error(err);
      $('#loading').classList.remove('visible');
      $('#status-line').textContent = `Update failed: ${err.message || err} — retrying…`;
      scheduleNext(5000);
    } finally {
      requestInFlight = false;
    }
  }

  /**
   * State token deliberately ignores the feed timestamp: it changes even when no
   * play changed. This prevents a costly full timeline/box-score redraw on idle polls.
   */
  function feedToken(data) {
    const plays = data.liveData && data.liveData.plays;
    const current = plays && plays.currentPlay;
    const all = (plays && plays.allPlays) || [];
    const last = all[all.length - 1] || {};
    const event = current && current.playEvents && current.playEvents[current.playEvents.length - 1];
    const ls = data.liveData && data.liveData.linescore;
    return [
      all.length,
      last.about && last.about.atBatIndex,
      last.about && last.about.endTime,
      current && current.about && current.about.atBatIndex,
      event && (event.playId || event.index),
      event && event.details && event.details.description,
      current && current.count && `${current.count.balls}-${current.count.strikes}-${current.count.outs}`,
      ls && ls.currentInning, ls && ls.inningState,
      ls && ls.teams && ls.teams.away && ls.teams.away.runs,
      ls && ls.teams && ls.teams.home && ls.teams.home.runs,
    ].join('|');
  }

  /* ------------------------------------------------------------- scheduling */

  function isLive() {
    return feed && feed.gameData && feed.gameData.status &&
           feed.gameData.status.abstractGameState === 'Live';
  }

  function scheduleNext(overrideMs) {
    const interval = overrideMs || (isLive() ? LIVE_POLL_MS :
      (gd().status && gd().status.abstractGameState === 'Final' ? FINAL_POLL_MS : PREVIEW_POLL_MS));
    nextRefreshAt = Date.now() + interval;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { load(false); }, interval);
    startCountdown(interval);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    clearInterval(countdownTimer);
    $('#countdown').textContent = '';
  }

  function startCountdown(interval) {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const left = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
      $('#countdown').textContent = UI.fmtCountdown(left);
    }, 250);
  }

  /* ------------------------------------------------------------ data access */

  function gd() { return (feed && feed.gameData) || {}; }
  function ld() { return (feed && feed.liveData) || {}; }

  function player(id) {
    const players = gd().players || {};
    return players[`ID${id}`] || null;
  }

  function playerName(id) {
    const p = player(id);
    if (p) return p.fullName;
    // fallback bundle: search boxscore player map
    const box = ld().boxscore || {};
    return ['away', 'home'].reduce((found, side) => {
      const pMap = box.teams && box.teams[side] && box.teams[side].players || {};
      const entry = pMap[`ID${id}`];
      return found || (entry && entry.person && entry.person.fullName) || null;
    }, null) || `#${id}`;
  }

  function teamInfo(side) {
    const g = gd().teams && gd().teams[side];
    if (g && g.id) {
      return { id: g.id, name: g.name, abbrev: g.abbreviation, record: g.record && g.record.leagueRecord };
    }
    const box = ld().boxscore && ld().boxscore.teams && ld().boxscore.teams[side];
    if (box && box.team && box.team.id) {
      return { id: box.team.id, name: box.team.name, abbrev: box.team.abbreviation, record: null };
    }
    return { id: null, name: side === 'away' ? 'Away' : 'Home', abbrev: side === 'away' ? 'AWY' : 'HOM', record: null };
  }

  function teamRecord(side) {
    const t = teamInfo(side);
    return t.record ? `${t.record.wins}-${t.record.losses}` : '';
  }

  function score(side) {
    const ls = ld().linescore;
    return ls && ls.teams && ls.teams[side] ? ls.teams[side].runs : null;
  }

  function linescore() { return ld().linescore || null; }
  function boxscore() { return ld().boxscore || null; }
  function playsData() { return ld().plays || null; }

  /* ------------------------------------------------------------- rendering */

  function renderAll() {
    document.title = pageTitle();
    renderHeader();
    renderLivePanel();
    renderLinescore();
    // The box score is the heaviest view; render it only when it can be seen.
    if (activeTab === 'boxscore') renderBoxscore();
    if (activeTab === 'plays') renderPlays();
    if (activeTab === 'props' && window.Props) window.Props.render($('#props-wrap'), feed);
    renderStatusLine();
  }

  function pageTitle() {
    const status = gd().status;
    const ls = linescore();
    const away = teamInfo('away');
    const home = teamInfo('home');
    const label = MLB.inningLabel(ls, status);
    const aS = score('away'), hS = score('home');
    const base = `${away.abbrev} ${aS == null ? '-' : aS}, ${home.abbrev} ${hS == null ? '-' : hS}`;
    return status && status.abstractGameState === 'Live' ? `${base} · ${label}` : base;
  }

  /* -------------------------------------------------------------- header */

  function renderHeader() {
    const status = gd().status;
    const ls = linescore();
    const away = teamInfo('away');
    const home = teamInfo('home');

    const awayBlock = teamBlock('away', away);
    const homeBlock = teamBlock('home', home);

    const center = UI.clear($('#header-center'));
    center.appendChild(UI.el('div', 'big-score',
      `${score('away') == null ? '–' : score('away')} – ${score('home') == null ? '–' : score('home')}`));

    const chip = UI.statusChip(status || { detailedState: 'Unknown', abstractGameState: '' },
      MLB.inningLabel(ls, status) || (status && status.detailedState));
    center.appendChild(chip);
    if (status && status.abstractGameState === 'Live' && ls) {
      center.appendChild(UI.el('div', 'header-inning',
        `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''} · ` +
        `${ls.inningState || ''} · ${ls.outs == null ? '' : ls.outs + ' out'}`));
    } else if (status && status.abstractGameState === 'Preview') {
      center.appendChild(UI.el('div', 'header-inning', `First pitch ${MLB.localTime(gd().datetime && gd().datetime.dateTime)}`));
    }

    $('#header-away').replaceChildren(awayBlock);
    $('#header-home').replaceChildren(homeBlock);

    /* meta strip */
    const meta = UI.clear($('#header-meta'));
    const bits = [];
    const dt = gd().datetime;
    if (dt) bits.push(MLB.localDateTime(dt.dateTime));
    if (gd().venue && gd().venue.name) bits.push(gd().venue.name);
    const att = attendance();
    if (att) bits.push(`Att: ${att}`);
    const wx = gd().weather;
    if (wx && wx.temp) {
      bits.push(`${wx.temp}°F${wx.condition ? ', ' + wx.condition : ''}`);
    }
    meta.appendChild(UI.el('span', '', bits.join(' · ')));

    /* decisions */
    const decisions = ld().decisions || {};
    const decLine = UI.clear($('#header-decisions'));
    if (decisions.winner || decisions.loser || decisions.save) {
      const parts = [];
      if (decisions.winner) parts.push(`W: ${decisionName(decisions.winner, 'wins', 'losses')}`);
      if (decisions.loser) parts.push(`L: ${decisionName(decisions.loser, 'wins', 'losses')}`);
      if (decisions.save) parts.push(`SV: ${decisionName(decisions.save, 'saves')}`);
      decLine.appendChild(UI.el('span', 'decisions', parts.join('   ·   ')));
    }

    const gameNote = gd().game && (gd().game.description || gd().game.notes && gd().game.notes[0]);
    if (gameNote && status && status.abstractGameState === 'Preview') {
      decLine.appendChild(UI.el('span', 'game-note', gameNote));
    }
  }

  function teamBlock(side, t) {
    const block = UI.el('div', `team-block team-${side}`);
    const logo = UI.teamLogo(t.id, t.name, t.abbrev, 'header-logo');
    block.appendChild(logo);
    const info = UI.el('div', 'team-block-info');
    info.appendChild(UI.el('div', 'team-block-name', t.name));
    info.appendChild(UI.el('div', 'team-block-record', teamRecord(side)));
    block.appendChild(info);
    return block;
  }

  function decisionName(d, statA, statB) {
    const stats = pitcherStats(d.id);
    const a = stats && stats[statA];
    const b = stats && stats[statB];
    const rec = a != null && b != null ? ` (${a}-${b})` : '';
    return `${playerName(d.id)}${rec}`;
  }

  function pitcherStats(id) {
    const box = boxscore();
    if (!box || !box.teams) return null;
    for (const side of ['away', 'home']) {
      const entry = box.teams[side].players[`ID${id}`];
      if (entry && entry.stats && entry.stats.pitching) return entry.stats.pitching;
    }
    return null;
  }

  function attendance() {
    const box = boxscore();
    if (!box || !box.info) return null;
    for (const item of box.info) {
      if (item && /attendance/i.test(item.label)) return item.value;
    }
    return null;
  }

  /* ------------------------------------------------------- live "now" panel */

  function renderLivePanel() {
    const panel = UI.clear($('#live-panel'));
    const status = gd().status;
    const abstract = status && status.abstractGameState;

    if (abstract === 'Preview') {
      panel.appendChild(previewPanel());
      return;
    }
    if (abstract === 'Final') {
      panel.appendChild(finalPanel());
      return;
    }

    const plays = playsData();
    const cp = (plays && plays.currentPlay) || {};
    const about = cp.about || {};
    const matchup = cp.matchup || {};
    const count = cp.count || {};
    const ls = linescore();

    /* between innings */
    const between = (ls && (ls.inningState === 'Middle' || ls.inningState === 'End')) ||
                    (about.isComplete && (ls && ls.inningState !== 'Bottom' && ls.inningState !== 'Top'));

    const grid = UI.el('div', 'live-grid');

    /* --- at bat card --- */
    const atBat = UI.el('div', 'panel-card at-bat-card');
    atBat.appendChild(UI.el('h3', 'panel-title', between ? 'In Between Innings' : 'At Bat'));

    if (between) {
      atBat.appendChild(UI.el('p', 'between-text',
        `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''} — between innings`));
    } else {
      const batter = matchup.batter || {};
      const battingSide = about.halfInning === 'bottom' ? 'home' : 'away';
      const orderPos = battingOrderPosition(battingSide, batter.id);

      const row = UI.el('div', 'ab-row');
      const shot = UI.headshot(batter.id, batter.fullName, 'ab-headshot');
      row.appendChild(shot);
      const info = UI.el('div', 'ab-info');
      info.appendChild(UI.el('div', 'ab-name', batter.fullName || '—'));
      info.appendChild(UI.el('div', 'ab-meta',
        `${batSideDesc(matchup.batSide)}${orderPos ? ` · #${orderPos} hitter` : ''}`));
      row.appendChild(info);
      atBat.appendChild(row);

      // A compact version of the two-sided model is visible without opening
      // the Props tab. It remains a pre-plate-appearance forecast, so the
      // current count never changes the estimate mid-at-bat.
      const forecast = liveHitForecast(matchup);
      if (forecast) atBat.appendChild(forecast);

      /* count + outs */
      const countWrap = UI.el('div', 'count-wrap');
      countWrap.appendChild(UI.countDots(count.balls, count.strikes, count.outs));
      atBat.appendChild(countWrap);

      /* runners */
      const runners = (cp.runners || []).filter((r) => r.movement && !r.movement.isOut && r.movement.end);
      if (runners.length) {
        const runRow = UI.el('div', 'runners-row');
        runRow.appendChild(UI.diamond(UI.basesFromRunners(cp.runners)));
        runRow.appendChild(UI.el('span', 'runners-text',
          `Runners on ${runners.map((r) => shortBase(r.movement.end)).join(', ')}`));
        atBat.appendChild(runRow);
      } else {
        atBat.appendChild(UI.el('div', 'runners-empty', 'Bases empty'));
      }

      /* on deck / in the hole */
      const next = nextBatters(battingSide, batter.id);
      if (next.length) {
        const deck = UI.el('div', 'deck-row');
        next.forEach((n, i) => {
          deck.appendChild(UI.el('span', `deck ${i === 0 ? 'deck-1' : ''}`,
            `${i === 0 ? 'On deck' : 'In the hole'}: ${n}`));
        });
        atBat.appendChild(deck);
      }
    }

    /* --- pitching card --- */
    const pitch = UI.el('div', 'panel-card pitching-card');
    pitch.appendChild(UI.el('h3', 'panel-title', 'Pitching'));
    const pitcher = matchup.pitcher || {};
    const pitchingSide = about.halfInning === 'bottom' ? 'away' : 'home';
    const pStats = pitcherStats(pitcher.id);
    // Boxscore counters are supplied by the live feed and avoid rescanning every pitch.
    const pitchCount = pStats && pStats.pitchesThrown != null
      ? { total: pStats.pitchesThrown, strikes: pStats.strikes || 0 }
      : countPitcherPitches(pitcher.id);

    const prow = UI.el('div', 'ab-row');
    const pshot = UI.headshot(pitcher.id, pitcher.fullName, 'ab-headshot');
    prow.appendChild(pshot);
    const pinfo = UI.el('div', 'ab-info');
    pinfo.appendChild(UI.el('div', 'ab-name', pitcher.fullName || '—'));
    const pMetaBits = [];
    if (pStats && pStats.inningsPitched) pMetaBits.push(`${UI.fmtInnings(pStats.inningsPitched)} IP`);
    if (pStats && pStats.hits != null) pMetaBits.push(`${pStats.hits} H`);
    if (pStats && pStats.earnedRuns != null) pMetaBits.push(`${pStats.earnedRuns} ER`);
    if (pStats && pStats.baseOnBalls != null) pMetaBits.push(`${pStats.baseOnBalls} BB`);
    if (pStats && pStats.strikeOuts != null) pMetaBits.push(`${pStats.strikeOuts} K`);
    pinfo.appendChild(UI.el('div', 'ab-meta',
      [pitchHandDesc(matchup.pitchHand), pMetaBits.join(' · ')].filter(Boolean).join(' · ')));
    prow.appendChild(pinfo);
    pitch.appendChild(prow);

    const pitchStats = UI.el('div', 'pitch-stats');
    pitchStats.appendChild(UI.el('span', 'stat-chip', `Pitches: ${pitchCount.total}`));
    if (pitchCount.strikes) {
      pitchStats.appendChild(UI.el('span', 'stat-chip', `${pitchCount.strikes} strikes`));
    }
    if (pStats && pStats.pitchesThrown != null) {
      pitchStats.appendChild(UI.el('span', 'stat-chip',
        `PC-ST: ${pStats.pitchesThrown}-${pStats.strikes || 0}`));
    }
    const lastVelo = lastPitchVelo(pitcher.id);
    if (lastVelo) pitchStats.appendChild(UI.el('span', 'stat-chip', `Last pitch: ${lastVelo} mph`));
    pitch.appendChild(pitchStats);

    grid.appendChild(atBat);
    grid.appendChild(pitch);
    panel.appendChild(grid);

    /* last play strip */
    const lastPlay = UI.el('div', 'last-play');
    lastPlay.appendChild(UI.el('span', 'last-play-label', 'Last play'));
    lastPlay.appendChild(UI.el('span', 'last-play-text',
      (cp.result && cp.result.description) || '—'));
    panel.appendChild(lastPlay);
  }

  function previewPanel() {
    const wrap = UI.el('div', 'panel-card preview-card');
    wrap.appendChild(UI.el('h3', 'panel-title', 'Game Preview'));
    const dt = gd().datetime;
    wrap.appendChild(UI.el('p', 'preview-line',
      `First pitch: ${MLB.localDateTime(dt && dt.dateTime)}`));
    if (gd().venue && gd().venue.name) {
      wrap.appendChild(UI.el('p', 'preview-line', `Venue: ${gd().venue.name}`));
    }
    wrap.appendChild(UI.el('p', 'preview-note',
      'Lineups, starting pitchers and live coverage appear here once the game starts.'));
    return wrap;
  }

  function finalPanel() {
    const wrap = UI.el('div', 'panel-card final-card');
    wrap.appendChild(UI.el('h3', 'panel-title', 'Game Over'));
    const away = teamInfo('away');
    const home = teamInfo('home');
    wrap.appendChild(UI.el('p', 'final-line',
      `${away.name} ${score('away')}, ${home.name} ${score('home')}`));
    const ls = linescore();
    if (ls && ls.teams) {
      wrap.appendChild(UI.el('p', 'final-stats',
        `${ls.teams.away.hits} hits, ${ls.teams.away.errors} errors · ` +
        `${ls.teams.home.hits} hits, ${ls.teams.home.errors} errors`));
    }
    return wrap;
  }

  /* --------------------------------------- compact live two-sided forecast */

  function gameSeason() {
    const season = gd().game && gd().game.season;
    return /^\d{4}$/.test(String(season || '')) ? String(season) : null;
  }

  /**
   * Put the model where fans need it most: directly below the active batter.
   * The element is intentionally local to the render, so a delayed response
   * from an older at-bat cannot overwrite a newer matchup after a poll.
   */
  function liveHitForecast(matchup) {
    const batter = matchup && matchup.batter;
    const pitcher = matchup && matchup.pitcher;
    if (!batter || !batter.id || !pitcher || !pitcher.id ||
        !window.Props || !window.Props.getHitPrediction) return null;

    const bHand = matchup.batSide && matchup.batSide.code;
    const pHand = matchup.pitchHand && matchup.pitchHand.code;
    const key = `${batter.id}:${pitcher.id}:${bHand || ''}:${pHand || ''}`;
    const forecast = UI.el('div', 'live-hit-forecast loading', '', {
      'aria-live': 'polite',
      'data-matchup-key': key,
    });
    forecast.appendChild(UI.el('span', 'live-hit-label', 'Two-sided hit forecast'));
    forecast.appendChild(UI.el('span', 'live-hit-value', 'Loading…'));

    window.Props.getHitPrediction(batter.id, pitcher.id, bHand, pHand, gameSeason())
      .then((model) => {
        if (!forecast.isConnected || forecast.dataset.matchupKey !== key) return;
        forecast.replaceChildren();
        forecast.classList.remove('loading');
        forecast.classList.add(`model-${model.coverage}`);

        const heading = UI.el('div', 'live-hit-heading');
        heading.appendChild(UI.el('span', 'live-hit-label', 'Two-sided hit forecast'));
        heading.appendChild(UI.el('strong', 'live-hit-value', `${model.prob}%`));
        forecast.appendChild(heading);

        const details = UI.el('div', 'live-hit-details');
        const batterSignal = model.batter.available ? model.batter.rate.toFixed(3) : '—';
        const pitcherSignal = model.pitcher.available ? model.pitcher.rate.toFixed(3) : '—';
        details.appendChild(UI.el('span', '', `Batter ${batterSignal}`));
        details.appendChild(UI.el('span', '', `Pitcher ${pitcherSignal}`));
        details.appendChild(UI.el('span', '', `No hit ${model.noHitProb}%`));
        forecast.appendChild(details);
        forecast.appendChild(UI.el('div', 'live-hit-coverage', model.coverageLabel));
        forecast.title = `Pre-plate-appearance forecast: ${window.Props.describeHitModel
          ? window.Props.describeHitModel(model)
          : model.coverageLabel}`;
      })
      .catch(() => {
        if (!forecast.isConnected || forecast.dataset.matchupKey !== key) return;
        forecast.classList.remove('loading');
        forecast.replaceChildren(UI.el('span', 'live-hit-label', 'Hit forecast unavailable'));
      });

    return forecast;
  }

  /* -------------------------------------------------------------- linescore */

  function renderLinescore() {
    const ls = linescore();
    const wrap = UI.clear($('#linescore-wrap'));
    if (!ls || !ls.innings || !ls.innings.length) {
      wrap.appendChild(UI.el('div', 'empty small', 'No linescore yet.'));
      return;
    }
    const status = gd().status;
    const isFinal = status && status.abstractGameState === 'Final';
    const innings = ls.innings;
    const maxInn = innings.length;

    const table = UI.el('table', 'linescore-table');
    const thead = UI.el('thead');
    const hRow = UI.el('tr');
    hRow.appendChild(UI.el('th', '', ''));
    hRow.appendChild(UI.el('th', '', 'Team'));
    for (let i = 0; i < maxInn; i += 1) {
      hRow.appendChild(UI.el('th', 'inn-cell', String(innings[i].num)));
    }
    hRow.appendChild(UI.el('th', 'total-cell', 'R'));
    hRow.appendChild(UI.el('th', 'total-cell', 'H'));
    hRow.appendChild(UI.el('th', 'total-cell', 'E'));
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = UI.el('tbody');
    for (const side of ['away', 'home']) {
      const t = teamInfo(side);
      const row = UI.el('tr', `ls-row ls-${side}`);
      row.appendChild(UI.el('td', 'ls-abbrev', t.abbrev));
      row.appendChild(UI.el('td', 'ls-name', t.name));
      let scoredLast = false;
      for (let i = 0; i < maxInn; i += 1) {
        const inn = innings[i];
        const half = inn[side] || {};
        let cell = '–';
        if (half.runs != null) {
          cell = String(half.runs);
        } else if (isFinal && i === maxInn - 1 && side === 'home') {
          cell = 'X'; // home team didn't bat in the bottom of the final inning
        }
        const td = UI.el('td', 'inn-cell', cell);
        if (half.runs != null && half.runs > 0) {
          td.classList.add('inn-run');
          if (i === maxInn - 1) scoredLast = true;
        }
        row.appendChild(td);
      }
      const totals = ls.teams[side];
      row.appendChild(UI.el('td', 'total-cell strong', String(totals.runs)));
      row.appendChild(UI.el('td', 'total-cell', String(totals.hits)));
      row.appendChild(UI.el('td', 'total-cell', String(totals.errors)));
      if (scoredLast && isFinal) row.classList.add('walkoff');
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  /* --------------------------------------------------------------- boxscore */

  function renderBoxscore() {
    const wrap = UI.clear($('#boxscore-wrap'));
    const box = boxscore();
    if (!box || !box.teams) {
      wrap.appendChild(UI.el('div', 'empty small', 'No box score yet.'));
      return;
    }
    for (const side of ['away', 'home']) {
      const team = box.teams[side];
      const t = teamInfo(side);
      const sec = UI.el('section', 'box-section');
      const head = UI.el('h3', 'box-team', `${t.name}  (${teamRecord(side)})`);
      head.style.borderLeftColor = t.id ? UI.teamColor(t.id) : '#2f81f7';
      sec.appendChild(head);
      sec.appendChild(battingTable(side, team));
      sec.appendChild(pitchingTable(side, team));
      wrap.appendChild(sec);
    }
  }

  function battingTable(side, team) {
    const table = UI.el('table', 'box-table bat-table');
    table.appendChild(headerRow(['#', 'Batter', 'AB', 'R', 'H', 'RBI', 'BB', 'SO', 'AVG']));

    const rows = orderRows(side, team);
    const tbody = UI.el('tbody');
    rows.forEach(([id, entry]) => {
      const b = (entry.stats && entry.stats.batting) || {};
      if (b.atBats == null && b.hits == null && b.rbi == null) return;
      const tr = UI.el('tr');
      tr.appendChild(UI.el('td', '', orderSlot(entry)));
      const nameCell = UI.el('td', 'player-cell');
      nameCell.appendChild(UI.el('span', 'player-name', playerName(id)));
      const pos = entry.position && entry.position.abbreviation;
      if (pos) nameCell.appendChild(UI.el('span', 'player-pos', pos));
      tr.appendChild(nameCell);
      tr.appendChild(UI.el('td', '', fmtStat(b.atBats)));
      tr.appendChild(UI.el('td', '', fmtStat(b.runs)));
      tr.appendChild(UI.el('td', '', fmtStat(b.hits)));
      tr.appendChild(UI.el('td', '', fmtStat(b.rbi)));
      tr.appendChild(UI.el('td', '', fmtStat(b.baseOnBalls)));
      tr.appendChild(UI.el('td', '', fmtStat(b.strikeOuts)));
      tr.appendChild(UI.el('td', '', b.avg != null ? b.avg : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    /* team totals */
    const tot = (team.teamStats && team.teamStats.batting) || {};
    const foot = UI.el('tfoot');
    const tr = UI.el('tr', 'totals-row');
    tr.appendChild(UI.el('td', '', ''));
    tr.appendChild(UI.el('td', '', 'Totals'));
    tr.appendChild(UI.el('td', '', fmtStat(tot.atBats)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.runs)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.hits)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.rbi)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.baseOnBalls)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.strikeOuts)));
    tr.appendChild(UI.el('td', '', tot.avg != null ? tot.avg : '—'));
    foot.appendChild(tr);
    table.appendChild(foot);
    return table;
  }

  function pitchingTable(side, team) {
    const table = UI.el('table', 'box-table pitch-table');
    table.appendChild(headerRow(['Pitcher', 'IP', 'H', 'R', 'ER', 'BB', 'SO', 'HR', 'PC-ST', 'ERA']));
    const tbody = UI.el('tbody');
    (team.pitchers || []).forEach((id) => {
      const entry = team.players[`ID${id}`];
      if (!entry) return;
      const p = (entry.stats && entry.stats.pitching) || {};
      if (p.inningsPitched == null && p.outs == null && p.hits == null && p.strikeOuts == null) return;
      const tr = UI.el('tr');
      tr.appendChild(UI.el('td', 'player-cell', playerName(id)));
      tr.appendChild(UI.el('td', '', UI.fmtInnings(p.inningsPitched)));
      tr.appendChild(UI.el('td', '', fmtStat(p.hits)));
      tr.appendChild(UI.el('td', '', fmtStat(p.runs)));
      tr.appendChild(UI.el('td', '', fmtStat(p.earnedRuns)));
      tr.appendChild(UI.el('td', '', fmtStat(p.baseOnBalls)));
      tr.appendChild(UI.el('td', '', fmtStat(p.strikeOuts)));
      tr.appendChild(UI.el('td', '', fmtStat(p.homeRuns)));
      tr.appendChild(UI.el('td', '',
        p.pitchesThrown != null ? `${p.pitchesThrown}-${p.strikes != null ? p.strikes : 0}` : '—'));
      tr.appendChild(UI.el('td', '', p.era != null ? p.era : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function headerRow(cols) {
    const thead = UI.el('thead');
    const tr = UI.el('tr');
    cols.forEach((c) => tr.appendChild(UI.el('th', '', c)));
    thead.appendChild(tr);
    return thead;
  }

  /** Batting rows ordered by the API's battingOrder, then batting order numbers. */
  function orderRows(side, team) {
    const orderList = team.battingOrder || [];
    const map = new Map();
    orderList.forEach((id) => { const e = team.players[`ID${id}`]; if (e) map.set(id, e); });
    (team.batters || []).forEach((id) => {
      const e = team.players[`ID${id}`];
      if (e && !map.has(id)) map.set(id, e);
    });
    return [...map.entries()].sort((a, b) => {
      const ao = parseInt(a[1].battingOrder || '999', 10);
      const bo = parseInt(b[1].battingOrder || '999', 10);
      return ao - bo;
    });
  }

  function orderSlot(entry) {
    if (!entry.battingOrder) return '';
    const n = parseInt(entry.battingOrder, 10);
    if (Number.isNaN(n) || n <= 0) return '';
    return String(Math.floor(n / 100));
  }

  function fmtStat(v) { return v == null ? '—' : String(v); }

  /* --------------------------------------------------------- play-by-play */

  function renderPlays() {
    const wrap = UI.clear($('#plays-wrap'));
    const plays = playsData();
    if (!plays || !plays.allPlays || !plays.allPlays.length) {
      wrap.appendChild(UI.el('div', 'empty small', 'No plays yet — check back after first pitch.'));
      return;
    }

    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    const list = UI.el('div', 'plays-list');

    // Collect finished at-bats that need a pre-at-bat hit-probability chip.
    const probItems = [];
    let curKey = null;
    plays.allPlays.forEach((play) => {
      const result = play.result;
      const about = play.about || {};
      if (!result || !result.description || !about || !about.inning) return;
      const key = `${about.halfInning}-${about.inning}`;
      if (key !== curKey) {
        curKey = key;
        list.appendChild(playSectionHeader(about));
      }
      list.appendChild(playRow(play, probItems));
    });
    wrap.appendChild(list);
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;

    // Fill in the hit-probability chips (needs the batters' statcast stats).
    enrichPlayHitProb(probItems);
  }

  /**
   * Whether a play is a *completed* plate appearance (an at-bat that finished).
   * Live/in-progress at-bats have about.isComplete === false and are excluded,
   * since the request was specifically the probability "before taking the at bat".
   */
  function isFinishedAtBat(play) {
    const about = play.about;
    if (!about) return true;             // final games: treat as finished
    return about.isComplete !== false;   // false => still in progress
  }

  /** Did this at-bat result in a hit? Prefer the feed flag, else infer from the event. */
  function atBatWasHit(play) {
    const r = play.result || {};
    if (typeof r.isHit === 'boolean') return r.isHit;
    const ev = r.event || '';
    return /\b(Single|Double|Triple|Home Run|Ground Rule Double|Inside[\s-]the[\s-]park Home Run)\b/i.test(ev);
  }

  /**
   * Compute and paint the pre-at-bat hit forecast for each completed plate
   * appearance. Both hitter and pitcher data are warmed once per game-season;
   * cache hits make later polling renders effectively free.
   */
  async function enrichPlayHitProb(items) {
    if (!items.length || !window.Props || !window.Props.fetchPlayerStats ||
        !window.Props.getCachedPlayerStats || !window.Props.modelHitProbability) return;

    const batterIds = [...new Set(
      items.map((it) => it.play.matchup && it.play.matchup.batter && it.play.matchup.batter.id)
        .filter(Boolean)
    )];
    const pitcherIds = [...new Set(
      items.map((it) => it.play.matchup && it.play.matchup.pitcher && it.play.matchup.pitcher.id)
        .filter(Boolean)
    )];
    const season = gameSeason();

    try {
      await Promise.all([
        ...batterIds.map((id) => window.Props.fetchPlayerStats(id, 'hitting', season)),
        ...pitcherIds.map((id) => window.Props.fetchPlayerStats(id, 'pitching', season)),
      ]);
    } catch (_) { /* individual fetch failures fall back to the league baseline */ }

    items.forEach(({ play, chip, bHand, pHand }) => {
      // A new poll may have rebuilt the play list while requests were pending.
      if (!chip.isConnected) return;

      const matchup = play.matchup || {};
      const batterId = matchup.batter && matchup.batter.id;
      const pitcherId = matchup.pitcher && matchup.pitcher.id;
      const batterData = batterId
        ? window.Props.getCachedPlayerStats(batterId, 'hitting', season)
        : null;
      const pitcherData = pitcherId
        ? window.Props.getCachedPlayerStats(pitcherId, 'pitching', season)
        : null;
      const batterStats = window.Props.parseBatterStats
        ? window.Props.parseBatterStats(batterData)
        : window.Props.parseStatcast(batterData);
      const pitcherStats = window.Props.parsePitcherStats
        ? window.Props.parsePitcherStats(pitcherData)
        : null;
      const model = window.Props.modelHitProbability(batterStats, pitcherStats, bHand, pHand);
      const gotHit = atBatWasHit(play);

      chip.replaceChildren();
      chip.classList.remove('loading');
      chip.classList.add(gotHit ? 'hit-yes' : 'hit-no', `model-${model.coverage}`);
      chip.appendChild(UI.el('span', 'hp-label', 'Hit'));
      chip.appendChild(UI.el('span', 'hp-val', `${model.prob}%`));
      chip.appendChild(UI.el('span', 'hp-mark', gotHit ? '✓' : '✗'));
      const modelDetail = window.Props.describeHitModel
        ? window.Props.describeHitModel(model)
        : model.coverageLabel;
      chip.title = `Pre-at-bat hit forecast: ${model.prob}% · ${modelDetail} · ` +
        (gotHit ? 'got the hit' : 'no hit');
    });
  }

  function playSectionHeader(about) {
    const head = UI.el('div', 'play-section-head');
    const tag = UI.el('span', `half-tag half-${about.halfInning}`,
      about.halfInning === 'top' ? '▲' : '▼');
    head.appendChild(tag);
    head.appendChild(UI.el('span', '', MLB.ordinal(about.inning)));
    return head;
  }

  function playRow(play, probItems) {
    const result = play.result;
    const about = play.about || {};
    const count = play.count || {};

    const row = UI.el('div', 'play-row');
    const main = UI.el('div', 'play-main');
    main.appendChild(UI.el('span', 'play-desc', result.description));
    row.appendChild(main);

    const chips = UI.el('div', 'play-chips');

    /* score after play (only when it changed) */
    if (about.isScoringPlay || (result.rbi || 0) > 0) {
      const away = teamInfo('away');
      const home = teamInfo('home');
      chips.appendChild(UI.el('span', 'chip-score',
        `${away.abbrev} ${result.awayScore}, ${home.abbrev} ${result.homeScore}`));
    }

    /* count */
    chips.appendChild(UI.el('span', 'chip-count',
      `B ${count.balls} · S ${count.strikes} · O ${count.outs}`));

    /* pitch strip */
    const pitches = (play.playEvents || []).filter((e) => e.isPitch);
    if (pitches.length) {
      const strip = UI.el('span', 'pitch-strip');
      pitches.forEach((e) => {
        const call = e.details && e.details.call;
        const type = e.details && e.details.type;
        const velo = e.pitchData && e.pitchData.startSpeed;
        const dot = UI.el('span', `pitch-dot p-${(call && call.code || '?').toLowerCase()}`);
        dot.textContent = (type && type.code) || (call && call.code) || '?';
        dot.title = `${call ? call.description : ''} · ${type ? type.description : ''}` +
                    (velo ? ` · ${velo} mph` : '');
        strip.appendChild(dot);
      });
      chips.appendChild(strip);
    }

    /* two-sided pre-at-bat forecast (completed plate appearances only) */
    if (window.Props && window.Props.modelHitProbability && probItems &&
        isFinishedAtBat(play) && pitches.length &&
        play.matchup && play.matchup.batter && play.matchup.batSide) {
      const bHand = play.matchup.batSide.code || '';
      const pHand = play.matchup.pitchHand ? play.matchup.pitchHand.code : '';
      const chip = UI.el('span', 'chip-hitprob loading', 'Hit …');
      chip.title = 'Loading two-sided pre-at-bat hit forecast';
      chips.appendChild(chip);
      probItems.push({ play, chip, bHand, pHand });
    }

    row.appendChild(chips);
    return row;
  }

  /* ------------------------------------------------------------ live stats */

  /** Position in the batting order (1-9) for a batter id. */
  function battingOrderPosition(side, batterId) {
    const box = boxscore();
    if (!box || !box.teams || !box.teams[side]) return null;
    const order = box.teams[side].battingOrder || [];
    const idx = order.indexOf(batterId);
    return idx >= 0 ? idx + 1 : null;
  }

  /** Next batters (on deck, in the hole) given current batter id. */
  function nextBatters(side, batterId) {
    const box = boxscore();
    if (!box || !box.teams || !box.teams[side]) return [];
    const order = box.teams[side].battingOrder || [];
    const idx = order.indexOf(batterId);
    if (idx < 0) return [];
    return order.slice(idx + 1, idx + 3).map(playerName);
  }

  /** Total pitches / strikes thrown by a pitcher so far, from play events. */
  function countPitcherPitches(pid) {
    const plays = playsData();
    if (!plays || !plays.allPlays) return { total: 0, strikes: 0 };
    let total = 0; let strikes = 0;
    plays.allPlays.forEach((play) => {
      (play.playEvents || []).forEach((e) => {
        if (!e.isPitch) return;
        const p = e.matchup && e.matchup.pitcher;
        if (p && p.id === pid) {
          total += 1;
          if (e.details && e.details.isStrike) strikes += 1;
        }
      });
    });
    return { total, strikes };
  }

  function lastPitchVelo(pid) {
    const plays = playsData();
    if (!plays || !plays.allPlays) return null;
    for (let i = plays.allPlays.length - 1; i >= 0; i -= 1) {
      const events = plays.allPlays[i].playEvents || [];
      for (let j = events.length - 1; j >= 0; j -= 1) {
        const e = events[j];
        const p = e.matchup && e.matchup.pitcher;
        if (e.isPitch && p && p.id === pid && e.pitchData && e.pitchData.startSpeed) {
          return Math.round(e.pitchData.startSpeed);
        }
      }
    }
    return null;
  }

  function batSideDesc(bs) {
    if (!bs) return '';
    const map = { L: 'Bats L', R: 'Bats R', S: 'Bats S' };
    return map[bs.code] || bs.description || '';
  }

  function pitchHandDesc(ph) {
    if (!ph) return '';
    const map = { L: 'LHP', R: 'RHP', S: 'SHP' };
    return map[ph.code] || ph.description || '';
  }

  function shortBase(base) {
    return ({ '1B': '1st', '2B': '2nd', '3B': '3rd' })[base] || base;
  }

  /* ------------------------------------------------------------------- tabs */

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('tab-on', b.dataset.tab === tab);
    });
    $('#panel-plays').style.display = tab === 'plays' ? '' : 'none';
    $('#panel-boxscore').style.display = tab === 'boxscore' ? '' : 'none';
    $('#panel-props').style.display = tab === 'props' ? '' : 'none';
    // Lazy rendering keeps live updates fast on the default play-by-play view.
    if (feed && tab === 'boxscore') renderBoxscore();
    if (feed && tab === 'plays') renderPlays();
    if (feed && tab === 'props' && window.Props) window.Props.render($('#props-wrap'), feed);
  }

  /* ------------------------------------------------------------ status line */

  function renderStatusLine() {
    const line = $('#status-line');
    const updated = new Date().toLocaleTimeString();
    const ls = linescore();
    const bits = [`Updated ${updated}`];
    if (isLive()) {
      const interval = LIVE_POLL_MS / 1000;
      bits.push(`refreshing every ${interval}s`);
    }
    line.textContent = bits.join(' · ');
  }

  function $(sel) { return document.querySelector(sel); }
})();
