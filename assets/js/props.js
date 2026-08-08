/* ============================================================================
 * props.js — matchup data, a discriminative two-sided hit forecast, and the
 * Props & Matchup tab.
 *
 * MODEL v2 — why it exists:
 * The original model blended season-level batter/pitcher rates with a flat
 * handedness bump and surfaced a game-flow-inflated number, so every matchup
 * landed in a narrow band (typically 20-31%) and the forecast couldn't
 * distinguish a great spot from a terrible one. v2 attacks discrimination on
 * three axes:
 *
 *   1. LIGHT REGRESSION + WIDER INPUTS. Platoon splits (batter vs pitcher-hand,
 *      pitcher vs batter-hand) and recent form (gameLog) have far more spread
 *      than season aggregates, so they carry real separating power. v2 keeps
 *      the regression-to-the-mean light (35-70 AB priors) so a full-season
 *      signal can move the forecast 10-14 points off the league baseline.
 *   2. MULTIPLICATIVE COMBINATION. Evidence compounds in log-odds space
 *      (generalized log5, Bill James's odds-ratio matchup method) instead of
 *      averaging logits, so extreme signals push the output toward the
 *      extremes instead of canceling toward the mean. Total evidence is
 *      capped at ±1.9 logits from the league prior — wide enough to span
 *      ~16-50% on the level evidence alone, narrow enough to stay defensible.
 *   3. IN-GAME STATE. The live count (anchored to published hit-rate-by-count
 *      research), the times-through-the-order effect (~+8 wOBA pts/pass; MLB's
 *      glossary shows .243/.255/.265 AVG by pass), and meaningful (still
 *      bounded) head-to-head history adjust the baseline per-plate-appearance
 *      rate.
 *
 * Realistic output: the per-PA headline spans ~13% (overwhelmed call-up vs
 * ace) to ~50% (elite hitter on fire vs weak pitcher with a hitter's count).
 * The secondary "chance of at least one hit in remaining PAs" projection
 * naturally lands in the 50-95% range, which is the number most fans read on
 * a broadcast graphic and which the user can use to confirm a stacked edge.
 * ==========================================================================*/
'use strict';

