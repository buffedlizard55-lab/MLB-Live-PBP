/* ============================================================================
 * reviews-feed.js — All-Games Replay Review Feed ("chatroom" style)
 * ----------------------------------------------------------------------------
 * Pulls review/challenge events (Manager Challenges, Crew Chief Reviews,
 * Umpire Reviews, ABS pitch challenges, and boundary-call reviews) from
 * EVERY game on the selected date and renders them as a live, chat-style
 * feed. New events appear at the top with a highlight; in-progress reviews
 * pulse until they resolve.
 *
 * Data flow (all shapes verified against statsapi.mlb.com, 2026-08-19):
 *   1. Schedule (hydrate=review,linescore,decisions) -> teams + status +
 *      per-team manager-challenge counts (game.review.away/home.used/remaining).
 *      NOTE: the schedule's `teams.*.team` objects carry ONLY { id, name, link }
 *      — no `abbreviation`. `name` is the official full club name ("Detroit
 *      Tigers") and is what gets rendered; official abbreviations are resolved
 *      separately from MLB.getTeams() (GET /api/v1/teams). Nothing is guessed.
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

function validScorePair(score) {
  return !!score &&
    typeof score.away === 'number' && Number.isFinite(score.away) &&
    typeof score.home === 'number' && Number.isFinite(score.home);
}

function trackedRunsAtRisk(impact) {
  if (!impact) return 0;
  const value = Number.isFinite(impact.runsAtRiskAtStart)
    ? impact.runsAtRiskAtStart
    : Number(impact.runsAtRisk);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Compare the score shown while a review was active with the official score
 * attached to the same play after resolution. This is the only place we call a
 * run "removed" or "added": both numbers were actually observed from StatsAPI
 * payloads. A historical final payload alone cannot reconstruct a temporary
 * in-review score.
 */
function reconcileScoreImpact(previousReview, nextReview) {
  if (!previousReview || !nextReview) return nextReview;
  const previousImpact = previousReview.scoreImpact;
  const freshImpact = nextReview.scoreImpact;
  if (!previousImpact || !freshImpact) return nextReview;

  const previousStart = previousImpact.scoreAtReviewStart ||
    previousImpact.scoreBeforeReview ||
    (previousReview.inProgress ? previousImpact.currentScore : null);
  const previousPossible = previousImpact.possibleScoreAfterReview ||
    previousImpact.possibleScoreIfRemoved;

  // While a review remains active, preserve the first official score observed.
  // A later poll may add runner details; it may not rewrite "Before review".
  if (previousReview.inProgress && nextReview.inProgress) {
    const start = validScorePair(previousStart)
      ? previousStart
      : (freshImpact.scoreAtReviewStart || freshImpact.currentScore);
    let possible = validScorePair(previousPossible) ? previousPossible : null;
    let atRiskAtStart = trackedRunsAtRisk(previousImpact);

    // Newly populated runner details may add a scenario, but only while the
    // score it was computed from still matches the preserved first snapshot.
    const freshStart = freshImpact.scoreAtReviewStart || freshImpact.currentScore;
    const freshPossible = freshImpact.possibleScoreAfterReview ||
      freshImpact.possibleScoreIfRemoved;
    if (!possible && validScorePair(start) && validScorePair(freshStart) &&
        start.away === freshStart.away && start.home === freshStart.home &&
        validScorePair(freshPossible)) {
      possible = freshPossible;
      atRiskAtStart = trackedRunsAtRisk(freshImpact);
    }

    return {
      ...nextReview,
      scoreImpact: {
        ...freshImpact,
        scoreAtReviewStart: validScorePair(start) ? start : null,
        possibleScoreAfterReview: possible,
        possibleScoreIfRemoved: possible,
        runsAtRiskAtStart: atRiskAtStart,
      },
    };
  }

  // Once resolved tracker data exists, retain it on later polls of the same
  // immutable play. A final payload alone cannot recreate the active score.
  if (!previousReview.inProgress && !nextReview.inProgress) {
    const wasObservedActive = previousImpact.activeReviewObserved === true ||
      validScorePair(previousStart);
    if (!wasObservedActive) return nextReview;

    const previousActual = previousImpact.officialScoreAfterReview ||
      previousImpact.scoreAfterReview;
    const freshActual = freshImpact.officialScoreAfterReview || freshImpact.currentScore;
    const actual = validScorePair(freshActual)
      ? freshActual
      : (validScorePair(previousActual) ? previousActual : null);
    const before = validScorePair(previousStart) ? previousStart : null;
    const side = previousImpact.scoringSide || freshImpact.scoringSide;
    const atRisk = trackedRunsAtRisk(previousImpact);
    const reconciled = {
      ...freshImpact,
      context: freshImpact.context || previousImpact.context || null,
      scoringSide: side || null,
      teamLabels: freshImpact.teamLabels || previousImpact.teamLabels,
      activeReviewObserved: true,
      scoreAtReviewStart: before,
      possibleScoreAfterReview: before && validScorePair(previousPossible) ? previousPossible : null,
      possibleScoreIfRemoved: before && validScorePair(previousPossible) ? previousPossible : null,
      runsAtRiskAtStart: atRisk,
      officialScoreAfterReview: actual,
      scoreBeforeReview: before,
      scoreAfterReview: actual,
    };
    if (before && actual && ['away', 'home'].includes(side)) {
      const other = side === 'away' ? 'home' : 'away';
      if (before[other] === actual[other]) {
        const delta = actual[side] - before[side];
        if (delta < 0 && -delta <= atRisk) reconciled.actualRunsRemoved = -delta;
        else if (delta > 0) reconciled.actualRunsAdded = delta;
        else if (delta === 0 && atRisk > 0) reconciled.runsRetained = atRisk;
      }
    }
    return { ...nextReview, scoreImpact: reconciled };
  }

  if (!previousReview.inProgress || nextReview.inProgress) return nextReview;

  // Active → resolved: preserve all three snapshots even when a score change
  // cannot safely be attributed to this review.
  const before = validScorePair(previousStart) ? previousStart : null;
  const after = freshImpact.officialScoreAfterReview || freshImpact.currentScore;
  const side = previousImpact.scoringSide;
  const reconciled = {
    ...freshImpact,
    context: freshImpact.context || previousImpact.context || null,
    scoringSide: side || freshImpact.scoringSide || null,
    teamLabels: freshImpact.teamLabels || previousImpact.teamLabels,
    activeReviewObserved: true,
    scoreAtReviewStart: before,
    possibleScoreAfterReview: before && validScorePair(previousPossible) ? previousPossible : null,
    possibleScoreIfRemoved: before && validScorePair(previousPossible) ? previousPossible : null,
    runsAtRiskAtStart: trackedRunsAtRisk(previousImpact),
    officialScoreAfterReview: validScorePair(after) ? after : null,
    scoreBeforeReview: before,
    scoreAfterReview: validScorePair(after) ? after : null,
  };

  if (before && validScorePair(after) && ['away', 'home'].includes(side)) {
    const other = side === 'away' ? 'home' : 'away';
    // Attribute a run change only if the opponent score did not move.
    if (before[other] === after[other]) {
      const delta = after[side] - before[side];
      const atRisk = trackedRunsAtRisk(previousImpact);
      if (delta < 0 && -delta <= atRisk) reconciled.actualRunsRemoved = -delta;
      else if (delta > 0) reconciled.actualRunsAdded = delta;
      else if (delta === 0 && atRisk > 0) reconciled.runsRetained = atRisk;
    }
  }

  return { ...nextReview, scoreImpact: reconciled };
}

