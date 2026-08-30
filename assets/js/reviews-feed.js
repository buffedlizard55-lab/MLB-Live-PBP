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
 * Whether a feed entry belongs in the "All" section of the Replay Feed.
 *
 * Requirement: All shows manager challenges, crew-chief/umpire reviews,
 * boundary calls, "under review" status entries and run-at-risk entries —
 * but NOT ABS pitch challenges. ABS stays fully tracked (its own "ABS"
 * filter tab, the "ABS Challenges" stat, and the official challenges-
 * remaining counters) but lives in its own section, and it stays silent
 * (shouldAlertForReview() above).
 *
 * `typeKey === 'abs'` is produced ONLY from the official StatsAPI code
 * "MJ" or explicit ABS text in the official play descriptions
 * (normalizeType in reviews.js — see docs/verification-report.md §2).
 * So this hides exactly the official ABS pitch-challenge category and
 * nothing else.
 *
 * Unknown / malformed entries fail open (visible in All): an unrecognized
 * event must never be silently hidden. Pure function — no DOM.
 */
function visibleInAllFeed(review) {
  return !review || review.typeKey !== 'abs';
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
 * Whether a review qualifies for the run-at-risk alert (a run already on the
 * scoreboard could be removed). Deliberately independent of
 * shouldAlertForReview(): that gate skips routine ABS pitch challenges, but
 * this one is driven purely by whether runs are tied to the reviewed event, so
 * every review type — manager challenge, crew chief/umpire review, boundary
 * call, "under review" status entry, ABS — is eligible.
 *
 * Both alerts play the same raindrop chime; what this gate additionally drives
 * is the banner, row badge, stat, filter tab and desktop notification.
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

/* --------------------------------------------- challenges-remaining tracker */

/** A non-negative finite number, else null. Counters are never invented. */
function readCountNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Normalize one game's official challenge counters into
 *   { manager: { away/home: { used, remaining } } | null,
 *     abs:     { away/home: { usedSuccessful, usedFailed, remaining } } | null }
 *
 * Sources (both shapes verified live against statsapi.mlb.com, 2026-08-28):
 *   managerSource — the `review` object from the schedule's hydrate=review OR
 *     from feed/live gameData.review; identical shape either way, e.g.
 *     {"hasChallenges":true,"away":{"used":1,"remaining":0},"home":{"used":2,"remaining":0}}
 *     (game 824879). These are the MANAGER replay-challenge counters only.
 *   absSource — feed/live gameData.absChallenges, e.g.
 *     {"hasChallenges":true,"away":{"usedSuccessful":2,"usedFailed":0,"remaining":2},
 *      "home":{"usedSuccessful":3,"usedFailed":0,"remaining":2}} (game 824638, live).
 *     The SCHEDULE endpoint does NOT expose absChallenges (verified 2026-08-28),
 *     and pre-ABS seasons have no absChallenges at all (verified 2025 game
 *     776162) — in both cases `abs` stays null; it is never defaulted to 0.
 *
 * Missing / malformed numbers stay null. Returns null when neither source
 * yields a single usable counter.
 */
function normalizeChallengeCounts(managerSource, absSource) {
  const readSide = (src, which, keys) => {
    const s = src && src[which];
    if (!s || typeof s !== 'object') return null;
    const out = {};
    let any = false;
    keys.forEach((k) => {
      const v = readCountNumber(s[k]);
      out[k] = v;
      if (v != null) any = true;
    });
    return any ? out : null;
  };
  const manager = managerSource ? {
    away: readSide(managerSource, 'away', ['used', 'remaining']),
    home: readSide(managerSource, 'home', ['used', 'remaining']),
  } : null;
  const abs = absSource ? {
    away: readSide(absSource, 'away', ['usedSuccessful', 'usedFailed', 'remaining']),
    home: readSide(absSource, 'home', ['usedSuccessful', 'usedFailed', 'remaining']),
  } : null;
  const managerOk = manager && (manager.away || manager.home) ? manager : null;
  const absOk = abs && (abs.away || abs.home) ? abs : null;
  if (!managerOk && !absOk) return null;
  return { manager: managerOk, abs: absOk };
}

/**
 * Compare two successive counter snapshots of the SAME game and list
 * irregularities worth flagging for review.
 *
 * Deliberately minimal: the only rule encoded is that a `used*` counter can
 * never DECREASE within one game (a spent challenge cannot be un-spent).
 * `remaining` is never flagged in either direction, because it can
 * legitimately rise (the official payload keeps `remaining` on a successful
 * manager challenge — verified game 822694 away used:1 remaining:1 — and ABS
 * challenges are retained when successful / regained in extra innings, e.g.
 * live game 824638 away usedSuccessful:2 remaining:2). No MLB rulebook math
 * is asserted beyond monotonicity; everything else is displayed as-is.
 *
 * Returns an array of human-readable issue strings (empty = no irregularity).
 */
function challengeCountIrregularities(prev, next) {
  const issues = [];
  if (!prev || !next) return issues;
  const cmp = (label, a, b, keys) => {
    if (!a || !b) return;
    keys.forEach((k) => {
      if (a[k] != null && b[k] != null && b[k] < a[k]) {
        issues.push(`${label}.${k} decreased ${a[k]} → ${b[k]}`);
      }
    });
  };
  ['away', 'home'].forEach((side) => {
    cmp(`manager.${side}`, prev.manager && prev.manager[side],
      next.manager && next.manager[side], ['used']);
    cmp(`abs.${side}`, prev.abs && prev.abs[side],
      next.abs && next.abs[side], ['usedSuccessful', 'usedFailed']);
  });
  return issues;
}

/** Which side of the game a teamId plays for ('away' | 'home' | null). */
function teamSideInGame(game, teamId) {
  if (teamId == null) return null;
  const away = gameSideTeam(game, 'away');
  if (away && away.id === teamId) return 'away';
  const home = gameSideTeam(game, 'home');
  if (home && home.id === teamId) return 'home';
  return null;
}

/**
 * One team's remaining-challenge line for the challenge type the feed row is
 * about. Only the two types that actually consume a per-team counter are
 * rendered ('abs' → absChallenges, 'manager' → review); crew-chief/umpire/
 * boundary reviews are not charged to a team and return null. Returns null
 * whenever the official `remaining` counter is absent — a missing counter is
 * never printed as 0.
 */
function teamChallengeLine(counts, side, teamLabel, typeKey, tense) {
  if (!counts || (side !== 'away' && side !== 'home')) return null;
  const label = isUsableName(teamLabel) ? teamLabel : (side === 'away' ? 'Away' : 'Home');
  const suffix = tense ? ` ${tense}` : '';
  if (typeKey === 'abs') {
    const c = counts.abs && counts.abs[side];
    if (!c || c.remaining == null) return null;
    const used = (c.usedSuccessful != null && c.usedFailed != null)
      ? ` (${c.usedSuccessful} successful · ${c.usedFailed} failed)`
      : '';
    return `${label}: ${c.remaining} ABS challenge${c.remaining === 1 ? '' : 's'} left${suffix}${used}`;
  }
  if (typeKey === 'manager') {
    const c = counts.manager && counts.manager[side];
    if (!c || c.remaining == null) return null;
    const used = c.used != null ? ` (${c.used} used)` : '';
    return `${label}: ${c.remaining} manager challenge${c.remaining === 1 ? '' : 's'} left${suffix}${used}`;
  }
  return null;
}

/**
 * Compact both-teams summary, e.g.
 *   "Challenges left: CIN 1 MGR · 2 ABS — CHC 1 MGR · 2 ABS"
 * Sides/counters that are unavailable are simply omitted (never zero-filled);
 * returns null when nothing official is available at all.
 */
function gameChallengeLine(counts, labels, prefix) {
  if (!counts) return null;
  const names = labels || {};
  const sideBits = (side) => {
    const bits = [];
    const m = counts.manager && counts.manager[side];
    if (m && m.remaining != null) bits.push(`${m.remaining} MGR`);
    const a = counts.abs && counts.abs[side];
    if (a && a.remaining != null) bits.push(`${a.remaining} ABS`);
    if (!bits.length) return null;
    const name = isUsableName(names[side]) ? names[side] : (side === 'away' ? 'Away' : 'Home');
    return `${name} ${bits.join(' · ')}`;
  };
  const away = sideBits('away');
  const home = sideBits('home');
  if (!away && !home) return null;
  return `${prefix || 'Challenges left'}: ${[away, home].filter(Boolean).join(' — ')}`;
}

/* ------------------------------------------------------------ page logic */

(() => {
  // Cadence is the gap between poll STARTS (scan duration is subtracted in
  // waitAfterScan). The StatsAPI is pull-only — a shorter poll only reduces
  // how long a landed review sits unseen. Hidden tabs still pause.
  //   live games          : 500ms
  //   a review in flight  : 250ms (outcome flips are what the feed is for;
  //                          in-review games are fetched first, so the flip
  //                          lands ~1 request after poll start)
  //   no live games       : 5s
  const LIVE_POLL_MS = 500;
  const REVIEW_POLL_MS = 250;
  const IDLE_POLL_MS = 5000;
  // playByPlay is one request per live / unsettled-final game. 30 at a time
  // (the slate is ~15-17 games) keeps a full scan to ONE wave: a single
  // request round-trip instead of two, so every poll — and the review
  // outcome in particular — lands sooner. Same host (HTTP/2), same
  // CORS-open endpoint.
  const FETCH_CONCURRENCY = 30;

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
  // gamePk -> { counts: normalizeChallengeCounts(...), issues: [], updatedAt }
  // Official per-team challenge counters (manager `review` + `absChallenges`)
  // for every game that has at least one feed event. Counters are read from
  // the payloads only — never derived by counting feed rows ourselves.
  const challengeCounts = new Map();

  // --- Audio alert state (gentle raindrop chime for challenges/reviews/boundary, not ABS) ---
  let isFirstLoad = true;
  let pendingAlertableCount = 0;
  let audioEnabled = false;
  let audioContext = null;
  let lastAlertAt = 0;

  // --- Run-at-risk state (a run already on the scoreboard could be removed by
  // an active review). It plays the SAME raindrop chime as an ordinary review
  // and shares its cooldown, but it is tracked separately because it fires for
  // every review type (ABS included), fires on first load, and drives the
  // banner / badge / stat / filter tab and the optional desktop notification.
  // `alertedRunRiskKeys` holds the event keys that have already alerted so a
  // still-running review does not re-alert on every fast (in-review) poll; a
  // key is dropped the moment the review resolves or stops being risky, so a
  // genuinely new review on the same play can alert again.
  const alertedRunRiskKeys = new Set();
  let pendingRunRiskAlerts = [];
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
    challengeCounts.clear();
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
    playRaindropChime();
  }

  /**
   * Build and fire the raindrop-chime graph. No gating of its own — callers
   * own the enable check and the cooldown. Kept separate so there is exactly
   * ONE alert sound implementation in the file: the ordinary review chime and
   * the run-at-risk alert are the same sound, and cannot drift apart.
   */
  function playRaindropChime() {
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
   * Run-at-risk alert: a run that is already on the scoreboard could be taken
   * off by an active review.
   *
   * By request this plays the SAME gentle raindrop chime as an ordinary new
   * review — one alert sound for the whole page. It is not a separate voice,
   * it literally calls the same graph builder, so the two can never drift.
   *
   * The urgency is carried by everything else instead: the persistent red
   * run-at-risk banner, the row badge and glow, the "Runs at Risk" stat and
   * filter tab, and the optional desktop notification.
   *
   * Cooldown note: this deliberately shares `lastAlertAt` with playAlertSound()
   * rather than keeping its own timer. Now that both are the same sound, two
   * independent cooldowns would just chime twice on top of itself.
   */
  function playRunRiskAlertSound() {
    playAlertSound();
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
      btn.title = 'Alert sound ON — gentle raindrop chime for new challenges/reviews/boundary calls (not ABS), and the same chime whenever an active review could take a run OFF the scoreboard (any review type, ABS included). Click to mute.';
    } else {
      btn.textContent = '🔇 Sound Off';
      btn.classList.remove('btn-sound-on');
      btn.classList.add('btn-ghost');
      btn.title = 'Alert sound OFF — click to enable the gentle raindrop chime for new challenges/reviews/boundary calls and for run-at-risk reviews';
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
    // Notification.requestPermission() has two generations of API: the legacy
    // callback form and the modern promise form. Current browsers honour BOTH
    // when a callback is passed, so settle exactly once rather than writing
    // localStorage and re-rendering the button twice.
    let settled = false;
    const settle = (permission) => {
      if (settled) return;
      settled = true;
      notifyEnabled = permission === 'granted';
      persist();
    };
    try {
      const result = Notification.requestPermission(settle);
      if (result && typeof result.then === 'function') {
        result.then(settle).catch(() => settle('denied'));
      }
    } catch (_) {
      settle('denied');
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

      // Manager-challenge counters ride along on every schedule poll
      // (hydrate=review — shape verified live 2026-08-28: every game carries
      // review.away/home.used/remaining). ABS counters are NOT in the
      // schedule; ingestGame fetches them per game that has feed events.
      games.forEach((g) => {
        if (g && g.gamePk != null && g.review) updateGameCounts(g.gamePk, g.review, null, false);
      });

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
      // and so one poll produces at most one alert no matter how many games
      // report at the same instant.
      syncRunRiskTracking();

      // Alerting. A newly at-risk run takes priority: it is the one case that
      // also raises a desktop notification, and it fires on the very first
      // load too (only a still-ACTIVE review can put a run at risk, so there
      // is no backlog of historical events to blast through). Both paths play
      // the same raindrop chime, and the if/else guarantees at most one per
      // poll so the chime is never triggered twice over itself.
      if (pendingRunRiskAlerts.length) {
        playRunRiskAlertSound();
        notifyRunRisk(pendingRunRiskAlerts);
      } else if (!isFirstLoad && pendingAlertableCount > 0) {
        // This poll discovered new non-ABS events and it is not the very first
        // load (initial page population).
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

  /**
   * Merge freshly observed official counters into the per-game tracker.
   * A poll that carries only one source (schedule → manager only; feed/live →
   * both) must not erase the other source's last observed values, so the two
   * halves are retained independently. Any irregularity (a used-counter going
   * down mid-game) is recorded once and kept visible for review.
   */
  function updateGameCounts(gamePk, managerSource, absSource, isFeedLive) {
    const prev = challengeCounts.get(gamePk) || null;
    // The schedule's review hydration and feed/live's gameData.review carry
    // the same counters, but the schedule can lag behind the live feed. Once
    // feed/live manager counters have been observed for a game, a
    // schedule-only poll may not overwrite them (or a stale cache would raise
    // a false "counter decreased" flag).
    let effectiveManager = managerSource;
    if (!isFeedLive && prev && prev.managerFromFeedLive) effectiveManager = null;
    const fresh = normalizeChallengeCounts(effectiveManager, absSource);
    if (!fresh) return;
    const merged = {
      manager: fresh.manager || (prev && prev.counts && prev.counts.manager) || null,
      abs: fresh.abs || (prev && prev.counts && prev.counts.abs) || null,
    };
    const issues = prev ? challengeCountIrregularities(prev.counts, merged) : [];
    const allIssues = prev && prev.issues ? [...prev.issues] : [];
    issues.forEach((issue) => { if (!allIssues.includes(issue)) allIssues.push(issue); });
    if (issues.length) {
      console.warn(`challenge counters irregularity (game ${gamePk}) — flagged for review:`, issues);
    }
    challengeCounts.set(gamePk, {
      counts: merged,
      issues: allIssues,
      updatedAt: Date.now(),
      managerFromFeedLive: (isFeedLive && !!fresh.manager) ||
        !!(prev && prev.managerFromFeedLive),
      absAttempted: isFeedLive || !!(prev && prev.absAttempted),
    });
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

    // Official challenges-remaining counters. The schedule already supplied
    // the manager `review` half; the ABS half only lives in feed/live's
    // gameData.absChallenges (verified 2026-08-28: absent from the schedule,
    // absent entirely in pre-ABS seasons). One tiny fields-projected request
    // per game, and only for games that actually have feed events — a game
    // with no challenges/reviews has nothing to annotate. Counters only move
    // when a challenge/review lands or resolves (both are feed-event changes),
    // so re-fetch only when this game's events changed or counters were never
    // captured; the 1–2s live cadence is not doubled for a quiet game.
    const hasEntries = [...feedState.seen.values()].some((e) => e.gamePk === gamePk);
    const eventsChanged = result.added.length || result.updated.length || result.ended.length;
    const tracked = challengeCounts.get(gamePk);
    const needsCounts = hasEntries &&
      (eventsChanged || !tracked || !tracked.absAttempted);
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
    // The review row itself is the update the user is waiting for — paint it
    // NOW, before any side-fetch. The challenges-remaining counters that
    // accompany a changed event are a non-blocking side-fetch: merging them
    // earlier would cost one extra request round-trip on exactly the poll
    // where the outcome flipped. The tracker merges as soon as the response
    // lands; the next cycle re-renders the row with fresh counters.
    if (result.added.length || result.updated.length || result.ended.length) {
      renderFeedUpdates(result);
    }
    if (needsCounts && MLB.getChallengeCounts) {
      MLB.getChallengeCounts(gamePk)
        .then((countsFeed) => {
          const gd = (countsFeed && countsFeed.gameData) || {};
          updateGameCounts(gamePk, gd.review || null, gd.absChallenges || null, true);
        })
        .catch((countErr) => {
          // Keep the last observed counters; never zero-fill on a failed poll.
          console.warn(`challenge counters unavailable this poll (game ${gamePk})`, countErr);
        });
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
    // "Events" counts the All section: every review category EXCEPT ABS
    // pitch challenges, which have their own stat (and their own tab)
    // right next to it. The remaining outcome/status stats are page-wide
    // trackers and keep counting ABS entries too — ABS is still tracked.
    wrap.appendChild(stat('Events', entries.filter((e) => visibleInAllFeed(e.review)).length));
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
        'Counted only from scoring movements the official payload ties to the reviewed event. ' +
        'Not a prediction of the ruling.';
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
      // Current official challenges-remaining for the game under review.
      const tracked = challengeCounts.get(gamePk);
      const countsLine = tracked
        ? gameChallengeLine(tracked.counts, gameSideLabels(g), 'Challenges left')
        : null;
      if (countsLine) {
        item.appendChild(el('span', 'feed-active-challenges', countsLine));
      }
      bar.appendChild(item);
    });
    wrap.appendChild(bar);
  }

  /**
   * Top-of-page banner: every game where an active review could take a run
   * back off the scoreboard. This is the persistent visual half of the "alert
   * me ASAP" requirement — the chime fires once, this stays up for as long as
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
    head.appendChild(el('span', 'run-risk-icon', '⚠️'));
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
      // "All" shows every category EXCEPT ABS pitch challenges, so its
      // tab count must match what that section actually renders. ABS
      // entries are still tracked and counted on their own tab below.
      all: entries.filter((e) => visibleInAllFeed(e.review)).length,
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
    // The All section shows every category EXCEPT ABS pitch challenges:
    // challenges, reviews, boundary calls, under review, runs at risk.
    // ABS entries stay tracked in the feed state — they render under the
    // "ABS" tab (and wherever else their category applies: the Under
    // Review tab, active strip, run-at-risk surfaces).
    if (filter === 'all') return visibleInAllFeed(entry && entry.review);
    if (filter === 'live') return entry.review.inProgress;
    if (filter === 'runrisk') return runsRemovableFromReview(entry.review) > 0;
    return entry.review.typeKey === filter;
  }

  /**
   * Short official labels for both sides of a game: the /teams directory
   * abbreviation when available, else the official full name from the
   * schedule, else Away/Home. Nothing is fabricated from a name.
   */
  function gameSideLabels(game) {
    const label = (side) => {
      const t = gameSideTeam(game, side);
      if (!t) return null;
      const dir = t.id != null ? teamsById[t.id] : null;
      if (dir && isUsableName(dir.abbreviation)) return dir.abbreviation;
      if (isUsableName(t.abbreviation)) return t.abbreviation;
      return officialTeamName(t, teamsById, null);
    };
    return { away: label('away'), home: label('home') };
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

    // Challenges-remaining tracker. Rendered only for the two review types
    // that are charged to a team's official counter (ABS pitch challenges →
    // gameData.absChallenges; manager challenges → the `review` object), and
    // only from counters actually observed in the payloads — a missing
    // counter renders nothing, never 0. The counters are the game's CURRENT
    // official values (they move as later challenges happen), which is why
    // the line says "now".
    const tracked = challengeCounts.get(entry.gamePk);
    if (tracked && (r.typeKey === 'abs' || r.typeKey === 'manager')) {
      const side = game ? teamSideInGame(game, r.teamId) : null;
      const line = teamChallengeLine(tracked.counts, side, teamAbbrev || teamFullName, r.typeKey, 'now');
      const both = gameChallengeLine(tracked.counts, gameSideLabels(game), 'Challenges left now');
      const text = line || both;
      if (text) {
        const meta = el('div', 'feed-challenges');
        meta.appendChild(el('span', 'feed-challenges-line', text));
        if (line && both) meta.title = both;
        body.appendChild(meta);
      }
      if (tracked.issues && tracked.issues.length) {
        const flag = el('div', 'feed-challenges feed-challenges-flag',
          `⚠️ Counter irregularity flagged for review: ${tracked.issues.join('; ')}`);
        flag.title = 'The official used-challenge counter for this game moved backwards between ' +
          'polls, which should be impossible within one game. The raw observed values are shown ' +
          'unmodified — nothing is corrected or guessed.';
        body.appendChild(flag);
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
      shouldAlertForReview, visibleInAllFeed,
      runsRemovableFromReview, shouldRunRiskAlert, diffRunRiskKeys,
      normalizeChallengeCounts, challengeCountIrregularities,
      teamSideInGame, teamChallengeLine, gameChallengeLine,
    };
  }
})();