window.Props = (() => {
  const STATS_CACHE = new Map();

  /* -------------------------------------------------------------- constants */

  // A neutral MLB hit rate used as the prior / missing-data fallback.
  const LEAGUE_HIT_RATE = 0.245;
  // Regression priors (in at-bats): a signal's reliability is sample/(sample+prior).
  // These are intentionally light so a full-season signal can move the
  // forecast off the league baseline by ~10-14 points (instead of 3-5), and
  // a stacked edge can land in the 18-50% range. The cap (below) is the real
  // safety valve against extreme outputs.
  const BATTER_REGRESSION_AB = 35;
  const PITCHER_REGRESSION_AB = 70;
  const SPLIT_BATTER_PRIOR_AB = 90;
  const SPLIT_PITCHER_PRIOR_BF = 110;
  const FORM_PRIOR_AB = 40;
  const FORM_WEIGHT_CAP = 0.90;   // hot/cold streaks are real and worth hearing
  const FORM_WINDOW_GAMES = 8;
  const H2H_PRIOR_AB = 15;
  const H2H_WEIGHT_CAP = 0.55;    // career h2h is a meaningful but still bounded signal
  // Total evidence swing is capped so stacked edges can't produce absurd outputs.
  // ±1.9 logits from a 0.245 league rate spans roughly 16%-50% on the level evidence
  // alone — wide enough to discriminate clearly, narrow enough to stay defensible.
  const MAX_TOTAL_DELTA_LOGIT = 1.9;
  // Times-through-the-order: ~+8 wOBA pts per pass ≈ +0.75 pts of AVG per pass,
  // credited from the 2nd PA vs the same pitcher today, capped at 2 passes.
  const TTO_BUMP_PER_PASS = 0.0075;
  const TTO_MAX_PASSES = 2;

  // Per-PA clamps. The per-PA headline can legitimately reach ~50% on an
  // extreme hitter's count, and a truly dominated matchup can dip into the
  // mid-teens. The display bar is normalized to this band.
  const MIN_PA_PROBABILITY = 0.13;   // per-plate-appearance clamps (pre-count)
  const MAX_PA_PROBABILITY = 0.62;
  const MIN_LIVE_PROBABILITY = 0.10; // post-count clamps
  const MAX_LIVE_PROBABILITY = 0.78;

  /* Live in-at-bat count factors (odds multipliers vs a fresh 0-0 count).
   * Anchored to published research — see tools/count-model-derivation.mjs:
   * ahead .313 / even .285 / behind .218 (SABR), ~.16 AVG after 0-2, and the
   * FanGraphs wOBA-by-count shape with the walk value at 3-ball counts removed
   * (walks end a PA without a hit, and 3-0 pitches are auto-taken). */
  const COUNT_FACTORS = {
    '0-0': 1.00,
    '0-1': 0.93,
    '0-2': 0.74,
    '1-0': 1.07,
    '1-1': 1.00,
    '1-2': 0.77,
    '2-0': 1.15,
    '2-1': 1.08,
    '2-2': 0.80,
    '3-0': 1.12,
    '3-1': 1.16,
    '3-2': 0.92,
  };

  // Display tiers for the final per-PA probability — fans read "which kind of
  // matchup is this" faster than they read raw percentages. Thresholds are
  // tuned for the spread of the v2 model: typical matchups land in Neutral
  // (22-28%), with Elite reserved for the top of the realistic band and
  // Pitcher's edge for truly dominated at-bats.
  const TIERS = [
    { min: 0.32, key: 'elite', label: 'Elite matchup' },
    { min: 0.27, key: 'favorable', label: 'Favorable' },
    { min: 0.21, key: 'neutral', label: 'Neutral' },
    { min: 0.16, key: 'tough', label: 'Tough' },
    { min: -Infinity, key: 'dominated', label: "Pitcher's edge" },
  ];

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

  function h2hCacheKey(batterId, pitcherId, season) {
    return `h2h:${batterId}:${pitcherId}:${normalizedSeason(season) || 'career'}`;
  }

  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
  }

  /**
   * Fetch one player's season hitting or pitching bundle. One request returns
   * season aggregates, expected stats, Statcast quality, platoon splits
   * (statSplits, sitCodes vl/vr), and the full game log (recent form). Entries
   * cache the in-flight Promise as well as its resolved value so a timeline
   * with repeated batters does not make duplicate requests.
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
      stats: statGroup === 'pitching'
        ? 'expectedStatistics,season,statSplits,gameLog'
        : 'statcast,expectedStatistics,season,statSplits,gameLog',
      group: statGroup,
      // Platoon splits. For hitters: vs LHP / vs RHP. For pitchers: vs LHB / vs RHB.
      sitCodes: 'vl,vr',
    });
    if (seasonValue) params.set('season', seasonValue);

    const entry = { data: null, resolved: false, promise: null };
    entry.promise = fetchJSON(`https://statsapi.mlb.com/api/v1/people/${playerId}/stats?${params.toString()}`)
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

  /**
   * Career head-to-head line for one batter/pitcher pair. Kept out of the
   * main bundle because it needs both ids; used only for the live forecast,
   * never for the bulk timeline chips (one extra request per unique matchup).
   */
  function fetchHeadToHead(batterId, pitcherId, season = null) {
    if (!batterId || !pitcherId) return Promise.resolve(null);
    const key = h2hCacheKey(batterId, pitcherId, season);
    const cached = STATS_CACHE.get(key);
    if (cached) return cached.promise;

    const params = new URLSearchParams({
      stats: 'vsPlayer',
      group: 'hitting',
      opposingPlayerId: String(pitcherId),
    });
    const seasonValue = normalizedSeason(season);
    if (seasonValue) params.set('season', seasonValue);

    const entry = { data: null, resolved: false, promise: null };
    entry.promise = fetchJSON(`https://statsapi.mlb.com/api/v1/people/${batterId}/stats?${params.toString()}`)
      .catch((err) => {
        console.warn(`Props: failed to fetch head-to-head ${batterId} vs ${pitcherId}`, err);
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
    const [batterData, pitcherData, h2hData] = await Promise.all([
      fetchPlayerStats(batterId, 'hitting', season),
      fetchPlayerStats(pitcherId, 'pitching', season),
      fetchHeadToHead(batterId, pitcherId),   // career — one cached request per pair
    ]);
    const batterProfile = parseBatterStats(batterData);
    batterProfile.h2h = parseHeadToHead(h2hData);
    return modelHitProbability(
      batterProfile,
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

  function groupForType(data, wantedType) {
    if (!data || !Array.isArray(data.stats)) return null;
    const wanted = compactType(wantedType);
    const found = data.stats.find((item) => {
      const type = item && item.type || {};
      return [type.displayName, type.name, type.code]
        .some((candidate) => compactType(candidate) === wanted);
    });
    return found && Array.isArray(found.splits) ? found.splits : null;
  }

  function displayRate(value) {
    return value == null ? '—' : value.toFixed(3).replace(/^0(?=\.)/, '');
  }

  function displayMetric(value, decimals = 1) {
    return value == null ? '—' : Number(value).toFixed(decimals);
  }

  /** YYYY-MM-DD from an ISO datetime (or a date already in that shape). */
  function dayOf(value) {
    const text = String(value || '');
    const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }

  function emptySplit() {
    return { avg: null, atBats: 0 };
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
      // v2 additions:
      splits: { vl: emptySplit(), vr: emptySplit() },
      recentLog: [],     // [{ date: 'YYYY-MM-DD', hits, atBats }] chronological
      h2h: null,         // career head-to-head { avg, atBats } when fetched
    };
  }

  function normalizeSplits(input) {
    const splits = { vl: emptySplit(), vr: emptySplit() };
    if (!input) return splits;
    // API shape: array of entries with split.code — handled by parseSplitsFromApi.
    // Plain-object fixture shape: { vl: {avg, atBats}, vr: {...} } or
    // { vsLeft: {...}, vsRight: {...} }.
    const vl = input.vl || input.vsLeft;
    const vr = input.vr || input.vsRight;
    if (vl) splits.vl = { avg: rate(vl.avg != null ? vl.avg : vl.avgRate), atBats: finiteNumber(vl.atBats != null ? vl.atBats : vl.battersFaced) || 0 };
    if (vr) splits.vr = { avg: rate(vr.avg != null ? vr.avg : vr.avgRate), atBats: finiteNumber(vr.atBats != null ? vr.atBats : vr.battersFaced) || 0 };
    return splits;
  }

  function parseSplitsFromApi(data) {
    const splits = { vl: emptySplit(), vr: emptySplit() };
    const entries = groupForType(data, 'statSplits') || [];
    entries.forEach((entry) => {
      const code = entry && entry.split && String(entry.split.code || '').toLowerCase();
      if (code !== 'vl' && code !== 'vr' || !entry.stat) return;
      const hits = finiteNumber(entry.stat.hits);
      const atBats = finiteNumber(entry.stat.atBats);
      let avg = rate(entry.stat.avg);
      if (avg == null && hits != null && atBats > 0) avg = hits / atBats;
      splits[code] = { avg, atBats: atBats || 0 };
    });
    return splits;
  }

  function parseGameLog(data) {
    const entries = groupForType(data, 'gameLog') || [];
    return entries
      .map((entry) => ({
        date: dayOf(entry && entry.date),
        hits: finiteNumber(entry && entry.stat && entry.stat.hits),
        atBats: finiteNumber(entry && entry.stat && entry.stat.atBats),
      }))
      .filter((entry) => entry.date && entry.atBats != null)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** Career head-to-head (vsPlayerTotal preferred; fall back to summing seasons). */
  function parseHeadToHead(data) {
    if (!data || !Array.isArray(data.stats)) return null;
    const total = statForType(data, 'vsPlayerTotal');
    if (total) {
      const avg = rate(total.avg);
      const atBats = finiteNumber(total.atBats) || 0;
      if (avg != null && atBats > 0) return { avg, atBats };
    }
    const seasons = groupForType(data, 'vsPlayer') || [];
    let hits = 0;
    let atBats = 0;
    seasons.forEach((entry) => {
      const h = finiteNumber(entry && entry.stat && entry.stat.hits);
      const ab = finiteNumber(entry && entry.stat && entry.stat.atBats);
      if (h != null) hits += h;
      if (ab != null) atBats += ab;
    });
    return atBats > 0 ? { avg: hits / atBats, atBats } : null;
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
    profile.splits = normalizeSplits(input.splits);
    if (Array.isArray(input.recentLog)) profile.recentLog = input.recentLog;
    if (input.h2h) profile.h2h = { avg: rate(input.h2h.avg), atBats: finiteNumber(input.h2h.atBats) || 0 };
    // Fixture shortcut: a precomputed recent-form line. The epoch date keeps
    // the entry eligible under any game-date cutoff.
    if (input.recent) {
      profile.recentLog = [{
        date: '0000-01-01',
        hits: Math.round((rate(input.recent.avg) || 0) * (finiteNumber(input.recent.atBats) || 0) * 1000) / 1000,
        atBats: finiteNumber(input.recent.atBats) || 0,
      }];
    }
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
    profile.splits = parseSplitsFromApi(statsData);
    profile.recentLog = parseGameLog(statsData);
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
    profile.splits = parseSplitsFromApi(statsData);
    profile.recentLog = parseGameLog(statsData);
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

  function odds(value) {
    const safe = clamp(value, 0.001, 0.999);
    return safe / (1 - safe);
  }

  function tierFor(probability) {
    return TIERS.find((tier) => probability >= tier.min) || TIERS[TIERS.length - 1];
  }

  function shrink(observedRate, priorRate, sample, priorAB) {
    const reliability = clamp(sample / (sample + priorAB), 0, 1);
    return { rate: priorRate + reliability * (observedRate - priorRate), reliability };
  }

  /**
   * Season-level signal: blend xBA (less outcome-noise) with actual AVG, then
   * shrink toward the league rate by sample size.
   */
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
    const { rate: shrunkRate, reliability } = shrink(rawRate, LEAGUE_HIT_RATE, effectiveSample, prior);

    return {
      profile,
      available: true,
      rawRate,
      rate: clamp(shrunkRate, MIN_PA_PROBABILITY, MAX_PA_PROBABILITY),
      source,
      sample: observedSample,
      reliability,
    };
  }

  /**
   * Which platoon split applies to this matchup, for each side. For hitters,
   * vl/vr is keyed by the PITCHER's hand; for pitchers, by the BATTER's side
   * (switch hitters bat opposite the pitcher's hand).
   */
  function platoonCode(batterHand, pitcherHand, role) {
    const bh = String(batterHand || '').toUpperCase();
    const ph = String(pitcherHand || '').toUpperCase();
    if (role === 'pitcher') {
      const side = bh === 'S' ? (ph === 'L' ? 'R' : 'L') : bh;
      return side === 'L' ? 'vl' : side === 'R' ? 'vr' : null;
    }
    return ph === 'L' ? 'vl' : ph === 'R' ? 'vr' : null;
  }

  /**
   * Data-driven platoon signal: the split AVG (shrunk by split sample) minus
   * the player's own shrunk season rate, so only the *differential* enters —
   * the season rate is already fully counted in the level evidence.
   * Falls back to a small flat adjustment when no split data exists.
   */
  function platoonSignal(profile, seasonSignal, batterHand, pitcherHand, role) {
    const code = platoonCode(batterHand, pitcherHand, role);
    const split = code && profile && profile.splits ? profile.splits[code] : null;
    const priorAB = role === 'pitcher' ? SPLIT_PITCHER_PRIOR_BF : SPLIT_BATTER_PRIOR_AB;

    if (split && split.avg != null && split.atBats > 0) {
      const { rate: shrunkSplit, reliability } = shrink(split.avg, LEAGUE_HIT_RATE, split.atBats, priorAB);
      const handLabel = role === 'pitcher'
        ? (code === 'vl' ? 'vs LHB' : 'vs RHB')
        : (code === 'vl' ? 'vs LHP' : 'vs RHP');
      return {
        available: true,
        rate: shrunkSplit,
        rawAvg: split.avg,
        atBats: split.atBats,
        reliability,
        label: handLabel,
      };
    }

    // Legacy flat fallback so behavior without splits stays principled.
    const batter = String(batterHand || '').toUpperCase();
    const pitcher = String(pitcherHand || '').toUpperCase();
    let value = 0;
    let label = 'No handedness adjustment';
    if (!batter || !pitcher || !['L', 'R', 'S'].includes(batter) || !['L', 'R'].includes(pitcher)) {
      return { available: false, flat: { value, label } };
    }
    if (role === 'batter') {
      if (batter === 'S') { value = 0.009; label = 'Switch-hitter platoon edge'; }
      else if (batter !== pitcher) { value = 0.009; label = 'Opposite-handed platoon edge'; }
      else { value = -0.006; label = 'Same-handed matchup'; }
    }
    return { available: false, flat: { value, label } };
  }

  /**
   * Recent form: combined AVG over the player's last FORM_WINDOW_GAMES games
   * with at-bats (game-log dates must not exceed the game being modeled, so
   * forecasts for completed games stay historically correct).
   */
  function formSignal(profile, gameDate) {
    const log = Array.isArray(profile && profile.recentLog) ? profile.recentLog : [];
    if (!log.length) return { available: false };

    const cutoff = dayOf(gameDate);
    const eligible = cutoff ? log.filter((entry) => entry.date <= cutoff) : log.slice();
    let taken = 0;
    let hits = 0;
    let atBats = 0;
    for (let i = eligible.length - 1; i >= 0 && taken < FORM_WINDOW_GAMES; i -= 1) {
      const entry = eligible[i];
      if (!(entry.atBats > 0)) continue;
      hits += entry.hits || 0;
      atBats += entry.atBats;
      taken += 1;
    }
    if (!taken || atBats < 8) return { available: false };

    const raw = hits / atBats;
    const { rate: shrunkRate, reliability } = shrink(raw, LEAGUE_HIT_RATE, atBats, FORM_PRIOR_AB);
    return {
      available: true,
      rate: shrunkRate,
      rawAvg: raw,
      atBats,
      games: taken,
      reliability: reliability * FORM_WEIGHT_CAP,
      label: `Last ${taken} G`,
    };
  }

  /** Capped career head-to-head signal (batter vs this pitcher). */
  function historySignal(profile) {
    const h2h = profile && profile.h2h;
    if (!h2h || h2h.avg == null || !(h2h.atBats > 0)) return { available: false };
    const { rate: shrunkRate } = shrink(h2h.avg, LEAGUE_HIT_RATE, h2h.atBats, H2H_PRIOR_AB);
    const reliability = Math.min(h2h.atBats, 20) / 20 * H2H_WEIGHT_CAP;
    return {
      available: true,
      rate: shrunkRate,
      rawAvg: h2h.avg,
      atBats: h2h.atBats,
      reliability,
      label: `Career ${Math.round(h2h.rawAvg * h2h.atBats)}-for-${h2h.atBats}`,
    };
  }

  /** Live in-at-bat count adjustment (odds multiplier). */
  function countAdjustment(count) {
    if (!count) return { applied: false, factor: 1, label: null };
    const balls = clamp(parseInt(count.balls, 10) || 0, 0, 3);
    const strikes = clamp(parseInt(count.strikes, 10) || 0, 0, 2);
    if (balls === 0 && strikes === 0) return { applied: false, factor: 1, label: '0-0' };
    const key = `${balls}-${strikes}`;
    const factor = COUNT_FACTORS[key] != null ? COUNT_FACTORS[key] : 1;
    return { applied: factor !== 1, factor, label: key };
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
    for (let i = inning + 1; i <= 9; i += 1) {
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
   * Predict the chance that a batter records a hit in THIS plate appearance.
   *
   * Structure (all in log-odds space; generalized log5):
   *   level    = league prior, shifted by the batter's and pitcher's season
   *              rates, each weighed by its sample-based reliability;
   *   + platoon deltas from REAL splits (fallback: small flat adjustments);
   *   + recent-form delta (game-log window, capped weight);
   *   + capped head-to-head history delta;
   *   = per-PA matchup rate (clamped), then
   *   + times-through-the-order bump (probability space);
   *   × live count factor (odds space) for the in-at-bat headline number.
   *
   * This also accepts the previous three-argument signature
   * modelHitProbability(batterStats, batterHand, pitcherHand).
   */
  function modelHitProbability(batterStats, pitcherStats, batterHand, pitcherHand, gameContext = null) {
    // Backward compatibility with the one-sided model API.
    if (typeof pitcherStats === 'string') {
      pitcherHand = batterHand;
      batterHand = pitcherStats;
      pitcherStats = null;
    }

    const adjustments = [];
    const leagueLogit = logit(LEAGUE_HIT_RATE);

    /* --- 1. level: season evidence from both sides ------------------------ */
    const batter = buildSignal(batterStats, 'batter');
    const pitcher = buildSignal(pitcherStats, 'pitcher');

    let totalDelta = 0;
    if (batter.available) totalDelta += batter.reliability * (logit(batter.rate) - leagueLogit);
    if (pitcher.available) totalDelta += pitcher.reliability * (logit(pitcher.rate) - leagueLogit);
    totalDelta = clamp(totalDelta, -MAX_TOTAL_DELTA_LOGIT, MAX_TOTAL_DELTA_LOGIT);

    let levelProbability = logistic(leagueLogit + totalDelta);
    adjustments.push({
      id: 'level',
      label: 'Season matchup',
      points: levelProbability - LEAGUE_HIT_RATE,
    });

    /* --- 2. platoon: real splits when available, flat fallback otherwise -- */
    const batterSplit = platoonSignal(batter.profile, batter, batterHand, pitcherHand, 'batter');
    const pitcherSplit = platoonSignal(pitcher.profile, pitcher, batterHand, pitcherHand, 'pitcher');

    let platoonDeltaLogit = 0;
    const platoonLabels = [];
    if (batterSplit.available) {
      platoonDeltaLogit += batterSplit.reliability * 0.85 *
        (logit(batterSplit.rate) - logit(batter.available ? batter.rate : LEAGUE_HIT_RATE));
      platoonLabels.push(`Batter ${batterSplit.label} ${displayRate(batterSplit.rawAvg)} (${batterSplit.atBats} AB)`);
    }
    if (pitcherSplit.available) {
      platoonDeltaLogit += pitcherSplit.reliability * 0.85 *
        (logit(pitcherSplit.rate) - logit(pitcher.available ? pitcher.rate : LEAGUE_HIT_RATE));
      platoonLabels.push(`Pitcher ${pitcherSplit.label} ${displayRate(pitcherSplit.rawAvg)} (${pitcherSplit.atBats} BF AB)`);
    }

    const flatPlatoon = batterSplit.flat || { value: 0, label: '' };
    let postPlatoonProbability;
    let platoon;
    if (batterSplit.available || pitcherSplit.available) {
      postPlatoonProbability = logistic(logit(levelProbability) + platoonDeltaLogit);
      platoon = {
        value: postPlatoonProbability - levelProbability,
        label: platoonLabels.join(' · ') || 'Platoon splits',
        dataDriven: true,
      };
    } else {
      postPlatoonProbability = levelProbability + (flatPlatoon.value || 0);
      platoon = { value: flatPlatoon.value || 0, label: flatPlatoon.label, dataDriven: false };
    }
    adjustments.push({ id: 'platoon', label: platoon.label, points: platoon.value });

    /* --- 3. recent form (batter + pitcher, capped) ------------------------ */
    const gameDate = gameContext && gameContext.gameDate;
    const batterForm = formSignal(batter.profile, gameDate);
    const pitcherForm = formSignal(pitcher.profile, gameDate);

    let formDeltaLogit = 0;
    const formLabels = [];
    if (batterForm.available) {
      formDeltaLogit += batterForm.reliability *
        (logit(batterForm.rate) - logit(batter.available ? batter.rate : LEAGUE_HIT_RATE));
      formLabels.push(`Batter ${batterForm.label} ${displayRate(batterForm.rawAvg)}`);
    }
    if (pitcherForm.available) {
      formDeltaLogit += pitcherForm.reliability *
        (logit(pitcherForm.rate) - logit(pitcher.available ? pitcher.rate : LEAGUE_HIT_RATE));
      formLabels.push(`Pitcher ${pitcherForm.label} ${displayRate(pitcherForm.rawAvg)}`);
    }
    const postFormProbability = logistic(logit(postPlatoonProbability) + formDeltaLogit);
    adjustments.push({
      id: 'form',
      label: formLabels.join(' · ') || 'Recent form',
      points: postFormProbability - postPlatoonProbability,
    });

    /* --- 4. head-to-head history (career, capped tiny) -------------------- */
    const h2h = historySignal(batter.profile);
    let postHistoryProbability = postFormProbability;
    if (h2h.available) {
      const h2hDeltaLogit = h2h.reliability * (logit(h2h.rate) - leagueLogit);
      postHistoryProbability = logistic(logit(postHistoryProbability) + h2hDeltaLogit);
      adjustments.push({
        id: 'history',
        label: h2h.label,
        points: postHistoryProbability - postFormProbability,
      });
    }

    /* --- 5. times through the order (same-game familiarity) --------------- */
    const timesFaced = Math.max(0, parseInt(gameContext && gameContext.timesFacedToday, 10) || 0);
    const ttoPasses = Math.min(timesFaced, TTO_MAX_PASSES);
    const ttoPoints = ttoPasses * TTO_BUMP_PER_PASS;
    const postTtoProbability = postHistoryProbability + ttoPoints;
    if (ttoPasses > 0) {
      adjustments.push({
        id: 'familiarity',
        label: `${timesFaced + 1}${timesFaced === 0 ? 'st' : timesFaced === 1 ? 'nd' : 'rd'} look today`,
        points: ttoPoints,
      });
    }

    /* --- per-PA matchup rate (count-free) --------------------------------- */
    const paProbability = clamp(postTtoProbability, MIN_PA_PROBABILITY, MAX_PA_PROBABILITY);

    /* --- 6. live count (in-at-bat headline adjustment) -------------------- */
    const countInfo = countAdjustment(gameContext && gameContext.count);
    let liveProbability = paProbability;
    if (countInfo.applied) {
      const adjustedOdds = odds(paProbability) * countInfo.factor;
      liveProbability = adjustedOdds / (1 + adjustedOdds);
      adjustments.push({
        id: 'count',
        label: `Count ${countInfo.label}`,
        points: liveProbability - paProbability,
      });
    }
    const probability = clamp(liveProbability, MIN_LIVE_PROBABILITY, MAX_LIVE_PROBABILITY);

    /* --- secondary projection: at least one hit across remaining PAs ------ */
    const remainingPAs = getExpectedRemainingPAs(gameContext);
    let gameFlowProbability = paProbability;
    if (remainingPAs === 0) {
      gameFlowProbability = 0.0;
    } else if (remainingPAs > 1.0) {
      gameFlowProbability = 1.0 - Math.pow(1.0 - paProbability, remainingPAs);
    }
    if (remainingPAs > 0) {
      gameFlowProbability = clamp(gameFlowProbability, MIN_PA_PROBABILITY, 0.95);
    }

    let coverage = 'baseline';
    if (batter.available && pitcher.available) coverage = 'two-sided';
    else if (batter.available) coverage = 'batter-only';
    else if (pitcher.available) coverage = 'pitcher-only';

    const usedSignals = [];
    if (batter.available) usedSignals.push('batter season');
    if (pitcher.available) usedSignals.push('pitcher season');
    if (batterSplit.available || pitcherSplit.available) usedSignals.push('platoon splits');
    if (batterForm.available || pitcherForm.available) usedSignals.push('recent form');
    if (h2h.available) usedSignals.push('head-to-head');

    let coverageLabel = {
      'two-sided': 'Batter + pitcher season inputs',
      'batter-only': 'Batter input; pitcher baseline fallback',
      'pitcher-only': 'Pitcher input; batter baseline fallback',
      baseline: 'League baseline fallback',
    }[coverage];
    if (usedSignals.length > (coverage === 'two-sided' ? 2 : 1)) {
      coverageLabel = `Inputs: ${usedSignals.join(', ')}`;
    }
    if (gameContext && remainingPAs > 0) {
      coverageLabel += ` · est. ${remainingPAs.toFixed(1)} PAs left`;
    }

    const tier = tierFor(probability);

    return {
      // Headline: THIS plate appearance, count-adjusted when live.
      probability,
      prob: (probability * 100).toFixed(1),
      noHitProbability: 1 - probability,
      noHitProb: ((1 - probability) * 100).toFixed(1),
      tier,
      // Count-free per-PA matchup rate (used for upcoming batters + projections).
      paProbability,
      paProb: (paProbability * 100).toFixed(1),
      // Projection over the rest of the game (the old headline number).
      gameFlowProbability,
      gameFlowProb: (gameFlowProbability * 100).toFixed(1),
      remainingPAs,
      batter,
      pitcher,
      platoon,
      splits: { batter: batterSplit, pitcher: pitcherSplit },
      form: { batter: batterForm, pitcher: pitcherForm },
      h2h,
      countFactor: countInfo,
      timesFacedToday: timesFaced,
      adjustments: adjustments.filter((adj) => adj.points !== 0 || adj.id === 'level'),
      coverage,
      coverageLabel,
      // Compatibility fields used by the previous PBP chip implementation.
      rawProbability: paProbability,
      rawProb: (paProbability * 100).toFixed(1),
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

  function signedPoints(points) {
    const pts = points * 100;
    const sign = pts > 0.049 ? '+' : pts < -0.049 ? '−' : '';
    return `${sign}${Math.abs(pts).toFixed(1)}`;
  }

  function describeHitModel(model) {
    const parts = model.adjustments
      .filter((adj) => Math.abs(adj.points) >= 0.001)
      .map((adj) => `${adj.label} ${signedPoints(adj.points)} pts`);
    const driverText = parts.length ? ` Drivers — ${parts.join(' · ')}.` : '';
    return `${model.coverageLabel}. ${signalDescription(model.batter, 'batter')}; ` +
      `${signalDescription(model.pitcher, 'pitcher')}.${driverText}`;
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

  /** Completed PAs this game between a batter/pitcher pair (times faced so far). */
  function timesFacedToday(allPlays, batterId, pitcherId) {
    if (!batterId || !pitcherId) return 0;
    let count = 0;
    (allPlays || []).forEach((play) => {
      const matchup = play.matchup || {};
      const about = play.about || {};
      if (about.isComplete === false) return;
      if (matchup.batter && matchup.pitcher &&
          matchup.batter.id === batterId && matchup.pitcher.id === pitcherId) {
        count += 1;
      }
    });
    return count;
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

  function gameDateFor(gameData) {
    const dt = gameData && gameData.datetime;
    return dt && dt.dateTime ? dt.dateTime : null;
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

  function tierPill(model, compact = false) {
    const pill = node('span', `tier-pill tier-${model.tier.key}`,
      compact ? model.tier.label.replace(' matchup', '') : model.tier.label);
    pill.title = 'Matchup tier from the per-plate-appearance hit probability';
    return pill;
  }

  function appendForecastBar(parent, model, compact = false) {
    const forecast = node('div', `hit-forecast ${compact ? 'hit-forecast-compact' : ''}`);
    const label = node('div', 'forecast-label-row');
    label.appendChild(node('span', 'prob-label', compact ? 'Hit chance this PA' : 'Projected hit probability'));
    const valueWrap = node('span', 'prob-value-wrap');
    valueWrap.appendChild(node('strong', 'prob-value', `${model.prob}%`));
    valueWrap.appendChild(tierPill(model, true));
    label.appendChild(valueWrap);
    forecast.appendChild(label);

    const track = node('div', 'prob-bar-container scaled');
    // Normalize the bar across the realistic per-PA band so differences read clearly.
    const scaled = clamp((model.probability - MIN_PA_PROBABILITY) /
      (MAX_LIVE_PROBABILITY - MIN_PA_PROBABILITY), 0, 1);
    const bar = node('div', `prob-bar tier-fill-${model.tier.key}`);
    bar.style.width = `${(scaled * 100).toFixed(1)}%`;
    track.appendChild(bar);
    forecast.appendChild(track);

    const subline = node('div', 'forecast-subline',
      `${model.coverageLabel} · No hit ${model.noHitProb}%`);
    forecast.appendChild(subline);
    forecast.title = describeHitModel(model);
    parent.appendChild(forecast);
  }

  function appendSignal(parent, className, heading, signal, role, extra) {
    const side = node('div', `forecast-side ${className}`);
    side.appendChild(node('span', 'forecast-side-label', heading));
    side.appendChild(node('strong', 'forecast-side-value', signal.available ? displayRate(signal.rate) : '—'));
    const meta = [signalDescription(signal, role)];
    if (extra) meta.push(extra);
    side.appendChild(node('span', 'forecast-side-meta', meta.join(' · ')));
    parent.appendChild(side);
  }

  function adjustmentsRow(model) {
    const chips = node('div', 'adj-chips');
    const labels = {
      level: 'Season',
      platoon: 'Platoon',
      form: 'Form',
      history: 'History',
      familiarity: 'Familiarity',
      count: 'Count',
    };
    model.adjustments.forEach((adj) => {
      const pts = adj.points * 100;
      if (Math.abs(pts) < 0.05) return;
      const cls = pts > 0 ? 'adj-pos' : 'adj-neg';
      const chip = node('span', `adj-chip ${cls}`,
        `${labels[adj.id] || adj.id} ${signedPoints(adj.points)}`);
      chip.title = adj.label;
      chips.appendChild(chip);
    });
    return chips;
  }

  function forecastSection(batter, pitcher, model) {
    const section = node('section', `props-section matchup-forecast-section model-${model.coverage}`);
    section.appendChild(node('h3', 'props-heading', 'Two-Sided Hit Forecast'));
    section.appendChild(node('div', 'forecast-matchup', `${playerName(batter)} vs ${playerName(pitcher)}`));

    const scoreLine = node('div', 'forecast-scoreline');
    const hitBlock = node('div', 'forecast-result');
    hitBlock.appendChild(node('span', 'forecast-result-label', 'Hit this PA'));
    const hitValueRow = node('div', 'forecast-value-row');
    hitValueRow.appendChild(node('strong', 'forecast-result-value', `${model.prob}%`));
    hitValueRow.appendChild(tierPill(model));
    hitBlock.appendChild(hitValueRow);
    scoreLine.appendChild(hitBlock);
    const noHitBlock = node('div', 'forecast-result forecast-no-hit');
    noHitBlock.appendChild(node('span', 'forecast-result-label', 'No hit'));
    noHitBlock.appendChild(node('strong', 'forecast-result-value', `${model.noHitProb}%`));
    scoreLine.appendChild(noHitBlock);
    section.appendChild(scoreLine);

    const track = node('div', 'forecast-main-track scaled');
    const scaled = clamp((model.probability - MIN_PA_PROBABILITY) /
      (MAX_LIVE_PROBABILITY - MIN_PA_PROBABILITY), 0, 1);
    const bar = node('div', `forecast-main-bar tier-fill-${model.tier.key}`);
    bar.style.width = `${(scaled * 100).toFixed(1)}%`;
    track.appendChild(bar);
    section.appendChild(track);
    section.appendChild(node('div', 'forecast-scale-note',
      `Per-PA scale ${Math.round(MIN_PA_PROBABILITY * 100)}–${Math.round(MAX_LIVE_PROBABILITY * 100)}% · ` +
      `count-free per-PA: ${model.paProb}%`));

    // Secondary projection: chance of at least one hit across the remaining
    // expected PAs. This number naturally lands in the 16-80%+ range the
    // broadcast-style "hit probability" most fans are used to, so we surface
    // it as its own block instead of burying it in a footnote.
    const projectionBlock = node('div', 'forecast-projection');
    const projHeader = node('div', 'forecast-projection-header');
    const projLabel = model.remainingPAs > 0.05
      ? `≥1 hit in next ${model.remainingPAs.toFixed(1)} PAs`
      : 'Projection';
    projHeader.appendChild(node('span', 'forecast-projection-label', projLabel));
    projHeader.appendChild(node('strong', 'forecast-projection-value', `${model.gameFlowProb}%`));
    projectionBlock.appendChild(projHeader);
    const projTrack = node('div', 'forecast-projection-track');
    // Projection scale: 0–100% (it's a probability over a number of tries).
    const projBar = node('div', 'forecast-projection-bar tier-fill-projection');
    projBar.style.width = `${clamp(model.gameFlowProbability, 0, 1) * 100}%`;
    projTrack.appendChild(projBar);
    projectionBlock.appendChild(projTrack);
    projectionBlock.title = '1 − (1 − per-PA hit chance) ^ remaining PAs — a fan-style projection, not a betting line';
    section.appendChild(projectionBlock);

    const sides = node('div', 'forecast-sides');
    const batterSplit = model.splits.batter;
    const pitcherSplit = model.splits.pitcher;
    appendSignal(sides, 'forecast-batter', 'Batter signal', model.batter, 'batter',
      batterSplit.available
        ? `Split ${batterSplit.label}: ${displayRate(batterSplit.rawAvg)} (${batterSplit.atBats} AB)`
        : null);
    appendSignal(sides, 'forecast-pitcher', 'Pitcher signal', model.pitcher, 'pitcher',
      pitcherSplit.available
        ? `Split ${pitcherSplit.label}: ${displayRate(pitcherSplit.rawAvg)} (${pitcherSplit.atBats} BF AB)`
        : null);
    section.appendChild(sides);

    const chips = adjustmentsRow(model);
    if (model.adjustments.some((adj) => Math.abs(adj.points) * 100 >= 0.05)) {
      const adjustments = node('div', 'forecast-adjustments');
      adjustments.appendChild(node('span', 'forecast-adjustment-label', 'Drivers'));
      adjustments.appendChild(chips);
      section.appendChild(adjustments);
    }

    section.appendChild(node('p', 'forecast-method-note',
      'Season rates are regressed toward the league hit rate, combined multiplicatively (log5), then adjusted by platoon splits, recent form, head-to-head history, same-game familiarity, and the live count. The headline is the per-plate-appearance hit chance; the second number is 1 − (1 − per-PA) ^ remaining PAs.'));
    section.title = describeHitModel(model);
    return section;
  }

  function pitcherSection(pitcher, pitcherStats, arsenal, model) {
    const section = node('section', 'props-section pitcher-section');
    section.appendChild(node('h3', 'props-heading', `Current Pitcher: ${playerName(pitcher)}`));
    const rateText = pitcherStats.xBA !== '—' || pitcherStats.avg !== '—'
      ? `Hit-allowed inputs: xBA ${pitcherStats.xBA} · Opp. AVG ${pitcherStats.avg}`
      : 'Pitcher season hit-allowed data is unavailable.';
    section.appendChild(node('p', 'mix-meta pitcher-input-line', rateText));

    const form = model && model.form && model.form.pitcher;
    if (form && form.available) {
      section.appendChild(node('p', 'mix-meta pitcher-input-line',
        `Recent form: ${displayRate(form.rawAvg)} allowed over last ${form.games} G (${form.atBats} AB)`));
    }

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
    const split = model.splits.batter;
    stat('Split', split.available ? displayRate(split.rawAvg) : '—');
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
    const gameDate = gameDateFor(gameData);
    const batterHand = playerHand(batter, matchup.batSide);
    const pitcherHand = (matchup.pitchHand && matchup.pitchHand.code) || (pitcher.pitchHand && pitcher.pitchHand.code) || '';
    const batters = [
      { player: batter, label: 'Current Batter', hand: batterHand },
      { player: onDeck, label: 'On Deck', hand: playerHand(onDeck) },
      { player: inHole, label: 'In the Hole', hand: playerHand(inHole) },
    ].filter((entry) => entry.player && entry.player.id);

    const allPlays = live.plays && live.plays.allPlays || [];

    Promise.all([
      fetchPlayerStats(pitcher.id, 'pitching', season),
      fetchHeadToHead(batter.id, pitcher.id),
      ...batters.map((entry) => fetchPlayerStats(entry.player.id, 'hitting', season)),
    ]).then((data) => {
      if (version !== renderVersion || !container.isConnected) return;

      const pitcherStats = parsePitcherStats(data[0]);
      const h2h = parseHeadToHead(data[1]);
      const batterData = data.slice(2);
      const currentStats = parseBatterStats(batterData[0]);
      currentStats.h2h = h2h;

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
        gameDate,
        count: currentPlay.count || null,
        timesFacedToday: timesFacedToday(allPlays, batter.id, pitcher.id),
      };

      const currentModel = modelHitProbability(currentStats, pitcherStats, batterHand, pitcherHand, gameContext);
      const arsenal = getPitcherArsenal(allPlays, pitcher.id);

      container.replaceChildren();
      container.appendChild(forecastSection(batter, pitcher, currentModel));
      container.appendChild(pitcherSection(pitcher, pitcherStats, arsenal, currentModel));

      const batterSection = node('section', 'props-section batters-section');
      batterSection.appendChild(node('h3', 'props-heading', `Upcoming Batters vs ${playerName(pitcher)}`));
      const grid = node('div', 'batters-grid');
      batters.forEach((entry, index) => {
        const orderPos = getBattingOrderPosition(box, battingSide, entry.player.id);
        const batterContext = Object.assign({}, gameContext, {
          battingOrderPos: orderPos,
          // Only the live at-bat carries a count; on-deck/in-hole start fresh.
          count: index === 0 ? gameContext.count : null,
          timesFacedToday: timesFacedToday(allPlays, entry.player.id, pitcher.id),
        });
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
    fetchHeadToHead,
    getCachedPlayerStats,
    getHitPrediction,
    getPitcherArsenal,
    timesFacedToday,
    parseStatcast,
    parseBatterStats,
    parsePitcherStats,
    parseHeadToHead,
    modelHitProbability,
    describeHitModel,
  };
})();