function reviewChanged(previousReview, nextReview) {
  if (!previousReview || !nextReview) return previousReview !== nextReview;
  return previousReview.inProgress !== nextReview.inProgress ||
    previousReview.outcome !== nextReview.outcome ||
    previousReview.outcomeLabel !== nextReview.outcomeLabel ||
    previousReview.reason !== nextReview.reason ||
    previousReview.description !== nextReview.description ||
    JSON.stringify(previousReview.scoreImpact || null) !== JSON.stringify(nextReview.scoreImpact || null);
}

/**
 * Merge a game's freshly extracted reviews into feed state.
 * state = { seen: Map<key, {gamePk, review, firstSeen, lastSeen}>, order: [] }
 * Returns { added: [], updated: [], ended: [] } with the same entry objects.
 *  - added   : keys not seen before (new chatroom messages)
 *  - updated : keys whose outcome, description, or score-impact data changed
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
    let prev = seen.get(key);
    if (!prev && !review.inProgress && Number.isFinite(review.atBatIndex)) {
      // A status-only active review uses `live-active-review`; once the play
      // resolves, the parser can expose its normal play/event id. Re-key only
      // an observed active entry from the exact same game, at-bat, and review
      // type (or a generic status type) so unrelated reviews are never joined.
      const alias = [...seen.entries()].find(([candidateKey, candidate]) => {
        const prior = candidate && candidate.review;
        if (!prior || candidate.gamePk !== gamePk || !prior.inProgress ||
            prior.atBatIndex !== review.atBatIndex || currentKeys.has(candidateKey)) return false;
        const priorType = prior.typeKey || 'review';
        const nextType = review.typeKey || 'review';
        return priorType === nextType || priorType === 'review' || nextType === 'review';
      });
      if (alias) {
        const [aliasKey, aliasEntry] = alias;
        seen.delete(aliasKey);
        seen.set(key, aliasEntry);
        const idx = order.indexOf(aliasKey);
        if (idx >= 0) order[idx] = key;
        prev = aliasEntry;
      }
    }
    if (!prev) {
      const entry = { gamePk, review, firstSeen: now, lastSeen: now };
      seen.set(key, entry);
      order.push(key);
      added.push(entry);
      return;
    }
    prev.lastSeen = now;
    const reconciledReview = reconcileScoreImpact(prev.review, review);
    if (reviewChanged(prev.review, reconciledReview)) {
      prev.review = reconciledReview;
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

/**
 * Poll gap in ms. Active reviews use the short cadence so an outcome flip
 * is not waiting on the ordinary live interval. Values are passed in so
 * this stays a pure function (the page IIFE owns the constants).
 */
function pollIntervalMs({ hasLive, hasActiveReview, liveMs, reviewMs, idleMs }) {
  if (hasActiveReview) return reviewMs;
  if (hasLive) return liveMs;
  return idleMs;
}

/**
 * Wait after a scan so the *cycle* (scan + idle) equals `intervalMs`.
 * If the scan already used the whole budget, wait 0 — never a negative
 * timeout, never invent a delay.
 */
function waitAfterScan(intervalMs, elapsedMs) {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return intervalMs;
  return Math.max(0, intervalMs - elapsedMs);
}

/**
 * Fetch order for the all-games scanner. Lower number = sooner.
 *   0 — schedule status already says challenge/review, or we already have
 *       an in-progress entry for that game (catch the outcome first)
 *   1 — other live games
 *   2 — finals / everything else
 * Uses only status.detailedState / abstractGameState plus the boolean the
 * caller already computed from feed state — no guessed fields.
 */
function reviewFetchPriority(game, hasInProgress) {
  const detailed = (game && game.status && game.status.detailedState) || '';
  if (hasInProgress || /challenge|review/i.test(detailed)) return 0;
  const state = game && game.status && game.status.abstractGameState;
  if (state === 'Live') return 1;
  return 2;
}

/** Run `fn` over items with a fixed concurrency cap. Preserves completion of every item. */
async function mapPool(items, limit, fn) {
  const list = items || [];
  const conc = Math.max(1, Number(limit) || 1);
  let cursor = 0;
  async function worker() {
    while (cursor < list.length) {
      const idx = cursor;
      cursor += 1;
      await fn(list[idx], idx);
    }
  }
  const n = Math.min(conc, list.length);
  const workers = [];
  for (let i = 0; i < n; i += 1) workers.push(worker());
  await Promise.all(workers);
}

/**
 * True only for a real, printable club name. Rejects null/empty and the
 * literal strings "undefined" / "null" so a missing field can never leak
 * into the matchup headline as "undefined @ undefined".
 */
function isUsableName(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  return lower !== 'undefined' && lower !== 'null';
}

/**
 * Schedule side object → the nested team (or the side itself if a hydration
 * flattened the fields). Handles both the verified live shape
 * `{ team: { id, name, link } }` and richer `hydrate=team` objects.
 */
function gameSideTeam(game, which) {
  const side = game && game.teams && game.teams[which];
  if (!side) return null;
  if (side.team && (side.team.id != null || side.team.name || side.team.abbreviation)) {
    return side.team;
  }
  if (side.id != null || side.name || side.abbreviation) return side;
  return null;
}

/**
 * Official club name for one side. Order of preference (never guessed):
 *   1. schedule `team.name` (verified live: "Detroit Tigers")
 *   2. locationName + teamName ("Detroit" + "Tigers")
 *   3. /teams directory name, then its official abbreviation
 *   4. schedule abbreviation / shortName if a hydration supplied one
 *   5. explicit AWY/HOM placeholder
 */
function officialTeamName(team, teamsById, fallback) {
  const dir = teamsById && team && team.id != null ? teamsById[team.id] : null;
  const locationTeam = team && isUsableName(team.locationName) && isUsableName(team.teamName)
    ? `${team.locationName.trim()} ${team.teamName.trim()}`
    : null;
  const candidates = [
    team && team.name,
    locationTeam,
    team && team.teamName,
    dir && dir.name,
    dir && dir.abbreviation,
    team && team.abbreviation,
    team && team.shortName,
    team && team.clubName,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (isUsableName(candidates[i])) return candidates[i].trim();
  }
  return fallback;
}

/**
 * Official matchup label for one schedule game, e.g.
 * "Detroit Tigers @ Pittsburgh Pirates".
 *
 * The string "undefined" can never appear: every candidate is run through
 * isUsableName(), and a wholly missing team degrades to AWY/HOM.
 */
function gameTeamsLabel(game, teamsById) {
  return `${officialTeamName(gameSideTeam(game, 'away'), teamsById, 'AWY')} @ ${officialTeamName(gameSideTeam(game, 'home'), teamsById, 'HOM')}`;
}

