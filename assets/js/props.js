'use strict';

window.Props = (() => {

  const CACHE = {};

  async function fetchPlayerStats(playerId) {
    if (CACHE[playerId]) return CACHE[playerId];

    const url = `https://statsapi.mlb.com/api/v1/people/${playerId}/stats?stats=statcast,expectedStatistics,season&group=hitting`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      CACHE[playerId] = data;
      return data;
    } catch (e) {
      console.warn('Props: failed to fetch stats for', playerId);
      CACHE[playerId] = null;
      return null;
    }
  }

  // Synchronous read of the per-player stats cache (null until fetched).
  function getCachedPlayerStats(playerId) {
    return CACHE[playerId] || null;
  }

  function getPitcherArsenal(allPlays, pitcherId) {
    const arsenal = {};
    let total = 0;

    (allPlays || []).forEach(play => {
      const pId = play.matchup?.pitcher?.id;
      if (pId !== pitcherId) return;

      (play.playEvents || []).forEach(event => {
        if (event.isPitch && event.details?.type?.code) {
          const type = event.details.type;
          const code = type.code;
          if (!arsenal[code]) {
            arsenal[code] = { desc: type.description, count: 0, veloSum: 0, veloCount: 0 };
          }
          arsenal[code].count++;
          total++;

          if (event.pitchData?.startSpeed) {
            arsenal[code].veloSum += event.pitchData.startSpeed;
            arsenal[code].veloCount++;
          }
        }
      });
    });

    const mix = [];
    for (const code in arsenal) {
      const a = arsenal[code];
      mix.push({
        code,
        desc: a.desc,
        pct: (a.count / total) * 100,
        avgVelo: a.veloCount > 0 ? (a.veloSum / a.veloCount).toFixed(1) : '-'
      });
    }

    mix.sort((a, b) => b.pct - a.pct);
    return { totalPitches: total, mix };
  }

  function parseStatcast(statsData) {
    const result = { xBA: '-', exitVelo: '-', hardHit: '-', launchAngle: '-', avg: '-', ops: '-' };
    if (!statsData || !statsData.stats) return result;

    statsData.stats.forEach(group => {
      if (group.type?.displayName === 'expectedStatistics' && group.splits?.[0]?.stat) {
        result.xBA = group.splits[0].stat.estimatedBaUsingSpeedangle || result.xBA;
      }
      if (group.type?.displayName === 'statcast' && group.splits?.[0]?.stat) {
        result.exitVelo = group.splits[0].stat.launchSpeed || result.exitVelo;
        result.launchAngle = group.splits[0].stat.launchAngle || result.launchAngle;
      }
      if (group.type?.displayName === 'season' && group.splits?.[0]?.stat) {
        result.avg = group.splits[0].stat.avg || result.avg;
        result.ops = group.splits[0].stat.ops || result.ops;
      }
    });
    return result;
  }

  /**
   * Implied pre-at-bat hit probability — the same model the Props tab uses,
   * exposed so the play-by-play timeline can show the probability that was in
   * effect for each finished at-bat (before the batter took the at-bat).
   *
   *   base  = xBA (Statcast expected BA) or season AVG, fallback 0.240
   *   platoon: an opposite-handed batter gets a small edge
   *
   * Returns { prob, baseBa, platoonAdv } — prob is a string "NN.N".
   */
  function modelHitProbability(stats, bHand, pHand) {
    const s = stats || {};
    const baseBa = parseFloat(s.xBA) || parseFloat(s.avg) || 0.240;
    const b = (bHand || 'R').toUpperCase();
    const p = (pHand || 'R').toUpperCase();
    const platoonAdv = (p !== b) ? 0.04 : -0.015;
    let prob = (baseBa + platoonAdv) * 100;
    prob = Math.max(0, Math.min(100, prob));
    return {
      prob: prob.toFixed(1),
      baseBa: baseBa.toFixed(3),
      platoonAdv: platoonAdv.toFixed(3),
    };
  }

  function render(container, gd) {
    if (!gd || !gd.liveData) return;

    container.innerHTML = '<div class="props-loading">Loading matchup & statcast data...</div>';

    const live = gd.liveData;
    const offense = live.linescore?.offense || {};
    const defense = live.linescore?.defense || {};

    const currentPitcher = defense.pitcher;
    const batter = offense.batter;
    const onDeck = offense.onDeck;
    const inHole = offense.inTheHole;

    if (!currentPitcher || !batter) {
      container.innerHTML = '<div class="props-empty" style="padding:2rem;text-align:center;color:var(--c-text-muted);">No active matchup available.</div>';
      return;
    }

    const arsenal = getPitcherArsenal(live.plays?.allPlays, currentPitcher.id);
    const matchupPitcherInfo = live.plays?.currentPlay?.matchup?.pitchHand;

    Promise.all([
      fetchPlayerStats(batter.id),
      onDeck ? fetchPlayerStats(onDeck.id) : Promise.resolve(null),
      inHole ? fetchPlayerStats(inHole.id) : Promise.resolve(null)
    ]).then(([batterData, onDeckData, inHoleData]) => {

      const bStats = parseStatcast(batterData);
      const odStats = parseStatcast(onDeckData);
      const ihStats = parseStatcast(inHoleData);

      container.innerHTML = '';

      const pSection = document.createElement('div');
      pSection.className = 'props-section pitcher-section';

      const pTitle = document.createElement('h3');
      pTitle.className = 'props-heading';
      pTitle.textContent = `Current Pitcher: ${currentPitcher.fullName}`;
      pSection.appendChild(pTitle);

      if (arsenal.totalPitches > 0) {
        const pMix = document.createElement('div');
        pMix.className = 'arsenal-mix';

        let mixHtml = `<div class="mix-meta">${arsenal.totalPitches} pitches thrown today</div>`;
        mixHtml += `<div class="mix-grid">`;
        arsenal.mix.forEach(m => {
          mixHtml += `
            <div class="mix-item">
              <span class="mix-code" title="${m.desc}">${m.code}</span>
              <span class="mix-pct">${m.pct.toFixed(1)}%</span>
              <span class="mix-velo">${m.avgVelo} mph</span>
            </div>
          `;
        });
        mixHtml += `</div>`;
        pMix.innerHTML = mixHtml;
        pSection.appendChild(pMix);
      } else {
        pSection.innerHTML += '<p class="mix-meta">No pitches thrown yet today.</p>';
      }

      container.appendChild(pSection);

      const bSection = document.createElement('div');
      bSection.className = 'props-section batters-section';

      const bTitle = document.createElement('h3');
      bTitle.className = 'props-heading';
      bTitle.textContent = `Propabilities: Upcoming Batters vs ${currentPitcher.fullName}`;
      bSection.appendChild(bTitle);

      const renderBatterCard = (player, label, stats, pitcherHandCode) => {
        if (!player) return '';

        // Shared model: implied hit probability from xBA/AVG + platoon matchup.
        const model = modelHitProbability(stats, player.batSide?.code, pitcherHandCode);

        return `
          <div class="batter-prop-card ${label === 'Current Batter' ? 'active-batter' : ''}">
            <div class="b-header">
              <img src="${MLB.headshotUrl(player.id)}" alt="" class="b-headshot" onerror="this.style.display='none'">
              <div class="b-header-text">
                <div class="b-label">${label}</div>
                <div class="b-name">${player.fullName}</div>
              </div>
            </div>
            <div class="b-stats">
              <div class="stat-col"><span class="stat-lbl">xBA</span><strong class="stat-val">${stats.xBA}</strong></div>
              <div class="stat-col"><span class="stat-lbl">Exit Velo</span><strong class="stat-val">${stats.exitVelo !== '-' ? stats.exitVelo + ' mph' : '-'}</strong></div>
              <div class="stat-col"><span class="stat-lbl">Launch ∠</span><strong class="stat-val">${stats.launchAngle !== '-' ? stats.launchAngle + '°' : '-'}</strong></div>
            </div>
            <div class="hit-prob">
              <span class="prob-label">Implied Hit Probability</span>
              <div class="prob-bar-container">
                <div class="prob-bar" style="width: ${model.prob}%"></div>
              </div>
              <span class="prob-value">${model.prob}%</span>
            </div>
          </div>
        `;
      };

      const pitcherHandCode = matchupPitcherInfo?.code;

      bSection.innerHTML += `
        <div class="batters-grid">
          ${renderBatterCard(batter, 'Current Batter', bStats, pitcherHandCode)}
          ${renderBatterCard(onDeck, 'On Deck', odStats, pitcherHandCode)}
          ${renderBatterCard(inHole, 'In The Hole', ihStats, pitcherHandCode)}
        </div>
      `;

      container.appendChild(bSection);

    });
  }

  return {
    render,
    fetchPlayerStats,
    getCachedPlayerStats,
    parseStatcast,
    modelHitProbability,
  };
})();
