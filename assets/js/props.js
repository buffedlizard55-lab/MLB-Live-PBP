/* ============================================================================
 * props.js — matchup data, a transparent two-sided hit forecast, and the
 * Props & Matchup tab.
 *
 * The forecast is deliberately lightweight rather than a black-box betting
 * model. It combines a batter's season hit-quality / batting-average signal
 * with the pitcher's season hit-allowed signal, regresses both toward a league
 * baseline for small samples, and then applies a small handedness adjustment.
 * ==========================================================================*/
'use strict';

window.Props = (() => {
  const STATS_CACHE = new Map();

  // A neutral MLB hit rate used only as a regression target / missing-data fallback.
  const LEAGUE_HIT_RATE = 0.245;
  const BATTER_REGRESSION_AB = 180;
  const PITCHER_REGRESSION_AB = 320;
  const MIN_HIT_PROBABILITY = 0.08;
  const MAX_HIT_PROBABILITY = 0.45;

  let renderVersion = 0;

  /* --------------------------------------------------------------- fetching */

  function normalizedGroup(group) {
    return String(group || 'hitting').toLowerCase() === 'pitching' ? 'pitching' : 'hitting';
  }

  function normalizedSeason(season) {
    const value = String(season || '');
    return /^\d{4}$/.test(value) ? value : '';
  }

  function statsCacheKey(playerId, group, season) {
    return `${normalizedGroup(group)}:${playerId}:${normalizedSeason(season) || 'current'}`;
  }

  /**
   * Fetch one player's current (or supplied game-season) hitting or pitching
   * data. Entries cache the in-flight Promise as well as its resolved value so
   * a timeline with repeated batters does not make duplicate requests.
   */
  function fetchPlayerStats(playerId, group = 'hitting', season = null) {
    if (!playerId) return Promise.resolve(null);

    const statGroup = normalizedGroup(group);
    const seasonValue = normalizedSeason(season);
    const key = statsCacheKey(playerId, statGroup, seasonValue);
    const cached = STATS_CACHE.get(key);
    if (cached) return cached.promise;

    const params = new URLSearchParams({
      // Pitcher forecasts only need expected / season rates. Avoid requesting
      // a hitter-specific Statcast group on pitching-only player records.
      stats: statGroup === 'pitching' ? 'expectedStatistics,season' : 'statcast,expectedStatistics,season',
      group: statGroup,
    });
    if (seasonValue) params.set('season', seasonValue);

    const entry = { data: null, resolved: false, promise: null };
    entry.promise = fetch(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        // A forecast can still use the opposite side or its league baseline.
        console.warn(`Props: failed to fetch ${statGroup} stats for ${playerId}`, err);
        return null;
      })
      .then((data) => {
        entry.data = data;
        entry.resolved = true;
        return data;
      });

    STATS_CACHE.set(key, entry);
    return entry.promise;
  }

  /** Synchronous read after fetchPlayerStats has resolved; defaults preserve the old API. */
  function getCachedPlayerStats(playerId, group = 'hitting', season = null) {
    const entry = STATS_CACHE.get(statsCacheKey(playerId, group, season));
    return entry && entry.resolved ? entry.data : null;
  }

  async function getHitPrediction(batterId, pitcherId, batterHand, pitcherHand, season = null, gameContext = null) {
    const [batterData, pitcherData] = await Promise.all([
      fetchPlayerStats(batterId, 'hitting', season),
      fetchPlayerStats(pitcherId, 'pitching', season),
    ]);
    return modelHitProbability(
      parseBatterStats(batterData),
      parsePitcherStats(pitcherData),
      batterHand,
      pitcherHand,
      gameContext,
    );
  }

  /* ----------------------------------------------------------- stat parsing */

  function finiteNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value == null) return null;
    const text = String(value).trim().replace(/,/g, '');
    if (!text || text === '-' || text.toLowerCase() === 'null') return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function rate(value) {
    let parsed = finiteNumber(value);
    if (parsed == null) return null;
    // Accept either .245 (StatsAPI's usual shape) or 24.5 from a fixture/caller.
    if (parsed > 1 && parsed <= 100) parsed /= 100;
    return parsed >= 0 && parsed <= 1 ? parsed : null;
  }

  function firstNumber(stat, fields, parser = finiteNumber) {
    if (!stat) return null;
    for (const field of fields) {
      const value = parser(stat[field]);
      if (value != null) return value;
    }
    return null;
  }

  function compactType(value) {
    return String(value || '').toLowerCase().replace(/[^a-z]/g, '');
  }

  function statForType(data, wantedType) {
    if (!data || !Array.isArray(data.stats)) return null;
    const wanted = compactType(wantedType);
    const group = data.stats.find((item) => {
      const type = item && item.type || {};
      return [type.displayName, type.name, type.code]
        .some((candidate) => compactType(candidate) === wanted);
    });
    if (!group || !Array.isArray(group.splits)) return null;
    const split = group.splits.find((item) => item && item.stat);
    return split ? split.stat : null;
  }

  function displayRate(value) {
    return value == null ? '—' : value.toFixed(3).replace(/^0(?=\.)/, '');
  }

  function displayMetric(value, decimals = 1) {
    return value == null ? '—' : Number(value).toFixed(decimals);
  }

  function baseProfile(role) {
    return {
      role,
      xBA: '—',
      avg: '—',
      xbaRate: null,
      avgRate: null,
      sample: 0,
      exitVelo: '—',
      launchAngle: '—',
      ops: '—',
    };
  }

  function profileFromPlainObject(input, role) {
    const profile = baseProfile(role);
    if (!input) return profile;

    const xba = rate(input.xbaRate != null ? input.xbaRate :
      (input.xBA != null ? input.xBA : input.estimatedBaUsingSpeedangle));
    const avg = rate(input.avgRate != null ? input.avgRate : input.avg);
    const sample = firstNumber(input, role === 'pitcher'
      ? ['sample', 'atBats', 'battersFaced']
      : ['sample', 'atBats', 'plateAppearances']);

    profile.xbaRate = xba;
    profile.avgRate = avg;
    profile.xBA = displayRate(xba);
    profile.avg = displayRate(avg);
    profile.sample = Math.max(0, sample || 0);
    profile.exitVelo = input.exitVelo == null ? '—' : String(input.exitVelo);
    profile.launchAngle = input.launchAngle == null ? '—' : String(input.launchAngle);
    profile.ops = input.ops == null ? '—' : String(input.ops);
    return profile;
  }

  function parseBatterStats(statsData) {
    if (statsData && statsData.role === 'batter') return statsData;
    if (!statsData || !Array.isArray(statsData.stats)) return profileFromPlainObject(statsData, 'batter');

    const profile = baseProfile('batter');
    const expected = statForType(statsData, 'expectedStatistics');
    const statcast = statForType(statsData, 'statcast');
    const season = statForType(statsData, 'season');

    // StatsAPI has used both avg and estimatedBaUsingSpeedangle for this value.
    const expectedXba = firstNumber(expected,
      ['estimatedBaUsingSpeedangle', 'estimatedBa', 'xBA', 'xba', 'avg'], rate);
    const xba = expectedXba != null ? expectedXba :
      firstNumber(statcast, ['estimatedBaUsingSpeedangle', 'estimatedBa', 'xBA', 'xba'], rate);
    const avg = firstNumber(season, ['avg', 'battingAverage'], rate);
    const sample = firstNumber(season, ['atBats', 'plateAppearances']);
    const exitVelo = firstNumber(statcast, ['launchSpeed', 'avgExitVelocity']);
    const launchAngle = firstNumber(statcast, ['launchAngle', 'avgLaunchAngle']);

    profile.xbaRate = xba;
    profile.avgRate = avg;
    profile.xBA = displayRate(xba);
    profile.avg = displayRate(avg);
    profile.sample = Math.max(0, sample || 0);
    profile.exitVelo = displayMetric(exitVelo);
    profile.launchAngle = displayMetric(launchAngle);
    profile.ops = season && season.ops != null ? String(season.ops) : '—';
    return profile;
  }

  function parsePitcherStats(statsData) {
    if (statsData && statsData.role === 'pitcher') return statsData;
    if (!statsData || !Array.isArray(statsData.stats)) return profileFromPlainObject(statsData, 'pitcher');

    const profile = baseProfile('pitcher');
    const expected = statForType(statsData, 'expectedStatistics');
    const season = statForType(statsData, 'season');

    // For pitchers these fields represent the rate allowed to opposing batters.
    const xba = firstNumber(expected,
      ['estimatedBaAgainst', 'estimatedBaUsingSpeedangle', 'estimatedBa', 'xBA', 'xba', 'avg'], rate);
    let avg = firstNumber(season,
      ['opponentBattingAverage', 'avgAgainst', 'baAgainst', 'avg'], rate);

    const hits = firstNumber(season, ['hits']);
    const atBats = firstNumber(season, ['atBats']);
    // Use hits / AB if the endpoint omits an explicit opponent batting average.
    if (avg == null && hits != null && atBats > 0) avg = hits / atBats;

    const sample = atBats || firstNumber(season, ['battersFaced']);
    profile.xbaRate = xba;
    profile.avgRate = avg;
    profile.xBA = displayRate(xba);
    profile.avg = displayRate(avg);
    profile.sample = Math.max(0, sample || 0);
    profile.ops = season && season.ops != null ? String(season.ops) : '—';
    return profile;
  }

  // Kept as an alias for callers from the original Props tab implementation.
  function parseStatcast(statsData) {
    return parseBatterStats(statsData);
  }

  /* --------------------------------------------------------------- model */

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function logit(value) {
    const safe = clamp(value, 0.001, 0.999);
    return Math.log(safe / (1 - safe));
  }

  function logistic(value) {
    return 1 / (1 + Math.exp(-value));
  }

  function buildSignal(profileInput, role) {
    const profile = role === 'pitcher'
      ? parsePitcherStats(profileInput)
      : parseBatterStats(profileInput);
    const xba = rate(profile.xbaRate != null ? profile.xbaRate : profile.xBA);
    const avg = rate(profile.avgRate != null ? profile.avgRate : profile.avg);

    let rawRate = null;
    let source = 'League baseline';
    if (xba != null && avg != null) {
      // Expected BA gets the larger share because it is less outcome-noisy.
      rawRate = (0.65 * xba) + (0.35 * avg);
      source = role === 'pitcher' ? 'xBA allowed + opp. AVG' : 'xBA + AVG';
    } else if (xba != null) {
      rawRate = xba;
      source = role === 'pitcher' ? 'xBA allowed' : 'xBA';
    } else if (avg != null) {
      rawRate = avg;
      source = role === 'pitcher' ? 'Opponent AVG' : 'AVG';
    }

    if (rawRate == null) {
      return {
        profile,
        available: false,
        rawRate: LEAGUE_HIT_RATE,
        rate: LEAGUE_HIT_RATE,
        source,
        sample: 0,
        reliability: 0,
      };
    }

    const observedSample = Math.max(0, finiteNumber(profile.sample) || 0);
    // Some expected-stat feeds do not include AB. Retain a modest signal rather
    // than treating a valid xBA as a full-season sample.
    const fallbackSample = role === 'pitcher' ? 80 : 40;
    const effectiveSample = observedSample || fallbackSample;
    const prior = role === 'pitcher' ? PITCHER_REGRESSION_AB : BATTER_REGRESSION_AB;
    const reliability = effectiveSample / (effectiveSample + prior);
    const shrunkRate = LEAGUE_HIT_RATE + reliability * (rawRate - LEAGUE_HIT_RATE);

    return {
      profile,
      available: true,
      rawRate,
      rate: clamp(shrunkRate, MIN_HIT_PROBABILITY, MAX_HIT_PROBABILITY),
      source,
      sample: observedSample,
      reliability,
    };
  }

  function platoonAdjustment(batterHand, pitcherHand) {
    const batter = String(batterHand || '').toUpperCase();
    const pitcher = String(pitcherHand || '').toUpperCase();
    if (!batter || !pitcher || !['L', 'R', 'S'].includes(batter) || !['L', 'R'].includes(pitcher)) {
      return { value: 0, label: 'No handedness adjustment' };
    }
    if (batter === 'S') {
      return { value: 0.009, label: 'Switch-hitter platoon edge' };
    }
    if (batter !== pitcher) {
      return { value: 0.009, label: 'Opposite-handed platoon edge' };
    }
    return { value: -0.006, label: 'Same-handed matchup' };
  }

  /**
   * Estimate expected remaining plate appearances based on inning, score, batting order, outs, and game status.
   */
  function getExpectedRemainingPAs(gameContext) {
    if (!gameContext) return 1.0;

    const inning = Math.max(1, parseInt(gameContext.inning) || 1);
    const isHomeBatting = !!gameContext.isHomeBatting;
    const scoreAway = parseInt(gameContext.scoreAway) || 0;
    const scoreHome = parseInt(gameContext.scoreHome) || 0;
    const outs = Math.min(2, Math.max(0, parseInt(gameContext.outs) || 0));
    const battingOrderPos = Math.min(9, Math.max(1, parseInt(gameContext.battingOrderPos) || 5));
    const gameState = String(gameContext.gameState || '').toLowerCase();

    if (gameState === 'final' || gameState === 'completed' || gameState === 'game over') {
      return 0.0;
    }

    // Expected remaining team plate appearances in current inning:
    // 0 outs: ~4.0 more PAs
    // 1 out: ~2.7 more PAs
    // 2 outs: ~1.3 more PAs
    let currentInningRemainingTeamPAs = 4.0 - (outs * 1.35);
    if (currentInningRemainingTeamPAs < 1.0) currentInningRemainingTeamPAs = 1.0;

    // Remaining innings of play (standard is 9)
    const isHomeLeading = scoreHome > scoreAway;
    const scoreDiff = Math.abs(scoreHome - scoreAway);

    let expectedFutureTeamPAs = 0;
    for (let i = inning + 1; i <= 9; i++) {
      let inningWeight = 1.0;
      if (i === 9) {
        if (isHomeBatting) {
          // If Home is already leading in late innings, they might not need to bat in bottom of 9th
          if (isHomeLeading && scoreDiff >= 3) {
            inningWeight = 0.1;
          } else if (isHomeLeading && scoreDiff >= 1) {
            inningWeight = 0.3;
          } else if (scoreDiff === 0) {
            inningWeight = 0.5;
          } else {
            inningWeight = 0.9;
          }
        }
      }
      expectedFutureTeamPAs += 4.2 * inningWeight;
    }

    const totalExpectedTeamPAs = 1.0 + (currentInningRemainingTeamPAs - 1.0) + expectedFutureTeamPAs;
    const expectedAdditionalPAs = (totalExpectedTeamPAs - 1.0) / 9.0;
    const orderAdjustment = (5.0 - battingOrderPos) * 0.04;
    const rawRemainingPAs = 1.0 + expectedAdditionalPAs + orderAdjustment;

    return Math.max(1.0, rawRemainingPAs);
  }

  /**
   * Predict the chance that a batter records a hit in the full plate appearance,
   * adjusted by remaining plate appearances and game flow state.
   *
   * Two signals enter independently: the batter's hit-production signal and
   * the pitcher's hit-allowed signal. When both are available their regressed
   * logits are blended evenly; if only one is available, that side is used with
   * an explicit fallback label. This also accepts the previous three-argument
   * signature modelHitProbability(batterStats, batterHand, pitcherHand).
   */
  function modelHitProbability(batterStats, pitcherStats, batterHand, pitcherHand, gameContext = null) {
    // Backward compatibility with the one-sided model API.
    if (typeof pitcherStats === 'string') {
      pitcherHand = batterHand;
      batterHand = pitcherStats;
      pitcherStats = null;
    }

    const batter = buildSignal(batterStats, 'batter');
    const pitcher = buildSignal(pitcherStats, 'pitcher');
    const activeSignals = [batter, pitcher].filter((signal) => signal.available);

    let baseLogit = logit(LEAGUE_HIT_RATE);
    if (activeSignals.length) {
      baseLogit = activeSignals.reduce((sum, signal) => sum + logit(signal.rate), 0) /
        activeSignals.length;
    }

    const platoon = platoonAdjustment(batterHand, pitcherHand);
    const rawProbability = clamp(
      logistic(baseLogit) + platoon.value,
      MIN_HIT_PROBABILITY,
      MAX_HIT_PROBABILITY,
    );

    // Take into account remaining at bats and game flow state
    const remainingPAs = getExpectedRemainingPAs(gameContext);
    
    // If remainingPAs is 0 (e.g. game is over), the probability of a hit from this point is 0
    let probability = rawProbability;
    if (remainingPAs === 0) {
      probability = 0.0;
    } else if (remainingPAs > 1.0) {
      // Calculate the probability of getting at least one hit in the remaining plate appearances:
      // P(at least 1 hit) = 1 - (1 - rawProbability)^remainingPAs
      probability = 1.0 - Math.pow(1.0 - rawProbability, remainingPAs);
    }
    
    // Ensure final probability is clamped within reasonable limits (unless it's 0 because game is over)
    if (remainingPAs > 0) {
      probability = clamp(probability, MIN_HIT_PROBABILITY, 0.95);
    }

    let coverage = 'baseline';
    if (batter.available && pitcher.available) coverage = 'two-sided';
    else if (batter.available) coverage = 'batter-only';
    else if (pitcher.available) coverage = 'pitcher-only';

    let coverageLabel = {
      'two-sided': 'Batter + pitcher season inputs',
      'batter-only': 'Batter input; pitcher baseline fallback',
      'pitcher-only': 'Pitcher input; batter baseline fallback',
      baseline: 'League baseline fallback',
    }[coverage];

    if (gameContext && remainingPAs > 0) {
      const paDesc = remainingPAs.toFixed(1);
      coverageLabel += ` · Game flow adjust (est. ${paDesc} PAs remaining)`;
    }

    return {
      probability,
      prob: (probability * 100).toFixed(1),
      noHitProbability: 1 - probability,
      noHitProb: ((1 - probability) * 100).toFixed(1),
      rawProbability,
      rawProb: (rawProbability * 100).toFixed(1),
      remainingPAs,
      batter,
      pitcher,
      platoon,
      coverage,
      coverageLabel,
      // Compatibility fields used by the previous PBP chip implementation.
      baseBa: batter.rate.toFixed(3),
      platoonAdv: platoon.value.toFixed(3),
    };
  }

  function signalDescription(signal, role) {
    if (!signal || !signal.available) {
      return role === 'pitcher' ? 'Pitcher: league baseline' : 'Batter: league baseline';
    }
    const roleLabel = role === 'pitcher' ? 'Pitcher allowed' : 'Batter';
    const sample = signal.sample ? ` · ${signal.sample} AB` : '';
    return `${roleLabel} ${displayRate(signal.rate)} (${signal.source}${sample})`;
  }

  function describeHitModel(model) {
    const platoonPoints = Math.abs(model.platoon.value * 100).toFixed(1);
    const direction = model.platoon.value > 0 ? '+' : model.platoon.value < 0 ? '−' : '';
    const platoon = model.platoon.value
      ? ` ${model.platoon.label} ${direction}${platoonPoints} pts.`
      : '';
    return `${model.coverageLabel}. ${signalDescription(model.batter, 'batter')}; ` +
      `${signalDescription(model.pitcher, 'pitcher')}.${platoon}`;
  }

  /* --------------------------------------------------------- pitcher arsenal */

  function getPitcherArsenal(allPlays, pitcherId) {
    const arsenal = {};
    let total = 0;

    (allPlays || []).forEach((play) => {
      const pId = play.matchup && play.matchup.pitcher && play.matchup.pitcher.id;
      if (pId !== pitcherId) return;

      (play.playEvents || []).forEach((event) => {
        if (!event.isPitch || !event.details || !event.details.type || !event.details.type.code) return;
        const type = event.details.type;
        const code = type.code;
        if (!arsenal[code]) {
          arsenal[code] = { desc: type.description, count: 0, veloSum: 0, veloCount: 0 };
        }
        arsenal[code].count += 1;
        total += 1;

        const velo = event.pitchData && finiteNumber(event.pitchData.startSpeed);
        if (velo != null) {
          arsenal[code].veloSum += velo;
          arsenal[code].veloCount += 1;
        }
      });
    });

    const mix = Object.keys(arsenal).map((code) => {
      const entry = arsenal[code];
      return {
        code,
        desc: entry.desc,
        pct: total ? (entry.count / total) * 100 : 0,
        avgVelo: entry.veloCount ? (entry.veloSum / entry.veloCount).toFixed(1) : '—',
      };
    });
    mix.sort((a, b) => b.pct - a.pct);
    return { totalPitches: total, mix };
  }

  /* --------------------------------------------------------------- rendering */

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }

  function seasonFor(gameData) {
    const season = gameData && gameData.game && gameData.game.season;
    return normalizedSeason(season) || null;
  }

  function playerWithGameData(player, gameData) {
    if (!player) return null;
    const details = gameData && gameData.players && gameData.players[`ID${player.id}`];
    return Object.assign({}, details || {}, player);
  }

  function playerName(player) {
    return player && (player.fullName || player.name) || '—';
  }

  function playerHand(player, fallback) {
    return (fallback && fallback.code) || (player && player.batSide && player.batSide.code) || '';
  }

  function appendHeadshot(parent, player) {
    if (!player || !player.id || typeof MLB === 'undefined') return;
    const image = node('img', 'b-headshot');
    image.alt = '';
    image.loading = 'lazy';
    image.src = MLB.headshotUrl(player.id);
    image.onerror = () => image.remove();
    parent.appendChild(image);
  }

  function appendForecastBar(parent, model, compact = false) {
    const forecast = node('div', `hit-forecast ${compact ? 'hit-forecast-compact' : ''}`);
    const label = node('div', 'forecast-label-row');
    label.appendChild(node('span', 'prob-label', compact ? 'Two-sided hit forecast' : 'Projected hit probability'));
    label.appendChild(node('strong', 'prob-value', `${model.prob}%`));
    forecast.appendChild(label);

    const track = node('div', 'prob-bar-container');
    const bar = node('div', 'prob-bar');
    bar.style.width = `${model.prob}%`;
    track.appendChild(bar);
    forecast.appendChild(track);

    const subline = node('div', 'forecast-subline', `${model.coverageLabel} · No hit ${model.noHitProb}%`);
    forecast.appendChild(subline);
    forecast.title = describeHitModel(model);
    parent.appendChild(forecast);
  }

  function appendSignal(parent, className, heading, signal, role) {
    const side = node('div', `forecast-side ${className}`);
    side.appendChild(node('span', 'forecast-side-label', heading));
    side.appendChild(node('strong', 'forecast-side-value', signal.available ? displayRate(signal.rate) : '—'));
    side.appendChild(node('span', 'forecast-side-meta', signalDescription(signal, role)));
    parent.appendChild(side);
  }

  function forecastSection(batter, pitcher, model) {
    const section = node('section', `props-section matchup-forecast-section model-${model.coverage}`);
    section.appendChild(node('h3', 'props-heading', 'Two-Sided Hit Forecast'));
    section.appendChild(node('div', 'forecast-matchup', `${playerName(batter)} vs ${playerName(pitcher)}`));

    const scoreLine = node('div', 'forecast-scoreline');
    const hitBlock = node('div', 'forecast-result');
    hitBlock.appendChild(node('span', 'forecast-result-label', 'Hit'));
    hitBlock.appendChild(node('strong', 'forecast-result-value', `${model.prob}%`));
    scoreLine.appendChild(hitBlock);
    const noHitBlock = node('div', 'forecast-result forecast-no-hit');
    noHitBlock.appendChild(node('span', 'forecast-result-label', 'No hit'));
    noHitBlock.appendChild(node('strong', 'forecast-result-value', `${model.noHitProb}%`));
    scoreLine.appendChild(noHitBlock);
    section.appendChild(scoreLine);

    const track = node('div', 'forecast-main-track');
    const bar = node('div', 'forecast-main-bar');
    bar.style.width = `${model.prob}%`;
    track.appendChild(bar);
    section.appendChild(track);

    const sides = node('div', 'forecast-sides');
    appendSignal(sides, 'forecast-batter', 'Batter signal', model.batter, 'batter');
    appendSignal(sides, 'forecast-pitcher', 'Pitcher signal', model.pitcher, 'pitcher');
    section.appendChild(sides);

    const adjustments = node('div', 'forecast-adjustments');
    const platoonPoints = model.platoon.value === 0
      ? '0.0'
      : `${model.platoon.value > 0 ? '+' : '−'}${Math.abs(model.platoon.value * 100).toFixed(1)}`;
    adjustments.appendChild(node('span', 'forecast-adjustment-label', 'Handedness'));
    adjustments.appendChild(node('span', 'forecast-adjustment-value',
      `${model.platoon.label} · ${platoonPoints} percentage points`));
    section.appendChild(adjustments);

    section.appendChild(node('p', 'forecast-method-note',
      'Season rates are regressed toward the league hit rate before the batter and pitcher signals are blended. This is a pre-plate-appearance estimate, not a betting line.'));
    section.title = describeHitModel(model);
    return section;
  }

  function pitcherSection(pitcher, pitcherStats, arsenal) {
    const section = node('section', 'props-section pitcher-section');
    section.appendChild(node('h3', 'props-heading', `Current Pitcher: ${playerName(pitcher)}`));
    const rateText = pitcherStats.xBA !== '—' || pitcherStats.avg !== '—'
      ? `Hit-allowed inputs: xBA ${pitcherStats.xBA} · Opp. AVG ${pitcherStats.avg}`
      : 'Pitcher season hit-allowed data is unavailable.';
    section.appendChild(node('p', 'mix-meta pitcher-input-line', rateText));

    if (!arsenal.totalPitches) {
      section.appendChild(node('p', 'mix-meta', 'No pitches thrown yet today.'));
      return section;
    }

    section.appendChild(node('div', 'mix-meta', `${arsenal.totalPitches} pitches thrown today`));
    const mix = node('div', 'mix-grid');
    arsenal.mix.forEach((pitch) => {
      const item = node('div', 'mix-item');
      const code = node('span', 'mix-code', pitch.code);
      code.title = pitch.desc || pitch.code;
      item.appendChild(code);
      item.appendChild(node('span', 'mix-pct', `${pitch.pct.toFixed(1)}%`));
      item.appendChild(node('span', 'mix-velo', pitch.avgVelo === '—' ? '—' : `${pitch.avgVelo} mph`));
      mix.appendChild(item);
    });
    section.appendChild(mix);
    return section;
  }

  function batterCard(player, label, batterStats, pitcherStats, batterHand, pitcherHand, gameContext = null) {
    const model = modelHitProbability(batterStats, pitcherStats, batterHand, pitcherHand, gameContext);
    const card = node('article', `batter-prop-card ${label === 'Current Batter' ? 'active-batter' : ''}`);

    const header = node('div', 'b-header');
    appendHeadshot(header, player);
    const text = node('div', 'b-header-text');
    text.appendChild(node('div', 'b-label', label));
    text.appendChild(node('div', 'b-name', playerName(player)));
    header.appendChild(text);
    card.appendChild(header);

    const stats = node('div', 'b-stats');
    const stat = (statLabel, value) => {
      const column = node('div', 'stat-col');
      column.appendChild(node('span', 'stat-lbl', statLabel));
      column.appendChild(node('strong', 'stat-val', value));
      stats.appendChild(column);
    };
    stat('xBA', batterStats.xBA);
    stat('AVG', batterStats.avg);
    stat('Pitcher signal', pitcherStats.xBA !== '—' ? pitcherStats.xBA : pitcherStats.avg);
    card.appendChild(stats);

    appendForecastBar(card, model, true);
    return card;
  }

  function render(container, payload) {
    if (!container) return;
    const live = payload && (payload.liveData || payload) || {};
    const gameData = payload && payload.gameData || {};
    const currentPlay = live.plays && live.plays.currentPlay || {};
    const matchup = currentPlay.matchup || {};
    const offense = live.linescore && live.linescore.offense || {};
    const defense = live.linescore && live.linescore.defense || {};

    const batter = playerWithGameData(matchup.batter || offense.batter, gameData);
    const pitcher = playerWithGameData(matchup.pitcher || defense.pitcher, gameData);
    const onDeck = playerWithGameData(offense.onDeck, gameData);
    const inHole = playerWithGameData(offense.inTheHole || offense.inHole, gameData);
    // Invalidate an earlier async render even when this feed has no active matchup.
    const version = ++renderVersion;

    if (!batter || !pitcher) {
      container.replaceChildren(node('div', 'props-empty', 'No active matchup available.'));
      return;
    }

    container.replaceChildren(node('div', 'props-loading', 'Loading two-sided matchup data…'));

    const season = seasonFor(gameData);
    const batterHand = playerHand(batter, matchup.batSide);
    const pitcherHand = (matchup.pitchHand && matchup.pitchHand.code) || (pitcher.pitchHand && pitcher.pitchHand.code) || '';
    const batters = [
      { player: batter, label: 'Current Batter', hand: batterHand },
      { player: onDeck, label: 'On Deck', hand: playerHand(onDeck) },
      { player: inHole, label: 'In the Hole', hand: playerHand(inHole) },
    ].filter((entry) => entry.player && entry.player.id);

    Promise.all([
      fetchPlayerStats(pitcher.id, 'pitching', season),
      ...batters.map((entry) => fetchPlayerStats(entry.player.id, 'hitting', season)),
    ]).then((data) => {
      if (version !== renderVersion || !container.isConnected) return;

      const pitcherStats = parsePitcherStats(data[0]);
      const batterData = data.slice(1);
      const currentStats = parseBatterStats(batterData[0]);

      const ls = live.linescore || {};
      const box = live.boxscore || {};
      const halfInning = ls.inningHalf ? ls.inningHalf.toLowerCase() : 'top';
      const isHomeBatting = halfInning === 'bottom';
      const battingSide = isHomeBatting ? 'home' : 'away';
      const scoreAway = ls.teams && ls.teams.away && ls.teams.away.runs;
      const scoreHome = ls.teams && ls.teams.home && ls.teams.home.runs;

      function getBattingOrderPosition(boxscore, side, playerId) {
        if (!boxscore || !boxscore.teams || !boxscore.teams[side]) return null;
        const order = boxscore.teams[side].battingOrder || [];
        const idx = order.indexOf(playerId);
        return idx >= 0 ? idx + 1 : null;
      }

      const currentOrderPos = getBattingOrderPosition(box, battingSide, batter.id);
      const gameContext = {
        inning: ls.currentInning,
        halfInning,
        battingOrderPos: currentOrderPos,
        isHomeBatting,
        scoreAway,
        scoreHome,
        outs: ls.outs,
        gameState: gameData.status && gameData.status.abstractGameState,
      };

      const currentModel = modelHitProbability(currentStats, pitcherStats, batterHand, pitcherHand, gameContext);
      const arsenal = getPitcherArsenal(live.plays && live.plays.allPlays, pitcher.id);

      container.replaceChildren();
      container.appendChild(forecastSection(batter, pitcher, currentModel));
      container.appendChild(pitcherSection(pitcher, pitcherStats, arsenal));

      const batterSection = node('section', 'props-section batters-section');
      batterSection.appendChild(node('h3', 'props-heading', `Upcoming Batters vs ${playerName(pitcher)}`));
      const grid = node('div', 'batters-grid');
      batters.forEach((entry, index) => {
        const orderPos = getBattingOrderPosition(box, battingSide, entry.player.id);
        const batterContext = Object.assign({}, gameContext, { battingOrderPos: orderPos });
        grid.appendChild(batterCard(
          entry.player,
          entry.label,
          parseBatterStats(batterData[index]),
          pitcherStats,
          entry.hand,
          pitcherHand,
          batterContext,
        ));
      });
      batterSection.appendChild(grid);
      container.appendChild(batterSection);
    }).catch((err) => {
      // fetchPlayerStats normally absorbs failures, but retain a graceful UI if
      // an unexpected rendering error escapes.
      console.error('Props: unable to render matchup forecast', err);
      if (version === renderVersion && container.isConnected) {
        container.replaceChildren(node('div', 'props-empty', 'Matchup forecast is temporarily unavailable.'));
      }
    });
  }

  return {
    render,
    fetchPlayerStats,
    getCachedPlayerStats,
    getHitPrediction,
    getPitcherArsenal,
    parseStatcast,
    parseBatterStats,
    parsePitcherStats,
    modelHitProbability,
    describeHitModel,
  };
})();