/**
 * Whether a review should trigger the audio alert (gentle raindrop chime).
 * Requirement: challenges, reviews, boundary calls, but NOT ABS.
 * ABS is typeKey 'abs'. Everything else (manager, crew_chief, boundary,
 * review, rules, umpire) qualifies. Pure function — no DOM.
 */
function shouldAlertForReview(review) {
  if (!review || typeof review.typeKey !== 'string') return false;
  return review.typeKey !== 'abs';
}

/**
 * Runs currently on the scoreboard that THIS review could take back off.
 *
 * Mirrors MLBReviews.runsRemovableByReview() exactly, but is self-contained so
 * the feed's pure-helper layer (and its Node tests) never depend on reviews.js
 * being loaded. Both read the very same observed fields:
 *
 *   review.inProgress                    — the review has not resolved yet
 *   scoreImpact.runsCredited             — scoring movements StatsAPI ties to
 *                                          the reviewed event (see
 *                                          reviewedScoringRunners())
 *   scoreImpact.runsAtRisk /
 *   scoreImpact.runsAtRiskAtStart        — the same count captured on the first
 *                                          poll that saw the review active
 *
 * The largest positive finite candidate wins: reconcileScoreImpact() keeps the
 * FIRST observed snapshot, so `runsAtRiskAtStart` can still read 0 on a poll
 * where the runner records have only just appeared, and a run that shows up
 * late must not be silently dropped from the alert.
 *
 * Nothing here is a prediction and nothing is inferred from a score delta: a
 * run is "at risk" only because the official payload credited it to the play
 * that is under review. Returns 0 for resolved reviews and malformed input.
 */
function runsRemovableFromReview(review) {
  if (!review) return 0;
  if (review.inProgress !== true) return 0;
  const impact = review.scoreImpact;
  if (!impact || typeof impact !== 'object') return 0;
  const candidates = [
    impact.runsAtRiskAtStart,
    impact.runsAtRisk,
    impact.runsCredited,
  ].filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (!candidates.length) return 0;
  return Math.max(...candidates);
}

/**
 * Whether a review deserves the URGENT alert (a run already on the scoreboard
 * could be removed). Deliberately independent of shouldAlertForReview():
 * the soft chime skips routine ABS pitch challenges, but the run-removal
 * alert is driven purely by whether runs are tied to the reviewed event, so
 * every review type — manager challenge, crew chief/umpire review, boundary
 * call, "under review" status entry, ABS — is eligible.
 */
function shouldRunRiskAlert(review) {
  return runsRemovableFromReview(review) > 0;
}

/**
 * Diff two polls of the tracked run-risk keys.
 *
 * `previousKeys` is the set of event keys that already raised the alert;
 * `entries` is every feed entry currently known across the whole slate (the
 * caller runs this once per poll, not once per game, so a re-keyed entry is
 * reconciled in a single pass). Returns the keys that newly became risky
 * (`started`), the keys that are no longer risky or no longer exist
 * (`cleared`), and the full next set. Pure so the "don't re-alert on every
 * poll" behaviour is directly testable.
 */
function diffRunRiskKeys(previousKeys, entries, keyOf) {
  const prev = previousKeys instanceof Set ? previousKeys : new Set(previousKeys || []);
  const next = new Set();
  const started = [];
  (entries || []).forEach((entry) => {
    if (!entry) return;
    const key = keyOf(entry);
    if (!key) return;
    if (!shouldRunRiskAlert(entry.review)) return;
    next.add(key);
    if (!prev.has(key)) started.push(key);
  });
  const cleared = [...prev].filter((key) => !next.has(key));
  return { started, cleared, next };
}

/* ------------------------------------------------------------ page logic */

(() => {
  // Cadence is the gap between poll STARTS (scan duration is subtracted in
  // waitAfterScan). The StatsAPI is pull-only — a shorter poll only reduces
  // how long a landed review sits unseen. Hidden tabs still pause.
  //   live games          : 2s
  //   a review in flight  : 1s  (outcome flips are what the feed is for)
  //   no live games       : 15s
  const LIVE_POLL_MS = 2000;
  const REVIEW_POLL_MS = 1000;
  const IDLE_POLL_MS = 15000;
  // playByPlay is one request per live / unsettled-final game. 10 at a time
  // keeps a 15-game slate to two waves instead of three sequential batches
  // of 5 (the previous scanner). Same host, same CORS-open endpoint.
  const FETCH_CONCURRENCY = 10;

  let dateStr = todayStr();
  let games = [];
  let teamsById = {};              // teamId -> official {name, abbreviation, ...}
  let filter = 'all';
  let pollTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = 0;
  let lastCycleStartedAt = 0;
  let requestInFlight = false;
  let settledGames = new Set();     // Final games: fetched once, immutable
  const feedState = { seen: new Map(), order: [] };

  // --- Audio alert state (gentle raindrop chime for challenges/reviews/boundary, not ABS) ---
  let isFirstLoad = true;
  let pendingAlertableCount = 0;
  let audioEnabled = false;
  let audioContext = null;
  let lastAlertAt = 0;

  // --- Run-at-risk alert state (URGENT: a run already on the scoreboard could
  // be removed by an active review). Tracked separately from the soft chime:
  // it has its own sound, its own cooldown, and it fires for every review type
  // including ABS. `alertedRunRiskKeys` holds the event keys that have already
  // sounded so a still-running review does not re-alert on every 1s poll; a
  // key is dropped again the moment the review resolves or stops being risky,
  // so a genuinely new review on the same play can alert again.
  const alertedRunRiskKeys = new Set();
  let pendingRunRiskAlerts = [];
  let lastRunRiskAlertAt = 0;
  let notifyEnabled = false;

  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('replayFeedSoundEnabled') : null;
    audioEnabled = stored === '1' || stored === 'true';
  } catch (_) {
    audioEnabled = false;
  }

  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('replayFeedNotifyEnabled') : null;
    notifyEnabled = stored === '1' || stored === 'true';
  } catch (_) {
    notifyEnabled = false;
  }

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
    isFirstLoad = true;
    pendingAlertableCount = 0;
    alertedRunRiskKeys.clear();
    pendingRunRiskAlerts = [];
  }

  function $ (sel) { return document.querySelector(sel); }

  function el(tag, cls, text, attrs) { return UI.el(tag, cls, text, attrs); }

  /* -------------------------------------------------------- audio alert */

  function ensureAudioContext() {
    if (audioContext) return audioContext;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioContext = new AC();
      return audioContext;
    } catch (_) {
      return null;
    }
  }

  /**
   * Play a soft "raindrop chime" alert for challenges/reviews/boundary calls.
   * Uses Web Audio API (no external file) so it works on static hosting.
   *
   * Sound design (gentle but unmistakable — pleasant even when it fires often):
   *   - Three ascending water-drop "bloops": pure sine oscillators whose pitch
   *     falls fast (exponential ramp high→low, the classic synthesized-
   *     raindrop technique) with a quick attack and a natural decay. The
   *     rising plip-plop-ploop motif is instantly recognizable as "something
   *     happened" without any urgency or harshness.
   *   - A warm chime tail: two sine partials a perfect fifth apart bloom out
   *     of the last drop and ring out softly, so the alert is clearly
   *     noticeable at low volume.
   *   - Sine waves only — no square/sawtooth buzz — capped at a modest peak,
   *     with a light low-passed echo so repeats feel airy, not insistent.
   *   - ~1.2s total, then silence (the old alert was a 3s buzzer).
   */
  function playAlertSound() {
    if (!audioEnabled) return;
    const nowMs = Date.now();
    // Cooldown 2.5s to avoid overlapping chimes when multiple games report at once
    if (nowMs - lastAlertAt < 2500) return;
    lastAlertAt = nowMs;

    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const t0 = ctx.currentTime;
      const PEAK = 0.24; // soft level; the sine-only timbre keeps it gentle

      // Master bus: fades the whole alert out smoothly at the end.
      const master = ctx.createGain();
      master.gain.setValueAtTime(0, t0);
      master.gain.linearRampToValueAtTime(1, t0 + 0.01);
      master.gain.setValueAtTime(1, t0 + 1.05);
      master.gain.linearRampToValueAtTime(0, t0 + 1.25);
      master.connect(ctx.destination);

      // Soft echo (spacious "rainy" tail): short delay with light feedback,
      // low-passed so each repeat is mellower than the last.
      const echo = ctx.createDelay(1);
      echo.delayTime.value = 0.17;
      const echoFilter = ctx.createBiquadFilter();
      echoFilter.type = 'lowpass';
      echoFilter.frequency.value = 1800;
      const echoFeedback = ctx.createGain();
      echoFeedback.gain.value = 0.25;
      const echoMix = ctx.createGain();
      echoMix.gain.value = 0.3;
      master.connect(echo);
      echo.connect(echoFilter);
      echoFilter.connect(echoFeedback);
      echoFeedback.connect(echo);
      echoFilter.connect(echoMix);
      echoMix.connect(ctx.destination);

      // One synthesized water drop: a sine that starts high and falls fast,
      // with a quick attack and exponential decay. Returns its gain node so
      // the caller sets level + timing.
      const raindrop = (startAt, fromHz, toHz, level) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(fromHz, startAt);
        osc.frequency.exponentialRampToValueAtTime(toHz, startAt + 0.09);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, startAt);
        g.gain.linearRampToValueAtTime(level, startAt + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
        g.gain.setValueAtTime(0, startAt + 0.39);
        osc.connect(g);
        osc.start(startAt);
        osc.stop(startAt + 0.4);
        return g;
      };

      // Three ascending drops — the recognizable alert motif.
      raindrop(t0, 900, 340, PEAK).connect(master);
      raindrop(t0 + 0.16, 1080, 400, PEAK).connect(master);
      raindrop(t0 + 0.32, 1260, 470, PEAK).connect(master);

      // Warm chime tail (perfect fifth dyad) so the event is obvious without
      // any harshness. B5 + F#6 ring softly under the last drop's decay.
      const chime = (freq, level) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t0 + 0.42);
        g.gain.linearRampToValueAtTime(level, t0 + 0.46);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2);
        g.gain.setValueAtTime(0, t0 + 1.21);
        osc.connect(g);
        osc.start(t0 + 0.42);
        osc.stop(t0 + 1.22);
        return g;
      };
      chime(990, PEAK * 0.85).connect(master);
      chime(1485, PEAK * 0.45).connect(master);

      // Cleanup nodes after playback (alert ends 1.25s in; echo tail follows)
      setTimeout(() => {
        try { master.disconnect(); } catch (_) {}
        try { echo.disconnect(); } catch (_) {}
        try { echoFilter.disconnect(); } catch (_) {}
        try { echoFeedback.disconnect(); } catch (_) {}
        try { echoMix.disconnect(); } catch (_) {}
      }, 1800);
    } catch (err) {
      console.warn('alert sound failed', err);
    }
  }

  /**
   * URGENT alert: a run that is already on the scoreboard could be taken off
   * by an active review. Deliberately NOT the soft raindrop chime — this one
   * has to cut through, because it is the one event the user asked to hear
   * about "ASAP".
   *
   * Sound design (distinct from the chime in rhythm, pitch and length):
   *   - A two-tone alternating siren: six fast staccato pulses swapping
   *     between two pitches a minor third apart, the pattern the ear reads as
   *     an alarm rather than a notification.
   *   - Each pulse is a steady-pitch sine with a hard 8ms attack and a short
   *     exponential release, so the pattern stays crisp instead of smearing.
   *   - A low sine "thud" underpins the first pulse for weight.
   *   - Sine oscillators only (same no-buzz rule as the chime) at a higher but
   *     still bounded peak. ~1.45s total, then silence.
   */
  function playRunRiskAlertSound() {
    if (!audioEnabled) return;
    const nowMs = Date.now();
    // Own cooldown, independent of the soft chime's, so a run-risk alert is
    // never swallowed by an ordinary review chime that just played. Kept just
    // above the ~1.45s sound length: two different games going at risk one
    // poll apart should still both be heard.
    if (nowMs - lastRunRiskAlertAt < 1600) return;
    lastRunRiskAlertAt = nowMs;

    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const t0 = ctx.currentTime;
      const PEAK = 0.3; // louder than the chime's 0.24, still a bounded level.
      const PULSE = 0.12;   // pulse-to-pulse spacing
      const PULSES = 6;
      const END = PULSE * PULSES + 0.55;

      const master = ctx.createGain();
      master.gain.setValueAtTime(0, t0);
      master.gain.linearRampToValueAtTime(1, t0 + 0.005);
      master.gain.setValueAtTime(1, t0 + END - 0.12);
      master.gain.linearRampToValueAtTime(0, t0 + END);
      master.connect(ctx.destination);

      // One staccato siren pulse at a fixed pitch.
      const pulse = (startAt, hz, level, hold) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(hz, startAt);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, startAt);
        g.gain.linearRampToValueAtTime(level, startAt + 0.008);
        g.gain.setValueAtTime(level, startAt + hold);
        g.gain.exponentialRampToValueAtTime(0.0001, startAt + hold + 0.06);
        g.gain.setValueAtTime(0, startAt + hold + 0.07);
        osc.connect(g);
        osc.start(startAt);
        osc.stop(startAt + hold + 0.08);
        return g;
      };

      // Two-tone alternation: A5 (880) / C6 (1047) — a minor third apart.
      for (let i = 0; i < PULSES; i += 1) {
        const hz = i % 2 === 0 ? 880 : 1047;
        pulse(t0 + i * PULSE, hz, PEAK, 0.055).connect(master);
      }

      // Low body under the first two pulses so the alert has weight even on
      // laptop speakers that roll off the siren tones.
      pulse(t0, 220, PEAK * 0.55, 0.2).connect(master);

      // Closing accent: the two siren tones held together, decaying out, so
      // the alert has an unmistakable "that was the big one" tail.
      const tailAt = t0 + PULSE * PULSES + 0.04;
      const tail = (hz, level) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(hz, tailAt);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, tailAt);
        g.gain.linearRampToValueAtTime(level, tailAt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + END - 0.02);
        g.gain.setValueAtTime(0, t0 + END - 0.01);
        osc.connect(g);
        osc.start(tailAt);
        osc.stop(t0 + END);
        return g;
      };
      tail(880, PEAK * 0.9).connect(master);
      tail(1047, PEAK * 0.6).connect(master);

      setTimeout(() => {
        try { master.disconnect(); } catch (_) {}
      }, Math.round((END + 0.4) * 1000));
    } catch (err) {
      console.warn('run-risk alert sound failed', err);
    }
  }

  /**
   * Desktop notification for a run-at-risk event. Only fires when the user has
   * explicitly turned notifications on AND the browser has granted permission;
   * silently does nothing anywhere else (including Node/test contexts, where
   * `Notification` is undefined). Body text is built from observed payload
   * fields only — see MLBReviews.runRiskSummary().
   */
  function notifyRunRisk(entries) {
    if (!notifyEnabled || !entries || !entries.length) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const first = entries[0];
      const summary = window.MLBReviews && window.MLBReviews.runRiskSummary
        ? window.MLBReviews.runRiskSummary(first.review)
        : null;
      const total = entries.reduce((sum, e) => sum + runsRemovableFromReview(e.review), 0);
      const title = entries.length === 1
        ? `⚠️ ${summary ? summary.headline : 'RUN AT RISK'}`
        : `⚠️ ${total} ${total === 1 ? 'RUN' : 'RUNS'} AT RISK in ${entries.length} games`;
      const lines = [
        matchupFor(first, games.find((g) => g.gamePk === first.gamePk) || null),
        first.review && first.review.reviewType,
        summary && summary.startScore
          ? (summary.possibleScore
            ? `Call stands: ${summary.startScore} · If removed: ${summary.possibleScore}`
            : `Score when review started: ${summary.startScore}`)
          : null,
      ].filter(Boolean);
      const note = new Notification(title, {
        body: lines.join('\n'),
        tag: 'mlb-replay-run-risk',
        renotify: true,
      });
      note.onclick = () => {
        try {
          window.focus();
          window.location.href = `game.html?gamePk=${first.gamePk}`;
        } catch (_) {}
      };
    } catch (err) {
      console.warn('run-risk notification failed', err);
    }
  }

  function updateSoundToggleUI() {
    const btn = $('#sound-toggle-btn');
    if (!btn) return;
    if (audioEnabled) {
      btn.textContent = '🔔 Sound On';
      btn.classList.add('btn-sound-on');
      btn.classList.remove('btn-ghost');
      btn.title = 'Alert sound ON — gentle raindrop chime for challenges/reviews/boundary calls (not ABS), plus an urgent two-tone siren whenever an active review could take a run OFF the scoreboard (any review type, ABS included). Click to mute.';
    } else {
      btn.textContent = '🔇 Sound Off';
      btn.classList.remove('btn-sound-on');
      btn.classList.add('btn-ghost');
      btn.title = 'Alert sound OFF — click to enable the gentle raindrop chime for challenges/reviews/boundary calls and the urgent run-at-risk siren';
    }
  }

  function updateNotifyToggleUI() {
    const btn = $('#notify-toggle-btn');
    if (!btn) return;
    const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
    const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
    if (typeof Notification === 'undefined') {
      btn.textContent = '🔕 No Alerts';
      btn.classList.add('btn-ghost');
      btn.classList.remove('btn-sound-on');
      btn.title = 'This browser does not support desktop notifications.';
      return;
    }
    if (notifyEnabled && granted) {
      btn.textContent = '🔴 Run Alerts On';
      btn.classList.add('btn-sound-on');
      btn.classList.remove('btn-ghost');
      btn.title = 'Desktop notification ON — you get a popup the moment a review could remove a run already on the scoreboard. Click to turn off.';
    } else {
      btn.textContent = '⚪ Run Alerts Off';
      btn.classList.remove('btn-sound-on');
      btn.classList.add('btn-ghost');
      btn.title = denied
        ? 'Desktop notifications are blocked for this site in your browser settings.'
        : 'Desktop notifications OFF — click to be popped up the moment a review could remove a run from the score.';
    }
  }

  function setNotifyEnabled(enabled) {
    const want = !!enabled;
    const persist = () => {
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('replayFeedNotifyEnabled', notifyEnabled ? '1' : '0');
        }
      } catch (_) {}
      updateNotifyToggleUI();
    };
    if (!want || typeof Notification === 'undefined') {
      notifyEnabled = want && typeof Notification !== 'undefined';
      persist();
      return;
    }
    if (Notification.permission === 'granted') {
      notifyEnabled = true;
      persist();
      return;
    }
    if (Notification.permission === 'denied') {
      notifyEnabled = false;
      persist();
      return;
    }
    // Permission prompt must happen on the user gesture that got us here.
    try {
      const result = Notification.requestPermission((p) => {
        notifyEnabled = p === 'granted';
        persist();
      });
      if (result && typeof result.then === 'function') {
        result.then((p) => { notifyEnabled = p === 'granted'; persist(); })
          .catch(() => { notifyEnabled = false; persist(); });
      }
    } catch (_) {
      notifyEnabled = false;
      persist();
    }
  }

  function setSoundEnabled(enabled) {
    audioEnabled = !!enabled;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('replayFeedSoundEnabled', audioEnabled ? '1' : '0');
      }
    } catch (_) {}
    updateSoundToggleUI();
    if (audioEnabled) {
      const ctx = ensureAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      // Play the chime once as a preview so the user knows what to listen
      // for (triggered directly on the user gesture, which satisfies
      // autoplay policy)
      playAlertSound();
    }
  }

  /* ------------------------------------------------------------- polling */

  async function load() {
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
    lastCycleStartedAt = Date.now();
    const statusLine = $('#status-line');
    setLivePulse(true);
    pendingAlertableCount = 0;
    pendingRunRiskAlerts = [];

    try {
      const scheduleGames = await MLB.getSchedule(requestDate);
      if (requestDate !== dateStr) return;
      games = scheduleGames;

      // Official team directory for the schedule's season: the schedule's own
      // team objects have NO abbreviation (verified live 2026-08-19), so
      // official abbreviations are resolved here — never fabricated. If this
      // request fails, official full names still render from the schedule and
      // abbreviation chips simply stay hidden.
      const season = (games.find((g) => g && g.season) || {}).season
        || requestDate.slice(0, 4);
      try {
        teamsById = await MLB.getTeams(season);
      } catch (dirErr) {
        console.warn('team directory unavailable — abbreviations hidden this poll', dirErr);
        teamsById = {};
      }
      if (requestDate !== dateStr) return;

      const candidates = games.filter((g) => {
        const state = g.status && g.status.abstractGameState;
        return state === 'Live' || state === 'Final';
      });

      // Games already under review first, then other live games, then finals.
      // That cuts the wait for an outcome flip on a 15-game slate.
      candidates.sort((a, b) =>
        reviewFetchPriority(a, gameHasInProgress(a.gamePk)) -
        reviewFetchPriority(b, gameHasInProgress(b.gamePk)));

      await mapPool(candidates, FETCH_CONCURRENCY, async (g) => {
        if (requestDate !== dateStr) return;
        await ingestGame(g);
      });
      if (requestDate !== dateStr) return;

      // Run-at-risk scan. Done once per poll across the WHOLE slate (not per
      // game) so a key that moved games/re-keyed is reconciled in one pass,
      // and so one poll produces at most one urgent alert no matter how many
      // games report at the same instant.
      syncRunRiskTracking();

      // Priority order: if any run is newly at risk, that is the alert the
      // user asked for — it plays instead of (never on top of) the soft chime.
      // Unlike the soft chime this DOES fire on the very first load: only a
      // still-active review can put a run at risk, so there is no backlog of
      // historical events to blast through, and a live run-removal review is
      // exactly what the user wants to hear about the moment the page opens.
      if (pendingRunRiskAlerts.length) {
        if (audioEnabled) playRunRiskAlertSound();
        notifyRunRisk(pendingRunRiskAlerts);
      } else if (!isFirstLoad && pendingAlertableCount > 0 && audioEnabled) {
        // If this poll discovered new non-ABS events and it's not the very
        // first load (initial page population), play the raindrop chime.
        playAlertSound();
      }
      isFirstLoad = false;

      render();
      renderStatusLine();
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

    // Schedule team objects carry only { id, name, link } (verified live
    // 2026-08-19). The official abbreviation comes from the /teams directory;
    // when it is unavailable it stays null and the chip is hidden — never a
    // fabricated abbreviation.
    const pseudoTeam = (side) => {
      const t = gameSideTeam(game, side);
      if (!t || t.id == null) return null;
      const dir = teamsById[t.id];
      const name = officialTeamName(t, teamsById, null);
      return {
        id: t.id,
        name,
        abbreviation: (dir && dir.abbreviation) || (isUsableName(t.abbreviation) ? t.abbreviation : null),
      };
    };

    const pseudoFeed = {
      gameData: {
        status: game.status || {},
        teams: { away: pseudoTeam('away'), home: pseudoTeam('home') },
      },
      // Schedule linescore is an official fallback for an active currentPlay
      // whose result score has not populated yet.
      liveData: { plays: pbp, linescore: game.linescore || null },
    };

    const reviewData = window.MLBReviews
      ? window.MLBReviews.extractReviews(pseudoFeed)
      : { reviews: [], activeReview: null };
    const result = mergeFeedEvents(feedState, gamePk, reviewData.reviews);
    // Count new alertable events for the chime (challenges/reviews/boundary, not ABS)
    if (result.added && result.added.length) {
      const alertable = result.added.filter((e) => {
        try {
          // Use the pure helper defined outside the IIFE
          return typeof shouldAlertForReview === 'function'
            ? shouldAlertForReview(e.review)
            : e.review && e.review.typeKey !== 'abs';
        } catch (_) {
          return false;
        }
      }).length;
      if (alertable > 0) pendingAlertableCount += alertable;
    }
    // Stamp the official matchup on every entry for this game so a later
    // render does not depend on re-finding the schedule object.
    const matchupLabel = gameTeamsLabel(game, teamsById);
    feedState.seen.forEach((entry) => {
      if (entry.gamePk === gamePk) entry.matchupLabel = matchupLabel;
    });
    if (result.added.length || result.updated.length || result.ended.length) {
      renderFeedUpdates(result);
    }
  }

  /* -------------------------------------------------- run-at-risk tracking */

  /** Every feed entry whose active review could remove a run, newest first. */
  function runRiskEntries() {
    const list = [];
    feedState.seen.forEach((entry) => {
      if (runsRemovableFromReview(entry.review) > 0) list.push(entry);
    });
    return sortFeedEntries(list);
  }

  /** Total runs currently at risk across the whole slate. */
  function runRiskTotal() {
    return runRiskEntries().reduce((sum, e) => sum + runsRemovableFromReview(e.review), 0);
  }

  /**
   * Reconcile `alertedRunRiskKeys` with the current feed state and stage any
   * newly-risky entries for this poll's alert.
   *
   * A key is added when its review first shows runs at risk and removed as
   * soon as it resolves, stops being risky, or disappears from the feed — so
   * a long review alerts once, not once per second, while a genuinely new
   * risky review always alerts.
   */
  function syncRunRiskTracking() {
    const entries = [...feedState.seen.values()];
    const keyOf = (entry) => buildEventKey(entry.gamePk, entry.review);
    const diff = diffRunRiskKeys(alertedRunRiskKeys, entries, keyOf);
    diff.cleared.forEach((key) => alertedRunRiskKeys.delete(key));
    diff.next.forEach((key) => alertedRunRiskKeys.add(key));
    if (!diff.started.length) return;
    const started = new Set(diff.started);
    pendingRunRiskAlerts = entries.filter((entry) => started.has(keyOf(entry)));
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
    wrap.appendChild(stat('Boundary Calls', entries.filter((e) => e.review.typeKey === 'boundary').length, 'stat-boundary'));
    wrap.appendChild(stat('Overturned', entries.filter((e) => e.review.outcome === 'overturned').length, 'stat-overturned'));
    wrap.appendChild(stat('Stands / Upheld', entries.filter((e) => e.review.outcome === 'stands').length, 'stat-stands'));
    const inProgress = entries.filter((e) => e.review.inProgress);
    if (inProgress.length) {
      wrap.appendChild(stat('Under Review', inProgress.length, 'stat-active-pulse'));
    }
    // Runs that active reviews could take back off the scoreboard right now.
    // Only shown when there is something to show — a 0 here is noise.
    const atRisk = runRiskTotal();
    if (atRisk > 0) {
      const item = stat('Runs at Risk', atRisk, 'stat-run-risk');
      item.title = 'Runs already credited on the scoreboard that an active review could remove. ' +
        'Counted only from scoring movements the official payload ties to the reviewed event.';
      wrap.appendChild(item);
    }
  }

  function renderActiveStrip() {
    const wrap = UI.clear($('#active-strip'));
    renderRunRiskBanner(wrap);
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
      const label = entries.length
        ? entries[0].review.reviewType
        : (g.status && g.status.detailedState) || 'Review';
      const item = el('a', 'feed-active-link', '',
        { href: `game.html?gamePk=${gamePk}` });
      item.appendChild(el('span', 'feed-active-game',
        matchupFor(null, g)));
      item.appendChild(el('span', 'feed-active-type', label));
      if (entries.length && entries[0].review.reason) {
        item.appendChild(el('span', 'feed-active-reason', entries[0].review.reason));
      }
      if (entries.length && window.MLBReviews && window.MLBReviews.scoreImpactPresentation) {
        const impact = window.MLBReviews.scoreImpactPresentation(entries[0].review);
        if (impact) {
          const riskCls = runsRemovableFromReview(entries[0].review) > 0
            ? ' feed-active-impact-risk'
            : '';
          item.appendChild(el('span', `feed-active-impact${riskCls}`, impact.title));
        }
      }
      if (entries.some((e) => runsRemovableFromReview(e.review) > 0)) {
        item.classList.add('feed-active-link-risk');
      }
      bar.appendChild(item);
    });
    wrap.appendChild(bar);
  }

  /**
   * Top-of-page banner: every game where an active review could take a run
   * back off the scoreboard. This is the persistent visual half of the "alert
   * me ASAP" requirement — the siren fires once, this stays up for as long as
   * the run is actually at risk and disappears the moment the review resolves.
   *
   * Every number and score printed here comes from MLBReviews.runRiskSummary(),
   * i.e. straight from the observed payload. When the payload does not support
   * an alternate score, that half of the line is simply omitted rather than
   * being guessed.
   */
  function renderRunRiskBanner(wrap) {
    const entries = runRiskEntries();
    if (!entries.length) return;
    const total = entries.reduce((sum, e) => sum + runsRemovableFromReview(e.review), 0);

    const banner = el('div', 'run-risk-banner');
    const head = el('div', 'run-risk-banner-head');
    head.appendChild(el('span', 'run-risk-siren', '⚠️'));
    head.appendChild(el('strong', 'run-risk-headline',
      `${total} ${total === 1 ? 'RUN' : 'RUNS'} AT RISK`));
    head.appendChild(el('span', 'run-risk-sub',
      entries.length === 1
        ? 'An active review could remove a run already on the scoreboard'
        : `Active reviews in ${entries.length} games could remove runs already on the scoreboard`));
    banner.appendChild(head);

    const list = el('div', 'run-risk-list');
    entries.forEach((entry) => {
      const game = games.find((g) => g.gamePk === entry.gamePk) || null;
      const summary = window.MLBReviews && window.MLBReviews.runRiskSummary
        ? window.MLBReviews.runRiskSummary(entry.review)
        : null;
      const runs = summary ? summary.runs : runsRemovableFromReview(entry.review);
      const item = el('a', 'run-risk-item', '', {
        href: `game.html?gamePk=${entry.gamePk}`,
        title: `Open game — ${matchupFor(entry, game)}`,
      });
      item.appendChild(el('span', 'run-risk-count',
        `${runs} ${runs === 1 ? 'RUN' : 'RUNS'}`));
      item.appendChild(el('span', 'run-risk-game', matchupFor(entry, game)));
      if (entry.review.reviewType) {
        item.appendChild(el('span', 'run-risk-type', entry.review.reviewType));
      }
      if (entry.review.inningLabel) {
        item.appendChild(el('span', 'run-risk-inn', entry.review.inningLabel));
      }
      if (summary && summary.teamLabel) {
        item.appendChild(el('span', 'run-risk-team',
          `${summary.teamLabel} scored the run${runs === 1 ? '' : 's'}`));
      }
      if (summary && summary.startScore) {
        item.appendChild(el('span', 'run-risk-score',
          summary.possibleScore
            ? `Call stands: ${summary.startScore} · If removed: ${summary.possibleScore}`
            : `Score when review started: ${summary.startScore}`));
      }
      if (summary && summary.runnerNames.length) {
        item.appendChild(el('span', 'run-risk-runners',
          `Credited: ${summary.runnerNames.join(', ')}`));
      }
      list.appendChild(item);
    });
    banner.appendChild(list);
    banner.appendChild(el('div', 'run-risk-note',
      'Runs are counted only from scoring movements the official play payload ties to the reviewed ' +
      'event. Whether replay actually removes them is not predicted here.'));
    wrap.appendChild(banner);
  }

  function renderTabs() {
    const entries = [...feedState.seen.values()];
    const counts = {
      all: entries.length,
      abs: entries.filter((e) => e.review.typeKey === 'abs').length,
      manager: entries.filter((e) => e.review.typeKey === 'manager').length,
      crew: entries.filter((e) => e.review.typeKey === 'crew_chief').length,
      boundary: entries.filter((e) => e.review.typeKey === 'boundary').length,
      live: entries.filter((e) => e.review.inProgress).length,
      runrisk: entries.filter((e) => runsRemovableFromReview(e.review) > 0).length,
    };
    const tabs = [
      ['all', `All (${counts.all})`],
      ['abs', `ABS (${counts.abs})`],
      ['manager', `Challenges (${counts.manager})`],
      ['crew', `Reviews (${counts.crew})`],
      ['boundary', `Boundary Calls (${counts.boundary})`],
      ['live', `● Under Review (${counts.live})`],
      ['runrisk', `⚠️ Runs at Risk (${counts.runrisk})`],
    ];

    const wrap = UI.clear($('#feed-tabs'));
    tabs.forEach(([key, label]) => {
      const riskCls = key === 'runrisk' && counts.runrisk > 0 ? ' tab-run-risk' : '';
      wrap.appendChild(el('button', `tab ${filter === key ? 'tab-on' : ''}${riskCls}`, label, {
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
    if (filter === 'runrisk') return runsRemovableFromReview(entry.review) > 0;
    return entry.review.typeKey === filter;
  }

  /** Official matchup for a row/strip item. Prefers the stamped label. */
  function matchupFor(entry, game) {
    const stamped = entry && entry.matchupLabel;
    if (isUsableName(stamped) && !/undefined/i.test(stamped)) return stamped;
    if (game) return gameTeamsLabel(game, teamsById);
    return entry && entry.gamePk ? `Game ${entry.gamePk}` : 'AWY @ HOM';
  }

  /** One chatroom message for one review event. */
  function feedRow(entry) {
    const r = entry.review;
    const game = games.find((g) => g.gamePk === entry.gamePk) || null;
    const runsAtRisk = runsRemovableFromReview(r);
    const row = el('div', `feed-row feed-type-${r.typeKey} ${r.inProgress ? 'feed-row-live' : `feed-outcome-${r.outcome}`}${runsAtRisk > 0 ? ' feed-row-run-risk' : ''}`);
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
    const matchup = matchupFor(entry, game);
    const link = el('a', 'feed-game', '',
      { href: `game.html?gamePk=${entry.gamePk}`, title: `Open game — ${matchup}` });
    link.appendChild(el('span', 'feed-game-txt', matchup));
    if (game && game.linescore && game.linescore.teams) {
      const ls = game.linescore;
      link.appendChild(el('span', 'feed-game-score',
        `${ls.teams.away && ls.teams.away.runs != null ? ls.teams.away.runs : '–'}–${ls.teams.home && ls.teams.home.runs != null ? ls.teams.home.runs : '–'}`));
    }
    head.appendChild(link);
    head.appendChild(el('span', `chip-review-type chip-${r.typeKey}`, r.reviewType));
    // Challenging team: official abbreviation (from the /teams directory —
    // schedule objects have none), official full name on hover. Hidden rather
    // than guessed when the directory is unavailable.
    const dirTeam = r.teamId != null ? teamsById[r.teamId] : null;
    const teamAbbrev = r.teamAbbrev || (dirTeam && dirTeam.abbreviation) || null;
    const teamFullName = r.teamName || (dirTeam && dirTeam.name) || null;
    if (teamAbbrev) {
      const chip = el('span', 'feed-team', teamAbbrev);
      if (teamFullName) chip.title = teamFullName;
      head.appendChild(chip);
    }
    if (r.inningLabel) head.appendChild(el('span', 'feed-inn', r.inningLabel));
    head.appendChild(outcomePill(r));
    if (runsAtRisk > 0) {
      const badge = el('span', 'feed-run-risk-badge',
        `⚠️ ${runsAtRisk} ${runsAtRisk === 1 ? 'RUN' : 'RUNS'} AT RISK`);
      badge.title = `${runsAtRisk} ${runsAtRisk === 1 ? 'run' : 'runs'} credited on the reviewed play ` +
        'could come off the scoreboard if this review overturns the call. Not a prediction of the ruling.';
      head.appendChild(badge);
    }
    body.appendChild(head);

    const title = el('div', 'feed-reason', r.reason);
    body.appendChild(title);

    if (window.MLBReviews && window.MLBReviews.renderScoreImpact) {
      const scoreImpact = window.MLBReviews.renderScoreImpact(r, 'feed');
      if (scoreImpact) body.appendChild(scoreImpact);
    }

    const desc = el('div', 'feed-desc', r.description);
    body.appendChild(desc);

    if (window.MLBReviews && window.MLBReviews.absContextLines) {
      const absLines = window.MLBReviews.absContextLines(r);
      if (absLines.length) {
        const abs = el('div', 'feed-abs-meta');
        absLines.forEach((line) => abs.appendChild(el('span', 'feed-abs-line', line)));
        body.appendChild(abs);
      }
    }

    if ((r.batter && r.batter.fullName) || (r.pitcher && r.pitcher.fullName)) {
      const foot = el('div', 'feed-foot');
      if (r.batter && r.batter.fullName) foot.appendChild(el('span', 'feed-player', `Batter: ${r.batter.fullName}`));
      if (r.pitcher && r.pitcher.fullName) {
        foot.appendChild(el('span', 'feed-player',
          `Pitcher: ${r.pitcher.fullName}${r.pitchVelo ? ` (${r.pitchVelo} mph)` : ''}`));
      }
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

  function gameHasInProgress(gamePk) {
    let found = false;
    feedState.seen.forEach((entry) => {
      if (entry.gamePk === gamePk && entry.review && entry.review.inProgress) found = true;
    });
    return found;
  }

  function hasActiveReviewSignal() {
    let inFeed = false;
    feedState.seen.forEach((entry) => {
      if (entry.review && entry.review.inProgress) inFeed = true;
    });
    if (inFeed) return true;
    return games.some((g) => {
      const detailed = (g.status && g.status.detailedState) || '';
      return /challenge|review/i.test(detailed);
    });
  }

  function currentInterval() {
    const hasLive = games.some((g) => g.status && g.status.abstractGameState === 'Live');
    return pollIntervalMs({
      hasLive,
      hasActiveReview: hasActiveReviewSignal(),
      liveMs: LIVE_POLL_MS,
      reviewMs: REVIEW_POLL_MS,
      idleMs: IDLE_POLL_MS,
    });
  }

  function renderStatusLine() {
    const line = $('#status-line');
    if (!line) return;
    const interval = currentInterval() / 1000;
    line.textContent =
      `${games.length} game${games.length === 1 ? '' : 's'} · ` +
      `${feedState.order.length} review event${feedState.order.length === 1 ? '' : 's'} · ` +
      `updated ${new Date().toLocaleTimeString()} · refreshing every ${interval}s`;
  }

  function startCountdown(interval) {
    const node = $('#countdown');
    if (!node) return;
    clearInterval(countdownTimer);
    const tick = () => {
      const left = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
      node.textContent = UI.fmtCountdown ? UI.fmtCountdown(left) : `${left}s`;
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    clearInterval(countdownTimer);
    const node = $('#countdown');
    if (node) node.textContent = '';
  }

  function scheduleNext(overrideMs) {
    clearTimeout(pollTimer);
    const interval = overrideMs != null ? overrideMs : currentInterval();
    // Subtract the scan we just finished so the *cycle* is `interval`, not
    // scan + interval. First boot / hidden-tab park (no lastCycleStartedAt)
    // waits the full gap. Hidden must never subtract a stale scan or
    // waitAfterScan(interval, hugeElapsed) is 0 and the timer spins.
    const elapsed = lastCycleStartedAt ? Date.now() - lastCycleStartedAt : 0;
    const wait = overrideMs != null ? interval : waitAfterScan(interval, elapsed);
    nextRefreshAt = Date.now() + wait;
    pollTimer = setTimeout(() => {
      if (!document.hidden) load();
      else {
        lastCycleStartedAt = 0;
        scheduleNext();
      }
    }, wait);
    startCountdown(wait);
  }

  function syncUrl() {
    const url = new URL(window.location);
    url.searchParams.set('date', dateStr);
    window.history.replaceState({}, '', url);
  }

  /* ----------------------------------------------------------------- boot */

  window.ReplayFeed = {
    setFilter(f) { filter = f; renderFeed(); },
    refresh() { load(); },
    prevDay() { shiftDate(-1); syncUrl(); updateDateLabel(); load(); },
    nextDay() { shiftDate(1); syncUrl(); updateDateLabel(); load(); },
    today() { dateStr = todayStr(); syncUrl(); updateDateLabel(); resetFeed(); load(); },
    pickDate() {
      const d = $('#date-picker').value;
      if (d) { dateStr = d; syncUrl(); updateDateLabel(); resetFeed(); load(); }
    },
    toggleSound() { setSoundEnabled(!audioEnabled); },
    setSoundEnabled(enabled) { setSoundEnabled(enabled); },
    getSoundEnabled() { return audioEnabled; },
    playAlertSound() { playAlertSound(); },
    toggleNotify() { setNotifyEnabled(!notifyEnabled); },
    setNotifyEnabled(enabled) { setNotifyEnabled(enabled); },
    getNotifyEnabled() { return notifyEnabled; },
    playRunRiskAlertSound() { playRunRiskAlertSound(); },
    getRunsAtRisk() { return runRiskTotal(); },
    getRunRiskEvents() {
      return runRiskEntries().map((entry) => ({
        gamePk: entry.gamePk,
        key: buildEventKey(entry.gamePk, entry.review),
        runs: runsRemovableFromReview(entry.review),
        reviewType: entry.review.reviewType,
        matchup: matchupFor(entry, games.find((g) => g.gamePk === entry.gamePk) || null),
      }));
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const d = params.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) dateStr = d;
    updateDateLabel();
    updateSoundToggleUI();
    updateNotifyToggleUI();
    const refreshBtn = $('#refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => load());
    const soundBtn = $('#sound-toggle-btn');
    if (soundBtn) {
      soundBtn.addEventListener('click', () => {
        // User gesture required for AudioContext resume
        setSoundEnabled(!audioEnabled);
      });
    }
    const notifyBtn = $('#notify-toggle-btn');
    if (notifyBtn) {
      notifyBtn.addEventListener('click', () => {
        // User gesture required for Notification.requestPermission()
        setNotifyEnabled(!notifyEnabled);
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
      else stopPolling();
    });
    load();
  });

  /* Node test export (pure helpers only). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildEventKey, mergeFeedEvents, reconcileScoreImpact, reviewChanged,
      sortFeedEntries, gameTeamsLabel,
      isUsableName, officialTeamName, gameSideTeam,
      pollIntervalMs, waitAfterScan, reviewFetchPriority, mapPool,
      shouldAlertForReview,
      runsRemovableFromReview, shouldRunRiskAlert, diffRunRiskKeys,
    };
  }
})();
