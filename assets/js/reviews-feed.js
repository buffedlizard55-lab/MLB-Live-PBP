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
    previousReview.resolvedDescription !== nextReview.resolvedDescription ||
    JSON.stringify(previousReview.scoreImpact || null) !== JSON.stringify(nextReview.scoreImpact || null);
}

  /**
   * Transition an official-scorer-pending entry to its observed RESOLUTION.
   * Called when the pending marker disappears from the payload: the scorer has
   * ruled, so the play now carries its final hit/error in the game feed. We
   * keep the observed pending row (never delete a tracked event) and mark it
   * resolved. The final ruling IS read from the resolved play's result
   * description (the official text describing hit/error/fielder's choice) so
   * both the pending state and the actual ruling are shown. The resolved
   * description comes from play.result.description of the same at-bat,
   * captured when the marker clears.
   *
   * @param {Object} review - the pending review entry
   * @param {Object} resolvedPlay - the play object from the current payload
   *                                that now has the final result (no pending marker)
   */
  function completePendingScoringReview(review, resolvedPlay) {
    if (!review) return review;
    // Capture the resolved play's official description if available.
    // This is the actual ruling text (e.g., "reaches on a fielder's choice")
    // from the official StatsAPI payload, never guessed or fabricated.
    const resolvedDesc = resolvedPlay && resolvedPlay.result
      ? (resolvedPlay.result.description || resolvedPlay.result.event || null)
      : null;
    // Preserve any existing resolvedDescription if we already captured it
    // (e.g., from a previous poll), so we don't lose the ruling text.
    const existingResolvedDesc = review.resolvedDescription || null;
    return {
      ...review,
      inProgress: false,
      outcome: 'resolved',
      outcomeLabel: 'Ruling Complete',
      resolvedWhenMarkerCleared: true,
      // Store the official resolved description for display.
      // The original pending description remains in `description`; this new
      // field carries what the scorer actually ruled.
      resolvedDescription: existingResolvedDesc || resolvedDesc,
    };
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
function mergeFeedEvents(state, gamePk, reviews, playsByAtBatIndex) {
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
    if (currentKeys.has(key)) return;

    // Official-scorer pending: the marker disappears the moment the scorer
    // rules (the play then carries its final hit/error). Keep the observed
    // row and mark it resolved in place — a tracked pending event must never
    // vanish from the feed, and "resolved" is observed, not invented. The
    // row is retained for as long as this date's feed exists, exactly like
    // every other resolved review row.
    const prev = seen.get(key);
    const pendingReview = prev && prev.review;
    if (pendingReview && pendingReview.officialScoringPending === true) {
      if (!pendingReview.resolvedWhenMarkerCleared) {
        // Look up the resolved play by atBatIndex to capture the actual ruling.
        const resolvedPlay = playsByAtBatIndex && pendingReview.atBatIndex != null
          ? playsByAtBatIndex.get(String(pendingReview.atBatIndex))
          : null;
        prev.review = completePendingScoringReview(pendingReview, resolvedPlay);
        prev.lastSeen = now;
        updated.push(prev);
      }
      return;
    }
    // Official scoring changes are NOT produced by extractReviews() — they
    // come from mergeScoringChanges() and live in feedState permanently (a
    // tracked rescore must never vanish just because the review extractor
    // does not emit them). Leave them untouched here; their lifecycle is
    // owned entirely by mergeScoringChanges().
    if (pendingReview && pendingReview.typeKey === 'scoring_change') return;

    seen.delete(key);
    const orderIdx = order.indexOf(key);
    if (orderIdx >= 0) order.splice(orderIdx, 1);
    ended.push(key);
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
 *   0 — the official status already says challenge/review, or we already have
 *       an in-progress entry for that game (catch the outcome first)
 *   1 — other live games
 *   2 — finals / everything else
 * Uses the registry-based isReviewStatusCode() (statusCode/codedGameState)
 * plus the boolean the caller already computed from feed state — no guessed
 * fields, and "Instant Replay" (crew-chief, IH) now counts.
 */
function reviewFetchPriority(game, hasInProgress) {
  if (hasInProgress || isReviewStatusCode(game && game.status)) return 0;
  const state = game && game.status && game.status.abstractGameState;
  if (state === 'Live') return 1;
  return 2;
}

/**
 * Is this official game `status` a review/challenge state?
 *
 * Deliberate self-contained copy of MLBReviews.isReviewGameStatus() — the
 * same "pure helper layer needs no other module loaded" pattern this file
 * already uses for runsRemovableFromReview(). tools/review-status-test.mjs
 * §3 loads both modules and asserts this copy, plus the game.js /
 * scoreboard.js / ui.js copies, agree with MLBReviews on every entry of the
 * official registry (and on every non-review state), so they cannot drift.
 *
 * Authority: GET https://statsapi.mlb.com/api/v1/gameStatus (verified live
 * 2026-09-02). Every review state is either
 *   statusCode MH/MA/MF/… (codedGameState "M", manager + player challenges),
 *   statusCode NH/NA/NF/… (codedGameState "N", umpire reviews), or
 *   statusCode "IH"       (codedGameState "I", "Instant Replay").
 * codedGameState "M"/"N" are used by NO other state, and "I" alone is plain
 * "In Progress", so it must not match. The text test is the last-resort
 * fallback for a payload that carries only detailedState, and it now includes
 * "instant replay" — the verbatim registry wording for IH, which the old
 * /challenge|review/i test missed entirely.
 */
function isReviewStatusCode(status) {
  if (!status || typeof status !== 'object') return false;
  const code = String(status.statusCode || '').trim().toUpperCase();
  if (/^[MN][A-Z]$/.test(code) || code === 'IH') return true;
  const coded = String(status.codedGameState || '').trim().toUpperCase();
  if (coded === 'M' || coded === 'N') return true;
  return /challenge|review|instant replay/i.test(String(status.detailedState || ''));
}

/**
 * Diff one review-status sweep against the previous one. Pure: reads
 * `prevCodes` (Map gamePk -> statusCode seen last sweep) and `nextGames`
 * (the games array from MLB.getReviewStatus), returns the games whose REVIEW
 * state changed plus the code map for the next call.
 *
 * A game is reported when it
 *   - enters a review state (the event the feed exists to surface),
 *   - leaves one (the ruling landed — the outcome), or
 *   - moves between two different review codes (a new challenge on the same
 *     game, e.g. MA "Tag play" -> MF "Close play at 1st"): that is a second
 *     review, not a repeat of the first.
 * Everything else (In Progress -> Delayed, Pre-Game -> In Progress, a game
 * disappearing from the slate) is not a review signal and is not reported —
 * but its code is still tracked so the next sweep compares correctly.
 */
function reviewStatusFlips(prevCodes, nextGames) {
  const prev = prevCodes instanceof Map ? prevCodes : new Map();
  const codes = new Map();
  const changed = [];
  (Array.isArray(nextGames) ? nextGames : []).forEach((game) => {
    if (!game || game.gamePk == null) return;
    const status = game.status || {};
    const code = String(status.statusCode || '').trim().toUpperCase() || null;
    const pk = game.gamePk;
    codes.set(pk, code);
    const isReview = isReviewStatusCode(status);
    const prevCode = prev.has(pk) ? prev.get(pk) : undefined;
    // undefined = never seen: a game that is ALREADY under review on the very
    // first sweep is a real, reportable event (the page may have been opened
    // mid-review), so it is not suppressed.
    const wasReview = prevCode !== undefined &&
      isReviewStatusCode({ statusCode: prevCode });
    if (isReview === wasReview && (!isReview || code === prevCode)) return;
    changed.push({
      gamePk: pk,
      statusCode: code,
      codedGameState: String(status.codedGameState || '').trim().toUpperCase() || null,
      detailedState: status.detailedState || null,
      reason: typeof status.reason === 'string' && status.reason.trim()
        ? status.reason.trim() : null,
      review: isReview,
      started: isReview && !wasReview,
      ended: !isReview && wasReview,
    });
  });
  return { changed, codes };
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
 * Requirement: challenges, reviews, boundary calls, official-scorer pending
 * rulings AND official scoring changes, but NOT ABS. ABS is typeKey 'abs'.
 * Everything else (manager, crew_chief, boundary, review, rules, umpire,
 * pending_scoring, scoring_change) qualifies — an official-scorer pending
 * ruling is exactly what the user wants to hear about immediately, and so is
 * a hit/error/out reclassification observed between polls. Pure — no DOM.
 */
function shouldAlertForReview(review) {
  if (!review || typeof review.typeKey !== 'string') return false;
  return review.typeKey !== 'abs';
}

/**
 * Whether a feed entry belongs in the "All" section of the Replay Feed.
 *
 * Requirement: All shows manager challenges, crew-chief/umpire reviews,
 * boundary calls, "under review" status entries, run-at-risk entries AND
 * official scoring changes — but NOT ABS pitch challenges. ABS stays fully
 * tracked (its own "ABS" filter tab, the "ABS Challenges" stat, and the
 * official challenges-remaining counters) but lives in its own section, and
 * it stays silent (shouldAlertForReview() above). Scoring changes show up in
 * the All feed (by explicit request) and in their own "Scoring Changes" tab.
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
  // Official-scorer pending rulings decide how to CHARGE the play (hit /
  // error / fielder's choice, earned vs. unearned runs) — they never take a
  // run off the scoreboard, so nothing is at risk. The ruling is the API's
  // own os_ruling_pending_primary / os_ruling_pending_prior event type
  // (description "Official Scorer Ruling Pending", GET /api/v1/eventTypes).
  if (review.typeKey === 'pending_scoring') return 0;
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

/* ================================================== official scoring changes
 *
 * OFFICIAL SCORING-CHANGE TRACKER (hit ↔ error, single ↔ double, out ↔ hit,
 * hit → fielder's choice + error, …).
 *
 * HOW A SCORING CHANGE IS KNOWABLE AT ALL
 *   The StatsAPI carries NO marker for a rescored play. A play changed by the
 *   official scorer (or by the Elias Sports Bureau, or after a player/club
 *   review — all are "Official Scoring changes" per MLB's own log at
 *   https://www.mlb.com/official-information/scoring-changes) is simply
 *   REWRITTEN in place: `result.eventType` / `result.event` /
 *   `result.description` / `runners[]` change, and nothing flags the play as
 *   "changed" (verified live 2026-09-04 against two REAL rescored plays:
 *   game 822766 atBatIndex 36 — official change #230, "originally ruled a
 *   double … changed to a single", now reads eventType "single"; game 822769
 *   atBatIndex 59 — official change #232, "originally ruled a base hit …
 *   changed to a fielder's choice and error", now reads eventType
 *   "fielders_choice" plus a runners[] movement with details.eventType
 *   "error"). The ONLY way to observe both the initial call and the final
 *   ruling is to snapshot every completed play on each poll and diff — which
 *   is exactly what this tracker does against the playByPlay scan this page
 *   already runs every 250–500ms.
 *
 * WHAT IS COMPARED (the "scoring signature")
 *   Only fields the official payload uses to classify the play:
 *     result.eventType / result.isOut / count.outs
 *     runner-level error movements (runners[].details.eventType)
 *     runner movement endpoints (originBase → end / outBase)
 *   Description, RBI and score are ANNOTATIONS: if they change without a
 *   signature change (a retroactive wording/RBI/score fix) the tracker does
 *   not mint a hit/error/out row — it flags the play as an IRREGULARITY for
 *   review, because something official changed but not the play's
 *   classification.
 *
 * WHAT IS NOT TRACKABLE (stated honestly, never invented)
 *   - A change that landed before this page observed the play (page opened
 *     after the change, or the change was published while the tab was
 *     closed): there is no initial call on record, so there is no row. The
 *     official log above remains the only source for those.
 *   - A play whose FIRST observed result was the official-scorer PENDING
 *     marker (os_ruling_pending_primary / os_ruling_pending_prior) or an
 *     unclassified result: there is no initial hit/error/out call to track —
 *     that flow is already covered by the ⚖️ Scoring Pending feature.
 * ==========================================================================*/

const SCORING_CHANGE_TYPE_KEY = 'scoring_change';
const SCORING_CHANGE_LABEL = 'Scoring Change';

/**
 * Official StatsAPI event-type registry subsets — GET /api/v1/eventTypes
 * (statsapi.mlb.com, fetched live 2026-09-04).
 *
 *   `hit: true` is set on EXACTLY these four codes (all plateAppearance):
 *     single "Single", double "Double", triple "Triple", home_run "Home Run".
 *   The ONLY plate-appearance error code is field_error "Field Error".
 *   The ONLY other error code is error "Error" (baseRunningEvent: true) —
 *     it appears in runners[].details.eventType when a runner's advance or
 *     putout is charged as an error (verified live 2026-09-04: game 824796
 *     atBatIndex 56, "advances to 2nd, on a throwing error …" carries a
 *     runners[] movement with details.eventType "error").
 *   Both os_ruling_pending_* codes mean "no official ruling yet".
 *
 * Everything else (field_out, force_out, strikeout, fielders_choice,
 * sac_fly, walk, …) is classified by the payload's own result.isOut flag and
 * labelled with the payload's own result.event text — never by paraphrase.
 */
const SCORING_HIT_EVENT_TYPES = new Set(['single', 'double', 'triple', 'home_run']);
const SCORING_PA_ERROR_EVENT_TYPES = new Set(['field_error']);
const SCORING_RUNNER_ERROR_EVENT_TYPES = new Set(['error', 'field_error']);
// Self-contained copy of the official pending codes (see reviews.js
// OFFICIAL_SCORER_PENDING_TYPES — registry-verified; tools/scoring-change-test.mjs
// asserts both copies agree so they cannot drift).
const SCORING_PENDING_EVENT_TYPES = new Set([
  'os_ruling_pending_primary',
  'os_ruling_pending_prior',
]);

/**
 * One observed scoring snapshot of a COMPLETED play, read only from fields
 * verified in the live playByPlay payload (2026-09-04):
 *   play.about.atBatIndex / .isComplete / .hasReview / .endTime / .inning /
 *     .halfInning, play.result.eventType / .event / .description / .isOut /
 *     .rbi / .awayScore / .homeScore, play.count.outs, play.runners[].details
 *     .eventType, play.runners[].movement.{originBase,end,outBase,isOut}.
 * Returns null when the play has no official classification to diff yet:
 * not complete, no result.eventType, or the official-scorer PENDING marker.
 * Pure; never throws.
 */
function buildScoringSnapshot(play) {
  if (!play || typeof play !== 'object') return null;
  const about = play.about || {};
  const result = play.result || {};
  const idx = about.atBatIndex;
  if (idx == null) return null;
  if (about.isComplete !== true) return null; // at-bat still in progress
  const eventType = typeof result.eventType === 'string' ? result.eventType : '';
  if (!eventType) return null; // nothing officially classified yet
  if (SCORING_PENDING_EVENT_TYPES.has(eventType)) return null; // no ruling yet
  const runners = Array.isArray(play.runners) ? play.runners : [];
  let errorMovements = 0;
  const movements = [];
  runners.forEach((runner) => {
    if (!runner || typeof runner !== 'object') return;
    const details = runner.details || {};
    const movement = runner.movement || {};
    const detType = typeof details.eventType === 'string' ? details.eventType : '';
    // Runner-level error advances only count when the plate appearance
    // itself is NOT the error: on a field_error play the runners carry the
    // same field_error code for the batter and every forced advance
    // (verified live 2026-09-04, game 824388 atBatIndex 42) — the error is
    // already the play's classification, not an extra movement on it.
    if (!SCORING_PA_ERROR_EVENT_TYPES.has(eventType) &&
        SCORING_RUNNER_ERROR_EVENT_TYPES.has(detType)) {
      errorMovements += 1;
    }
    const endLabel = movement.end != null
      ? movement.end
      : (movement.outBase != null ? `OUT:${movement.outBase}` : '-');
    movements.push([
      detType || '-',
      movement.originBase != null ? movement.originBase : '-',
      endLabel,
      movement.isOut === true ? 'out' : 'safe',
    ].join(':'));
  });
  movements.sort();
  return {
    atBatIndex: idx,
    eventType,
    event: typeof result.event === 'string' ? result.event : eventType,
    description: typeof result.description === 'string' ? result.description : '',
    isOut: result.isOut === true,
    outsAfter: play.count && typeof play.count.outs === 'number' ? play.count.outs : null,
    awayScore: typeof result.awayScore === 'number' ? result.awayScore : null,
    homeScore: typeof result.homeScore === 'number' ? result.homeScore : null,
    rbi: typeof result.rbi === 'number' ? result.rbi : null,
    errorMovements,
    movementSig: movements.join('|'),
    hasReview: about.hasReview === true,
    endTime: about.endTime || null,
    inning: typeof about.inning === 'number' ? about.inning : null,
    halfInning: typeof about.halfInning === 'string' ? about.halfInning : null,
  };
}

/** The diffed classification signature of one snapshot (annotations excluded). */
function scoringSnapshotSignature(snapshot) {
  if (!snapshot) return '';
  return [
    snapshot.eventType || '-',
    snapshot.isOut ? 'out' : 'safe',
    snapshot.outsAfter != null ? snapshot.outsAfter : '-',
    snapshot.errorMovements,
    snapshot.movementSig || '',
  ].join('|');
}

/** Hit / error / out / other — from the official registry flags + result.isOut. */
function scoringCategory(snapshot) {
  if (!snapshot) return null;
  if (SCORING_HIT_EVENT_TYPES.has(snapshot.eventType)) return 'hit';
  if (SCORING_PA_ERROR_EVENT_TYPES.has(snapshot.eventType)) return 'error';
  if (snapshot.isOut === true) return 'out';
  return 'other';
}

/** Official label for one snapshot, e.g. "Single", "Field Error", "Single + Error". */
function scoringEventLabel(snapshot) {
  if (!snapshot) return null;
  const base = isUsableName(snapshot.event) ? snapshot.event : (snapshot.eventType || 'Unknown');
  return snapshot.errorMovements > 0 ? `${base} + Error` : base;
}

/** Self-contained inning label ("▲ Top 3") — no dependency on MLB.ordinal. */
function scoringInningLabel(about) {
  const inning = about && about.inning;
  if (typeof inning !== 'number' || !Number.isFinite(inning)) return '';
  const half = String((about && about.halfInning) || '').toLowerCase();
  const n10 = inning % 100;
  const suffix = (n10 >= 11 && n10 <= 13) ? 'th'
    : (['th', 'st', 'nd', 'rd'][inning % 10] || 'th');
  const prefix = half === 'top' ? '▲ Top' : half === 'bottom' ? '▼ Bot' : '';
  return `${prefix} ${inning}${suffix}`.trim();
}

/**
 * Attribution for one observed classification change, decided ONLY from
 * observed facts (never guessed):
 *   - the play itself carries about.hasReview, OR a replay review was ACTIVE
 *     for this exact at-bat when the change landed → "replay review";
 *   - the play carried an official-scorer PENDING marker that has now
 *     resolved → "pending ruling resolved";
 *   - otherwise there is no replay-review trace on the play → the change is
 *     an official scoring change (scorer / Elias / player-club review —
 *     MLB's official log lists all three).
 */
function scoringMechanism(play, ctx) {
  const about = (play && play.about) || {};
  const idx = about.atBatIndex;
  const active = ctx && ctx.activeReviewIndexes instanceof Set ? ctx.activeReviewIndexes : null;
  if (about.hasReview === true || (idx != null && active && active.has(idx))) {
    return { key: 'replay_review', label: 'Change coincides with a replay review' };
  }
  const pending = ctx && ctx.pendingScoringIndexes instanceof Set ? ctx.pendingScoringIndexes : null;
  if (idx != null && pending && pending.has(idx)) {
    return { key: 'pending_ruling', label: 'Official-scorer pending ruling resolved' };
  }
  return { key: 'scorer', label: 'Official scoring change — no replay review observed' };
}

/**
 * One observed change on one play (the row's history entry).
 * summary is scoringChangeSummary()'s output shape.
 */
function scoringChangeSummary(previousSnapshot, nextSnapshot) {
  return {
    initial: {
      eventType: previousSnapshot.eventType,
      event: previousSnapshot.event,
      label: scoringEventLabel(previousSnapshot),
      category: scoringCategory(previousSnapshot),
      isOut: previousSnapshot.isOut,
      errorMovements: previousSnapshot.errorMovements,
    },
    final: {
      eventType: nextSnapshot.eventType,
      event: nextSnapshot.event,
      label: scoringEventLabel(nextSnapshot),
      category: scoringCategory(nextSnapshot),
      isOut: nextSnapshot.isOut,
      errorMovements: nextSnapshot.errorMovements,
    },
    headline: `${scoringEventLabel(previousSnapshot)} → ${scoringEventLabel(nextSnapshot)}`,
  };
}

/**
 * Diff one game's freshly polled playByPlay against the tracked snapshots.
 *
 *   plays      — every play object from the current payload (allPlays +
 *                currentPlay; duplicates by atBatIndex are harmless)
 *   prevMap    — Map<atBatIndex(String), tracked> from the previous polls
 *                (tracked = { snapshot, signature, firstObservedAt,
 *                lastObservedAt, history, rowCreated }); a Map not seen
 *                before starts a fresh baseline
 *   now        — observation timestamp (ms)
 *   ctx        — { activeReviewIndexes, pendingScoringIndexes,
 *                  reviewedPlays, teamLabels: {away:{id,name,abbrev},
 *                  home:{…}} }
 *
 * Returns { snapshots, added, updated, irregularities }:
 *   snapshots      — the Map to store for the next poll
 *   added/updated  — feed-entry-shaped { gamePk, review, firstSeen, lastSeen }
 *                    for NEW scoring changes and CHANGED ones (a play that
 *                    changes twice updates its row and is flagged)
 *   irregularities — human-readable flags for review: annotation-only edits
 *                    (description / RBI / score moved without a
 *                    reclassification) and plays that vanished from the
 *                    payload. Never silently corrected, never hidden.
 *
 * A row is minted ONLY when two REAL classifications were observed on the
 * same at-bat: the initial call (a previous poll's snapshot) and the final
 * one. When the change coincides with a replay review that this feed already
 * tracks for the same play (ctx.reviewedPlays), no second row is minted —
 * the review's own row carries the rescore.
 */
function mergeScoringChanges(gamePk, plays, prevMap, now, ctx) {
  const prev = prevMap instanceof Map ? prevMap : new Map();
  const snapshots = new Map();
  const added = [];
  const updated = [];
  const irregularities = [];
  const context = ctx || {};
  const teamLabels = context.teamLabels || {};
  const seenIdx = new Set();

  // An empty play list (a pre-game glitch or a truncated response) is a blip,
  // not a mass deletion: carry the previous snapshots through untouched.
  const list = Array.isArray(plays) ? plays : [];
  if (!list.length) {
    prev.forEach((tracked, key) => snapshots.set(key, tracked));
    return { snapshots, added, updated, irregularities };
  }

  list.forEach((play) => {
    const snapshot = buildScoringSnapshot(play);
    if (!snapshot) return;
    const idx = snapshot.atBatIndex;
    if (seenIdx.has(idx)) return; // currentPlay twin of an allPlays entry
    seenIdx.add(String(idx));
    seenIdx.add(idx);
    const signature = scoringSnapshotSignature(snapshot);
    const tracked = prev.get(String(idx)) || prev.get(idx);

    if (!tracked) {
      // First observation of this completed play — the baseline call. No row:
      // a scoring change needs an observed BEFORE and AFTER.
      snapshots.set(String(idx), {
        snapshot,
        signature,
        firstObservedAt: now,
        lastObservedAt: now,
        history: [],
        rowCreated: false,
      });
      return;
    }

    if (tracked.signature === signature) {
      // Classification unchanged. Annotation-only edits are irregularities
      // for review, not scoring-change rows.
      const notes = [];
      if (tracked.snapshot.description !== snapshot.description) {
        notes.push(`play ${idx}: official description edited without a hit/error/out ` +
          `reclassification ("${String(tracked.snapshot.description).slice(0, 90)}" → ` +
          `"${String(snapshot.description).slice(0, 90)}")`);
      }
      if (tracked.snapshot.rbi !== snapshot.rbi && snapshot.rbi != null) {
        notes.push(`play ${idx}: RBI ${tracked.snapshot.rbi} → ${snapshot.rbi} without a ` +
          'hit/error/out reclassification');
      }
      if ((tracked.snapshot.awayScore !== snapshot.awayScore ||
           tracked.snapshot.homeScore !== snapshot.homeScore) &&
          snapshot.awayScore != null && snapshot.homeScore != null) {
        notes.push(`play ${idx}: score after play ` +
          `${tracked.snapshot.awayScore}-${tracked.snapshot.homeScore} → ` +
          `${snapshot.awayScore}-${snapshot.homeScore} without a hit/error/out ` +
          'reclassification');
      }
      notes.forEach((note) => { if (!irregularities.includes(note)) irregularities.push(note); });
      snapshots.set(String(idx), { ...tracked, snapshot, lastObservedAt: now });
      return;
    }

    // A real classification change: the initial call is the FIRST observed
    // baseline (or history[0].from when this play has already changed), the
    // final is the fresh snapshot. Each history entry is one CHAIN step
    // (previous ruling → this ruling), so a multi-ruling play keeps its full
    // observed sequence.
    const history = Array.isArray(tracked.history) ? [...tracked.history] : [];
    const initialSnapshot = history.length ? history[0].from : tracked.snapshot;
    const previousSnapshot = history.length ? history[history.length - 1].to : tracked.snapshot;
    const summary = scoringChangeSummary(previousSnapshot, snapshot);
    history.push({ at: now, from: initialSnapshot, to: snapshot, summary });
    const mechanism = scoringMechanism(play, context);

    snapshots.set(String(idx), {
      snapshot,
      signature,
      firstObservedAt: tracked.firstObservedAt,
      lastObservedAt: now,
      history,
      rowCreated: tracked.rowCreated,
    });

    const reviewedBefore = context.reviewedPlays instanceof Set &&
      (context.reviewedPlays.has(String(idx)) || context.reviewedPlays.has(idx));
    if (mechanism.key === 'replay_review') {
      // This feed already carries a replay-review row for this exact play
      // (manager challenge / crew chief / boundary / ABS): the rescore is the
      // review's outcome and lives on that row — minting a second row would
      // double-count one fact. When NO review row for the play was ever
      // observed (e.g. the page opened mid-review), the change IS surfaced
      // here, honestly labelled as review-attributed.
      if (reviewedBefore || activeHasIdx(context, idx)) return;
    }

    const about = (play && play.about) || {};
    const matchup = (play && play.matchup) || {};
    const half = String(about.halfInning || '').toLowerCase();
    const battingSide = half === 'top' ? 'away' : half === 'bottom' ? 'home' : null;
    const battingTeam = battingSide ? teamLabels[battingSide] : null;
    const flags = [];
    if (history.length > 1) {
      flags.push(`Multiple scoring changes observed on one play (${history.length} rulings) — flagged for review`);
    }
    const prior = history.length > 1 ? history[history.length - 2].summary : null;
    // The ROW always reads initial call → latest ruling (baseline → now);
    // the chain steps live in history / previousHeadline.
    const rowSummary = scoringChangeSummary(initialSnapshot, snapshot);
    const review = {
      id: `scoring-${idx}`,
      atBatIndex: idx,
      inning: typeof about.inning === 'number' ? about.inning : (initialSnapshot.inning || 1),
      halfInning: half || initialSnapshot.halfInning || 'top',
      inningLabel: scoringInningLabel(about) || '',
      reviewType: SCORING_CHANGE_LABEL,
      typeKey: SCORING_CHANGE_TYPE_KEY,
      battingSide,
      battingTeamId: battingTeam && battingTeam.id != null ? battingTeam.id : null,
      battingTeamName: battingTeam && isUsableName(battingTeam.name) ? battingTeam.name : null,
      battingTeamAbbrev: battingTeam && isUsableName(battingTeam.abbrev) ? battingTeam.abbrev : null,
      inProgress: false,
      isOverturned: null,
      outcome: 'changed',
      outcomeLabel: 'Rescored',
      reason: rowSummary.headline,
      description: snapshot.description || snapshot.event,
      initialDescription: initialSnapshot.description || initialSnapshot.event || null,
      initial: rowSummary.initial,
      final: rowSummary.final,
      changeCount: history.length,
      changes: history.map((h) => ({ at: h.at, headline: h.summary.headline })),
      previousHeadline: prior ? prior.headline : null,
      mechanism,
      flags,
      // The scores printed are the official result.awayScore/homeScore that
      // came with each snapshot — observed, never derived.
      initialScoreAfter: initialSnapshot.awayScore != null && initialSnapshot.homeScore != null
        ? { away: initialSnapshot.awayScore, home: initialSnapshot.homeScore }
        : null,
      scoreAfter: snapshot.awayScore != null && snapshot.homeScore != null
        ? { away: snapshot.awayScore, home: snapshot.homeScore }
        : null,
      timestamp: new Date(now).toISOString(),
      // When the INITIAL call was first observed (the baseline snapshot) —
      // shown next to the initial description on the row.
      initialObservedAt: typeof tracked.firstObservedAt === 'number'
        ? new Date(tracked.firstObservedAt).toISOString()
        : null,
      isPitch: false,
      pitchVelo: null,
      batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
      pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
      countBefore: null,
      countAfter: null,
      atBatCount: null,
      challenger: null,
      scoreImpact: null,
    };
    const entry = { gamePk, review, firstSeen: now, lastSeen: now };
    if (tracked.rowCreated) updated.push(entry);
    else added.push(entry);
    snapshots.set(String(idx), { ...snapshots.get(String(idx)), rowCreated: true });
  });

  // A tracked play that vanished from the payload is an irregularity, not a
  // silent deletion: its snapshot is kept so that if it reappears (payload
  // restructure) the diff still runs against what was last observed — and if
  // it never comes back, the row and its history simply remain.
  if (seenIdx.size) {
    prev.forEach((tracked, key) => {
      const idx = String(key);
      if (seenIdx.has(idx)) return;
      irregularities.push(`play ${idx} disappeared from the official play-by-play payload ` +
        '(was: ' + scoringEventLabel(tracked.snapshot) + ') — flagged for review');
      snapshots.set(idx, tracked);
    });
  }

  return { snapshots, added, updated, irregularities };
}

function activeHasIdx(ctx, idx) {
  const active = ctx && ctx.activeReviewIndexes instanceof Set ? ctx.activeReviewIndexes : null;
  if (!active) return false;
  return active.has(String(idx)) || active.has(idx);
}

/**
 * Should a game that has gone Final be fetched again for scoring changes?
 *
 * MLB's own scoring-changes log states changes occur "following the
 * conclusion of the listed games" — i.e. AFTER Final, which the ordinary
 * replay feed never re-fetches (finals are scanned once). This helper bounds
 * the extra polling: for SCORING_CHANGE_GRACE_MS after the page first sees
 * the game as Final, re-scan it no more often than the rescan gap that
 * applies to its current age.
 *
 * The rescan gap is RECENCY-TIERED so a scorer ruling is caught as soon as
 * possible exactly when it is most likely — right after the game ends — and
 * then gently tapers as the game ages, all inside the fixed grace window:
 *   fast window (recently Final) : gap = fastRescanMs (default off)
 *   otherwise                    : gap = rescanMs
 * A final that has been Final for longer than graceMs is settled for good
 * and never polled again (bounded — the grace caps total request volume).
 *
 * Pure so the policy is directly testable; the IIFE owns the constants.
 * The last two params are optional and default to "no fast phase" so callers
 * that only set a uniform gap (and the existing uniform-gap tests) keep the
 * same semantics.
 *
 * Returns 'scan' (fetch it) or 'skip' (settled beyond the grace window, or
 * not due yet). grace = { firstFinalObservedAt, lastScanAt }.
 */
function finalScanDecision(grace, settled, now, graceMs, rescanMs, fastRescanMs, fastWindowMs) {
  if (!settled) return 'scan'; // live game: the ordinary cadence owns it
  if (!grace || typeof grace.firstFinalObservedAt !== 'number') {
    // Never seen as Final before: this poll IS its first Final observation.
    return 'scan';
  }
  const age = now - grace.firstFinalObservedAt;
  if (age > graceMs) return 'skip';
  const hasFast = Number.isFinite(fastRescanMs) && Number.isFinite(fastWindowMs);
  // A recently-Final game is rescanned at the fast gap; older finals (still
  // inside grace) at the base gap. Uses `age` (time since the game went
  // Final), not a separate clock, so the taper is purely a function of the
  // single authoritative timestamp we already track.
  const gap = (hasFast && age >= 0 && age < fastWindowMs) ? fastRescanMs : rescanMs;
  if (typeof grace.lastScanAt === 'number' && now - grace.lastScanAt < gap) return 'skip';
  return 'scan';
}

/* ------------------------------------------------- feed-log persistence
 *
 * FEED LOG (every tracked entry survives a refresh or a later visit).
 *
 * The tracker above is poll-diff: a scoring change is knowable ONLY from two
 * consecutive observations (initial call, then final ruling). Before this
 * log, both observations lived in memory alone — a page refresh or a fresh
 * visit wiped every feed row AND the baselines the next diff needed, so
 * tracked entries were silently lost. This layer changes nothing about
 * detection: after any poll that adds, updates, ends, or flags an entry, the
 * page writes its whole observed state to localStorage (one log per date),
 * and on boot / date change it restores that log before the first scan.
 *
 * What is stored — every field below is produced by the merge helpers above
 * from official playByPlay fields (see buildScoringSnapshot / the
 * mergeScoringChanges row shape / mergeFeedEvents entry shape). Nothing is
 * invented for storage; the log is a verbatim copy of observed state:
 *   entries        — feedState rows { gamePk, review, firstSeen, lastSeen,
 *                    matchupLabel } in insertion order (reviews of every
 *                    typeKey, pending-scoring rows, scoring_change rows)
 *   order          — the stable `<gamePk>:<id>` key order
 *   snapshots      — per-game scoring baselines { snapshot, signature,
 *                    firstObservedAt, lastObservedAt, history, rowCreated }
 *   irregularities — per-game flagged notes (already capped at 30 in memory)
 *   grace/settled  — post-Final re-scan windows + settled finals, so a
 *                    revisit continues the bounded grace instead of
 *                    restarting (or abandoning) it
 * Not stored: challenge counters (re-fetched live; a stale "now" value must
 * never be shown) and run-risk alert keys (a revisit behaves exactly like a
 * first visit — an actively risky review alerts its new observer).
 *
 * Bounds (localStorage is ~5 MB and shared): at most FEED_LOG_MAX_ENTRIES
 * rows (most recent win), FEED_LOG_MAX_SNAPSHOTS_PER_GAME baselines per
 * game (most recently observed win), FEED_LOG_MAX_IRREGULARITIES_PER_GAME
 * notes per game, and FEED_LOG_MAX_DATES date-logs (the date on screen is
 * always kept). Anything trimmed is counted in the payload (`trimmed`) and
 * any malformed stored record is dropped with a warning — flagged for
 * review, never silently hidden.
 *
 * Pure layer: no DOM, no storage access — the page IIFE owns reading /
 * writing localStorage. Never throws on malformed input.
 */

const FEED_LOG_VERSION = 1;
const FEED_LOG_KEY_PREFIX = 'mlbReplayFeedLog.v1.';
const FEED_LOG_INDEX_KEY = 'mlbReplayFeedLog.v1.index';
const FEED_LOG_MAX_ENTRIES = 500;
const FEED_LOG_MAX_SNAPSHOTS_PER_GAME = 400;
const FEED_LOG_MAX_IRREGULARITIES_PER_GAME = 30;
const FEED_LOG_MAX_DATES = 7;

/** Storage key for one date's log, e.g. `mlbReplayFeedLog.v1.2026-09-04`. */
function feedLogStorageKey(dateStr) {
  return `${FEED_LOG_KEY_PREFIX}${dateStr || ''}`;
}

/** Strict calendar-date shape (`YYYY-MM-DD`) — anything else is rejected. */
function isFeedLogDateStr(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Numeric gamePk keys survive JSON as strings — restore the number form. */
function feedLogGameKey(key) {
  const text = String(key);
  return /^\d+$/.test(text) ? Number(text) : key;
}

function feedLogFiniteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Serialize live tracker state into a JSON-safe log payload.
 * input = { dateStr, now, feedSeen: Map, feedOrder: [],
 *           scoringSnapshots: Map, scoringIrregularities: Map,
 *           scoringGraceFinals: Map, settledGames: Set }.
 * Caps (most-recent wins) and counts everything trimmed.
 */
function serializeFeedLog(input) {
  const src = input || {};
  const now = feedLogFiniteOrNull(src.now) != null ? src.now : Date.now();
  const seen = src.feedSeen instanceof Map ? src.feedSeen : new Map();
  const order = Array.isArray(src.feedOrder) ? src.feedOrder : [];
  const seenKeys = new Set();
  const entries = [];
  order.forEach((key) => {
    if (typeof key !== 'string' || seenKeys.has(key)) return;
    const entry = seen.get(key);
    if (!entry || !entry.review) return;
    seenKeys.add(key);
    entries.push({
      gamePk: entry.gamePk,
      review: entry.review,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      matchupLabel: entry.matchupLabel != null ? entry.matchupLabel : null,
    });
  });
  // Rows present in the map but missing from the order list (should not
  // happen) are appended rather than dropped — every entry is logged.
  seen.forEach((entry, key) => {
    if (seenKeys.has(key) || !entry || !entry.review) return;
    seenKeys.add(key);
    entries.push({
      gamePk: entry.gamePk,
      review: entry.review,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      matchupLabel: entry.matchupLabel != null ? entry.matchupLabel : null,
    });
  });
  const trimmedEntries = Math.max(0, entries.length - FEED_LOG_MAX_ENTRIES);
  const keptEntries = entries.slice(-FEED_LOG_MAX_ENTRIES);
  const keptKeys = new Set();
  const keptOrder = [];
  keptEntries.forEach((entry) => {
    const key = buildEventKey(entry.gamePk, entry.review);
    if (!keptKeys.has(key)) {
      keptKeys.add(key);
      keptOrder.push(key);
    }
  });

  const snapshots = {};
  let trimmedSnapshots = 0;
  const snapSource = src.scoringSnapshots instanceof Map ? [...src.scoringSnapshots] : [];
  snapSource.forEach(([gamePk, perGame]) => {
    if (!(perGame instanceof Map)) return;
    const tracked = [...perGame.values()].filter((t) =>
      t && t.snapshot && typeof t.signature === 'string');
    tracked.sort((a, b) => (feedLogFiniteOrNull(b.lastObservedAt) || 0) -
      (feedLogFiniteOrNull(a.lastObservedAt) || 0));
    trimmedSnapshots += Math.max(0, tracked.length - FEED_LOG_MAX_SNAPSHOTS_PER_GAME);
    const obj = {};
    tracked.slice(0, FEED_LOG_MAX_SNAPSHOTS_PER_GAME).forEach((t) => {
      obj[String(t.snapshot.atBatIndex)] = {
        snapshot: t.snapshot,
        signature: t.signature,
        firstObservedAt: t.firstObservedAt,
        lastObservedAt: t.lastObservedAt,
        history: Array.isArray(t.history) ? t.history : [],
        rowCreated: t.rowCreated === true,
      };
    });
    snapshots[String(gamePk)] = obj;
  });

  const irregularities = {};
  const irrSource = src.scoringIrregularities instanceof Map ? [...src.scoringIrregularities] : [];
  irrSource.forEach(([gamePk, notes]) => {
    if (!Array.isArray(notes)) return;
    irregularities[String(gamePk)] =
      notes.filter((n) => typeof n === 'string').slice(-FEED_LOG_MAX_IRREGULARITIES_PER_GAME);
  });

  const grace = {};
  const graceSource = src.scoringGraceFinals instanceof Map ? [...src.scoringGraceFinals] : [];
  graceSource.forEach(([gamePk, g]) => {
    if (!g || typeof g !== 'object') return;
    if (typeof g.firstFinalObservedAt !== 'number' || typeof g.lastScanAt !== 'number') return;
    grace[String(gamePk)] = {
      firstFinalObservedAt: g.firstFinalObservedAt,
      lastScanAt: g.lastScanAt,
    };
  });

  const settled = [];
  const settledSource = src.settledGames instanceof Set ? [...src.settledGames] : [];
  settledSource.forEach((pk) => { settled.push(pk); });

  return {
    v: FEED_LOG_VERSION,
    date: src.dateStr,
    savedAt: now,
    entries: keptEntries,
    order: keptOrder,
    snapshots,
    irregularities,
    grace,
    settled,
    trimmed: { entries: trimmedEntries, snapshots: trimmedSnapshots },
  };
}

/** One restored baseline, strictly validated — null when unusable. */
function validRestoredScoringTracked(tracked) {
  if (!tracked || typeof tracked !== 'object') return null;
  const snap = tracked.snapshot;
  if (!snap || typeof snap !== 'object') return null;
  if (snap.atBatIndex == null) return null;
  if (typeof snap.eventType !== 'string' || !snap.eventType) return null;
  if (typeof tracked.signature !== 'string') return null;
  const history = Array.isArray(tracked.history)
    ? tracked.history.filter((h) => h && typeof h === 'object' &&
      h.from && typeof h.from === 'object' &&
      h.to && typeof h.to === 'object' &&
      typeof h.at === 'number' && Number.isFinite(h.at))
    : [];
  return {
    snapshot: snap,
    signature: tracked.signature,
    firstObservedAt: feedLogFiniteOrNull(tracked.firstObservedAt),
    lastObservedAt: feedLogFiniteOrNull(tracked.lastObservedAt),
    history,
    rowCreated: tracked.rowCreated === true,
  };
}

/**
 * Restore a stored log payload for `dateStr`.
 * Returns { entries, order, snapshots: Map, irregularities: Map,
 *           grace: Map, settled: Set, dropped, warnings }.
 * Anything malformed is dropped and counted/reported — never invented, never
 * silently hidden. A version or date mismatch restores nothing (the caller
 * keeps its fresh state).
 */
function restoreFeedLog(data, dateStr) {
  const out = {
    entries: [],
    order: [],
    snapshots: new Map(),
    irregularities: new Map(),
    grace: new Map(),
    settled: new Set(),
    dropped: 0,
    warnings: [],
  };
  if (!data || typeof data !== 'object') {
    out.warnings.push('stored feed log is not an object — starting fresh');
    return out;
  }
  if (data.v !== FEED_LOG_VERSION) {
    out.warnings.push(`stored feed log version ${data && data.v} is not v${FEED_LOG_VERSION} — starting fresh`);
    return out;
  }
  if (data.date !== dateStr) {
    out.warnings.push(`stored feed log is for ${data.date}, not ${dateStr} — starting fresh`);
    return out;
  }
  (Array.isArray(data.entries) ? data.entries : []).forEach((entry) => {
    if (!entry || typeof entry !== 'object' || entry.gamePk == null ||
        !entry.review || typeof entry.review !== 'object' ||
        typeof entry.review.id !== 'string' || typeof entry.review.typeKey !== 'string') {
      out.dropped += 1;
      return;
    }
    out.entries.push({
      gamePk: entry.gamePk,
      review: entry.review,
      firstSeen: feedLogFiniteOrNull(entry.firstSeen),
      lastSeen: feedLogFiniteOrNull(entry.lastSeen),
      matchupLabel: typeof entry.matchupLabel === 'string' ? entry.matchupLabel : null,
    });
  });
  const keys = new Set(out.entries.map((e) => buildEventKey(e.gamePk, e.review)));
  (Array.isArray(data.order) ? data.order : []).forEach((key) => {
    if (typeof key !== 'string' || !keys.has(key) || out.order.includes(key)) return;
    out.order.push(key);
  });
  // Stored rows missing from the stored order still restore (appended in
  // stored order) — every logged entry comes back.
  out.entries.forEach((entry) => {
    const key = buildEventKey(entry.gamePk, entry.review);
    if (!out.order.includes(key)) out.order.push(key);
  });

  const snapData = data.snapshots && typeof data.snapshots === 'object' ? data.snapshots : {};
  Object.keys(snapData).forEach((gameKey) => {
    const perGame = snapData[gameKey];
    if (!perGame || typeof perGame !== 'object') { out.dropped += 1; return; }
    const map = new Map();
    Object.keys(perGame).forEach((idx) => {
      const valid = validRestoredScoringTracked(perGame[idx]);
      if (!valid) { out.dropped += 1; return; }
      map.set(String(idx), valid);
    });
    if (map.size) out.snapshots.set(feedLogGameKey(gameKey), map);
  });

  const irrData = data.irregularities && typeof data.irregularities === 'object' ? data.irregularities : {};
  Object.keys(irrData).forEach((gameKey) => {
    const notes = irrData[gameKey];
    if (!Array.isArray(notes)) { out.dropped += 1; return; }
    const clean = notes.filter((n) => typeof n === 'string')
      .slice(-FEED_LOG_MAX_IRREGULARITIES_PER_GAME);
    out.dropped += notes.length - clean.length;
    if (clean.length) out.irregularities.set(feedLogGameKey(gameKey), clean);
  });

  const graceData = data.grace && typeof data.grace === 'object' ? data.grace : {};
  Object.keys(graceData).forEach((gameKey) => {
    const g = graceData[gameKey];
    if (!g || typeof g !== 'object' ||
        typeof g.firstFinalObservedAt !== 'number' ||
        typeof g.lastScanAt !== 'number') { out.dropped += 1; return; }
    out.grace.set(feedLogGameKey(gameKey), {
      firstFinalObservedAt: g.firstFinalObservedAt,
      lastScanAt: g.lastScanAt,
    });
  });

  (Array.isArray(data.settled) ? data.settled : []).forEach((pk) => {
    if (pk == null || (typeof pk !== 'number' && typeof pk !== 'string')) { out.dropped += 1; return; }
    out.settled.add(typeof pk === 'string' && /^\d+$/.test(pk) ? Number(pk) : pk);
  });

  return out;
}

/**
 * Prune the cross-date log index to FEED_LOG_MAX_DATES entries.
 * index = { 'YYYY-MM-DD': savedAtMs }. The date on screen is always kept;
 * otherwise the most recently saved dates win. Pure: returns
 * { index (pruned copy), remove: [storage keys to delete] } — the caller
 * owns the actual storage removal.
 */
function pruneFeedLogIndex(index, keepDateStr, maxDates) {
  const src = index && typeof index === 'object' ? index : {};
  const limit = Number.isFinite(maxDates) && maxDates > 0
    ? Math.floor(maxDates) : FEED_LOG_MAX_DATES;
  const dates = Object.keys(src).filter(isFeedLogDateStr);
  const ranked = dates
    .slice()
    .sort((a, b) => (Number(src[b]) || 0) - (Number(src[a]) || 0));
  const keep = new Set();
  if (isFeedLogDateStr(keepDateStr)) keep.add(keepDateStr);
  ranked.forEach((d) => {
    if (keep.size < limit) keep.add(d);
  });
  const pruned = {};
  keep.forEach((d) => { pruned[d] = src[d]; });
  const remove = dates.filter((d) => !keep.has(d)).map(feedLogStorageKey);
  return { index: pruned, remove };
}

/* ------------------------------------------------------------ page logic */

(() => {
  // Cadence is the gap between poll STARTS (scan duration is subtracted in
  // waitAfterScan). The StatsAPI is pull-only — a shorter poll only reduces
  // how long a landed review sits unseen. Hidden tabs still pause.
  //   live games          : 250ms (2026-09-05: was 500ms — this is the same
  //                          cadence the page already used whenever ANY
  //                          review was in flight, now applied to all live
  //                          action. It puts EVERY scan-borne category —
  //                          official-scoring-pending first detection, live
  //                          scoring-change diffs, ABS challenge rows,
  //                          runs-at-risk detail, review outcome rows — at
  //                          the same ≤250ms + one round trip floor the
  //                          status watcher already gives review flips.)
  //   a review in flight  : 250ms (outcome flips are what the feed is for;
  //                          in-review games are fetched first, so the flip
  //                          lands ~1 request after poll start)
  //   no live games       : 5s
  // Politeness: 250ms is inside the README's documented 0.25–0.5s etiquette
  // band; the tab pauses entirely when hidden, an idle slate backs off to 5s,
  // finals settle after a bounded 30-minute grace, and api.js self-throttles
  // for 60s if the API ever answers 429. Worst case on a full 15-game slate:
  // ~60 playByPlay requests/s + 4 tiny status sweeps/s — two orders of
  // magnitude below "thousands of requests per second".
  const LIVE_POLL_MS = 250;
  const REVIEW_POLL_MS = 250;
  const IDLE_POLL_MS = 5000;
  // The schedule is re-fetched at most once per SCHEDULE_TTL_MS (the slate
  // for one date is static; only status/counters change). It is refreshed IN
  // PARALLEL with the playByPlay scan instead of serialized in front of it:
  // a schedule round-trip was previously added to EVERY poll before any
  // playByPlay request started, which is pure latency for the events the feed
  // exists to surface. A fresh cache resolves immediately, so a poll cycle is
  // just the playByPlay wave.
  const SCHEDULE_TTL_MS = 3000;
  // Per-game playByPlay: fail fast, no retry. A stalled game must not hold the
  // whole poll (requestInFlight) for 5s+; the NEXT poll (≤ interval later)
  // retries, and a retry inside the same poll only delays that next poll.
  const PBP_TIMEOUT_MS = 3000;
  const PBP_RETRIES = 0;
  // playByPlay is one request per live / unsettled-final game. 30 at a time
  // (the slate is ~15-17 games) keeps a full scan to ONE wave: a single
  // request round-trip instead of two, so every poll — and the review
  // outcome in particular — lands sooner. Same host (HTTP/2), same
  // CORS-open endpoint.
  const FETCH_CONCURRENCY = 30;
  /* ----------------------------------------------------------------------
   * REVIEW-STATUS WATCHER — the latency fix.
   *
   * The official game status is the EARLIEST signal that a review exists:
   * MLB flips statusCode to an M-code, an N-code or IH the instant a review
   * is CALLED, while
   * the play text the parser also reads ("Tigers challenged (tag play), call
   * on the field was overturned: …") is written when the review RESOLVES.
   * Registry: GET /api/v1/gameStatus, verified live 2026-09-02.
   *
   * Before this watcher, the only status the feed could see came off the
   * 3s SCHEDULE_TTL_MS cache above — so a review could sit undetected for up
   * to ~3s after MLB published it, and the "under review" row only appeared
   * on the next poll that happened to refresh the schedule. The watcher
   * polls a `fields`-projected, hydration-free schedule (MLB.getReviewStatus
   * — gamePk + status for the whole slate, ~2.4 KB / 1 chunk, verified live
   * 2026-09-02 against the 8-chunk hydrated schedule getSchedule() uses) on
   * its own timer, merges the fresh status into `games`, and on any review
   * flip kicks an out-of-band scan instead of waiting for the next tick.
   *
   *   worst case before : ~3000ms (schedule cache) + up to 500ms poll
   *   worst case after  : ~250ms (watcher) + one round trip
   *
   * It runs on its own timer rather than inside load() so it adds ZERO
   * serialized latency to the playByPlay scan, and it is only fast while a
   * game is actually live — a review cannot start on a game that has not
   * started, so an idle slate backs off to 5s.
   * ------------------------------------------------------------------- */
  const REVIEW_STATUS_POLL_MS = 250;
  const REVIEW_STATUS_IDLE_MS = 5000;
  const REVIEW_STATUS_TIMEOUT_MS = 2500;

  // Official scoring changes often land AFTER a game goes Final (MLB's own
  // log says changes occur "following the conclusion of the listed games").
  // Finals are re-scanned for scoring changes for this long after the page
  // first sees them as Final, so a late scorer ruling is still caught live
  // without re-polling yesterday's slate forever. Within that bounded grace
  // window the rescan gap is recency-tiered: a recently-Final game (most
  // likely to still get a scoring decision) is re-scanned at the fast gap,
  // then the base gap, so the worst-case delay for a post-Final change drops
  // from the old flat ~30s to as little as ~2.5s in the early, most likely
  // window while total request volume stays capped by the 30-minute grace
  // (2026-09-05: fast gap tightened 5s → 2.5s; ≤120 fast-window requests per
  // finished game, then ≤100 more across the remaining 25 minutes).
  const SCORING_CHANGE_GRACE_MS = 30 * 60 * 1000;   // 30 minutes after Final
  const SCORING_FINAL_RESCAN_MS = 15 * 1000;        // base gap once the fast window passes
  const SCORING_RECENT_RESCAN_MS = 2.5 * 1000;      // fast gap while the game is recently Final
  const SCORING_RECENT_FINAL_WINDOW_MS = 5 * 60 * 1000;  // "recently Final" = first 5 minutes

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
  // Schedule cache: the last games array used + when it was observed, and any
  // refresh already in flight (deduped so two parallel polls never issue two
  // schedule requests at once).
  let scheduleDate = null;
  let lastScheduleAt = 0;
  let scheduleInFlight = null;
  // Review-status watcher state: its own timer, an in-flight guard (a sweep
  // must never overlap itself and stack requests), the last observed
  // gamePk -> statusCode map, and a flag that tells load() a review flipped
  // while a scan was already running so it re-scans immediately on exit.
  let reviewStatusTimer = null;
  let reviewStatusInFlight = false;
  let reviewStatusCodes = new Map();
  let reviewStatusFlipPending = false;
  // One alert (chime + notification) per poll at most — but fired the moment
  // the FIRST game response reports it, instead of after the slowest game.
  let pollAlertFired = false;
  const feedState = { seen: new Map(), order: [] };
  // gamePk -> { counts: normalizeChallengeCounts(...), issues: [], updatedAt }
  // Official per-team challenge counters (manager `review` + `absChallenges`)
  // for every game that has at least one feed event. Counters are read from
  // the payloads only — never derived by counting feed rows ourselves.
  const challengeCounts = new Map();
  // Official scoring-change tracker state:
  //   gamePk -> Map<atBatIndex(String), tracked>  — the observed classification
  //   snapshot of every completed play, so the next poll can diff against it.
  const scoringSnapshots = new Map();
  //   gamePk -> { firstFinalObservedAt, lastScanAt } — the bounded post-Final
  //   re-scan window that catches scorer rulings published after the game ends.
  const scoringGraceFinals = new Map();
  //   gamePk -> [notes] — irregularities flagged for review (annotation-only
  //   edits, vanished plays). Kept and displayed, never silently corrected.
  const scoringIrregularities = new Map();

  /* --------------------------------------- feed-log persistence (storage) */
  // Every tracked entry is logged to localStorage (one log per date) so a
  // refresh or a later visit restores the feed rows, the scoring baselines,
  // and the flagged irregularities. Detection is untouched — this only
  // writes what the merge helpers already observed and reads it back.
  let lastFeedLogSaveAt = 0;
  let feedLogSaveTimer = null;

  /** localStorage, or null where it is unavailable (private mode, tests). */
  function feedLogStore() {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage;
    } catch (_) {
      return null;
    }
  }

  /** Write this date's whole observed state now. Never throws. */
  function saveFeedLogNow() {
    const store = feedLogStore();
    if (!store) return false;
    let payload;
    try {
      payload = serializeFeedLog({
        dateStr,
        now: Date.now(),
        feedSeen: feedState.seen,
        feedOrder: feedState.order,
        scoringSnapshots,
        scoringIrregularities,
        scoringGraceFinals,
        settledGames,
      });
    } catch (err) {
      console.warn('feed log serialize failed — nothing saved (flagged for review)', err);
      return false;
    }
    try {
      store.setItem(feedLogStorageKey(dateStr), JSON.stringify(payload));
      let index = {};
      try {
        index = JSON.parse(store.getItem(FEED_LOG_INDEX_KEY)) || {};
      } catch (_) {
        index = {};
      }
      if (!index || typeof index !== 'object') index = {};
      index[dateStr] = payload.savedAt;
      const pruned = pruneFeedLogIndex(index, dateStr, FEED_LOG_MAX_DATES);
      (pruned.remove || []).forEach((key) => {
        try { store.removeItem(key); } catch (_) {}
      });
      store.setItem(FEED_LOG_INDEX_KEY, JSON.stringify(pruned.index));
      lastFeedLogSaveAt = Date.now();

      // Multi-browser persistence: send log to server so another browser
      // opening the website immediately receives all tracked entries.
      if (typeof fetch === 'function') {
        try {
          fetch('/api/feed-log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
        } catch (_) {}
      }

      return true;
    } catch (err) {
      // Quota or access failure: the in-memory feed keeps working for this
      // visit — the loss is flagged, never silently hidden.
      console.warn('feed log save failed (quota?) — kept in memory for this visit (flagged for review)', err);
      return false;
    }
  }

  /**
   * Schedule a log write, at most one per second. Polls run every 250–500ms
   * while live, so an unthrottled write would serialize the whole feed on
   * every scan for no benefit.
   */
  function scheduleFeedLogSave() {
    if (!feedLogStore()) return;
    if (Date.now() - lastFeedLogSaveAt >= 1000) {
      saveFeedLogNow();
      return;
    }
    if (feedLogSaveTimer != null) return;
    feedLogSaveTimer = setTimeout(() => {
      feedLogSaveTimer = null;
      saveFeedLogNow();
    }, 1000);
  }

  /**
   * Restore this date's logged state into the live trackers. Runs on boot
   * and on date change, BEFORE the first scan, so the first paint already
   * shows every logged entry and the first diff runs against the previously
   * observed baselines. Restored rows merge idempotently with fresh polls
   * (stable `<gamePk>:<id>` keys); restored scoring baselines let a change
   * that landed while the page was closed still diff honestly against what
   * was last observed. Never throws.
   */
  function restorePersistedLog() {
    const store = feedLogStore();
    if (!store) return { restored: 0, dropped: 0 };
    let raw = null;
    try {
      raw = store.getItem(feedLogStorageKey(dateStr));
    } catch (_) {
      return { restored: 0, dropped: 0 };
    }
    if (!raw) return { restored: 0, dropped: 0 };
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.warn(`feed log for ${dateStr} is not valid JSON — starting fresh (flagged for review)`, err);
      return { restored: 0, dropped: 0 };
    }
    const res = restoreFeedLog(data, dateStr);
    (res.warnings || []).forEach((note) => {
      console.warn(`feed log (${dateStr}) — flagged for review: ${note}`);
    });
    res.entries.forEach((entry) => {
      const key = buildEventKey(entry.gamePk, entry.review);
      if (!feedState.seen.has(key)) feedState.seen.set(key, entry);
    });
    res.order.forEach((key) => {
      if (feedState.seen.has(key) && feedState.order.indexOf(key) < 0) feedState.order.push(key);
    });
    feedState.seen.forEach((_, key) => {
      if (feedState.order.indexOf(key) < 0) feedState.order.push(key);
    });
    res.snapshots.forEach((map, gamePk) => scoringSnapshots.set(gamePk, map));
    res.irregularities.forEach((notes, gamePk) => scoringIrregularities.set(gamePk, notes));
    res.grace.forEach((grace, gamePk) => scoringGraceFinals.set(gamePk, grace));
    res.settled.forEach((gamePk) => settledGames.add(gamePk));
    if (res.dropped) {
      console.warn(`feed log (${dateStr}): ${res.dropped} malformed stored record(s) dropped (flagged for review)`);
    }
    return { restored: res.entries.length, dropped: res.dropped };
  }

  let syncInFlight = false;
  let lastServerSyncAt = 0;

  /**
   * Asynchronously synchronize with the server's persistent feed log
   * (GET /api/feed-log?date=... or data/feed-log-<date>.json).
   * Merges server-persisted entries, scoring baselines, irregularities,
   * and grace windows into live state so that any browser or new session
   * immediately sees all tracked entries and changes across the website.
   */
  async function syncFeedLogFromServer() {
    if (syncInFlight || typeof fetch !== 'function') return;
    syncInFlight = true;
    const targetDate = dateStr;
    try {
      let data = null;
      try {
        const res = await fetch(`/api/feed-log?date=${encodeURIComponent(targetDate)}`, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.ok) data = await res.json();
      } catch (_) {}

      if (!data) {
        try {
          const resStatic = await fetch(`data/feed-log-${encodeURIComponent(targetDate)}.json`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (resStatic.ok) data = await resStatic.json();
        } catch (_) {}
      }

      if (!data || data.date !== targetDate || targetDate !== dateStr) {
        syncInFlight = false;
        return;
      }

      const res = restoreFeedLog(data, targetDate);
      let changed = false;

      res.entries.forEach((entry) => {
        const key = buildEventKey(entry.gamePk, entry.review);
        if (!feedState.seen.has(key)) {
          feedState.seen.set(key, entry);
          changed = true;
        } else {
          const existing = feedState.seen.get(key);
          if (entry.review && entry.review.typeKey === 'scoring_change') {
            if (!existing.review || existing.review.typeKey !== 'scoring_change' ||
                (entry.review.changeCount || 0) > (existing.review.changeCount || 0)) {
              feedState.seen.set(key, entry);
              changed = true;
            }
          }
        }
      });

      res.order.forEach((key) => {
        if (feedState.seen.has(key) && feedState.order.indexOf(key) < 0) {
          feedState.order.push(key);
          changed = true;
        }
      });
      feedState.seen.forEach((_, key) => {
        if (feedState.order.indexOf(key) < 0) feedState.order.push(key);
      });

      res.snapshots.forEach((map, gamePk) => {
        const existingMap = scoringSnapshots.get(gamePk) || new Map();
        let mapChanged = false;
        map.forEach((val, idx) => {
          if (!existingMap.has(idx)) {
            existingMap.set(idx, val);
            mapChanged = true;
          }
        });
        if (mapChanged) scoringSnapshots.set(gamePk, existingMap);
      });

      res.irregularities.forEach((notes, gamePk) => {
        const existingNotes = scoringIrregularities.get(gamePk) || [];
        let notesChanged = false;
        notes.forEach((n) => {
          if (!existingNotes.includes(n)) {
            existingNotes.push(n);
            notesChanged = true;
          }
        });
        if (notesChanged) scoringIrregularities.set(gamePk, existingNotes);
      });

      res.grace.forEach((grace, gamePk) => {
        if (!scoringGraceFinals.has(gamePk)) scoringGraceFinals.set(gamePk, grace);
      });
      res.settled.forEach((gamePk) => settledGames.add(gamePk));

      lastServerSyncAt = Date.now();

      if (changed) {
        render();
        const store = feedLogStore();
        if (store) {
          try {
            const currentPayload = serializeFeedLog({
              dateStr,
              now: Date.now(),
              feedSeen: feedState.seen,
              feedOrder: feedState.order,
              scoringSnapshots,
              scoringIrregularities,
              scoringGraceFinals,
              settledGames,
            });
            store.setItem(feedLogStorageKey(dateStr), JSON.stringify(currentPayload));
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn(`feed log server sync failed (${targetDate})`, err);
    } finally {
      syncInFlight = false;
    }
  }

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
  // Run-risk desktop notifications defer to the END of the poll so a poll
  // where two games go at-risk at the same instant produces ONE notification
  // covering both (the chime itself fires immediately from maybeAlertNow).
  let pendingRunRiskNotify = [];
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
    try {
      clearTimeout(feedLogSaveTimer);
    } catch (_) {}
    feedLogSaveTimer = null;
    feedState.seen.clear();
    feedState.order.length = 0;
    settledGames = new Set();
    challengeCounts.clear();
    scoringSnapshots.clear();
    scoringGraceFinals.clear();
    scoringIrregularities.clear();
    isFirstLoad = true;
    pendingAlertableCount = 0;
    alertedRunRiskKeys.clear();
    pendingRunRiskAlerts = [];
    pendingRunRiskNotify = [];
    // Date changed: the schedule cache belongs to the old date and the
    // parallel scan must start from an empty known-slate (the new poll awaits
    // the new schedule first), never scan the previous date's games.
    games = [];
    scheduleDate = null;
    lastScheduleAt = 0;
    scheduleInFlight = null;
    // The watcher's code map belongs to the old date too: keeping it would
    // make the new date's first sweep look like "nothing changed" for a game
    // whose gamePk collides, and suppress a review that is already running.
    reviewStatusCodes = new Map();
    reviewStatusFlipPending = false;
    // A date with a logged feed restores it now, so navigating dates (or
    // back to today) shows every entry logged on that date.
    restorePersistedLog();
    syncFeedLogFromServer();
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
      btn.title = 'Alert sound ON — gentle raindrop chime for new challenges/reviews/boundary calls, official-scorer pending rulings and official scoring changes (not ABS), and the same chime whenever an active review could take a run OFF the scoreboard (any review type, ABS included). Click to mute.';
    } else {
      btn.textContent = '🔇 Sound Off';
      btn.classList.remove('btn-sound-on');
      btn.classList.add('btn-ghost');
      btn.title = 'Alert sound OFF — click to enable the gentle raindrop chime for new challenges/reviews/boundary calls, official-scorer pending rulings, official scoring changes, and run-at-risk reviews';
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

  /** Candidate games for one poll: live or final (finals fetched once). */
  function candidateGames(list) {
    return (list || []).filter((g) => {
      const state = g && g.status && g.status.abstractGameState;
      return state === 'Live' || state === 'Final';
    });
  }

  /**
   * Fresh schedule for a date, cached for SCHEDULE_TTL_MS and deduped while a
   * refresh is in flight. Resolves to the games array (the cached one when
   * fresh). Never throws: on failure it resolves null and the caller keeps the
   * last games — the playByPlay scan is unaffected by a schedule blip.
   */
  function scheduleFor(requestDate) {
    const now = Date.now();
    if (scheduleDate === requestDate && scheduleInFlight) return scheduleInFlight;
    if (scheduleDate === requestDate && lastScheduleAt &&
        now - lastScheduleAt < SCHEDULE_TTL_MS) {
      return Promise.resolve(games);
    }
    scheduleDate = requestDate;
    scheduleInFlight = MLB.getSchedule(requestDate)
      .then((s) => {
        // Only adopt the response for the date it was requested for.
        if (scheduleDate === requestDate) {
          games = s;
          lastScheduleAt = Date.now();
        }
        return s;
      })
      .catch((err) => {
        console.warn('schedule refresh failed — using last known games', err);
        return null;
      })
      .finally(() => {
        if (scheduleInFlight) scheduleInFlight = null;
      });
    return scheduleInFlight;
  }

  /**
   * Fetch + ingest one batch of games with the existing priority ordering.
   * Returns the number of games successfully ingested (a game that failed
   * fetch returns false; a settled Final is a no-op success).
   */
  async function scanGames(list, requestDate) {
    const candidates = candidateGames(list);
    // Games already under review first, then other live games, then finals.
    // That cuts the wait for an outcome flip on a 15-game slate.
    candidates.sort((a, b) =>
      reviewFetchPriority(a, gameHasInProgress(a.gamePk)) -
      reviewFetchPriority(b, gameHasInProgress(b.gamePk)));
    let success = 0;
    await mapPool(candidates, FETCH_CONCURRENCY, async (g) => {
      if (requestDate !== dateStr) return;
      if (await ingestGame(g)) success += 1;
    });
    return success;
  }

  async function load() {
    if (requestInFlight) return;
    const requestDate = dateStr;
    requestInFlight = true;
    // This scan is now the one that will see the flip the watcher reported, so
    // the "re-scan after me" request is satisfied and must not fire a second
    // redundant scan in the finally block.
    reviewStatusFlipPending = false;
    lastCycleStartedAt = Date.now();
    const statusLine = $('#status-line');
    setLivePulse(true);
    pendingAlertableCount = 0;
    pendingRunRiskAlerts = [];
    pendingRunRiskNotify = [];
    pollAlertFired = false;

    try {
      // Poll flow (latency-ordered):
      //   1. Kick off the schedule refresh IN PARALLEL with the playByPlay
      //      scan of the games we already know. Previously the schedule
      //      round-trip was awaited before ANY playByPlay request started,
      //      adding a full RTT to every poll for data the scan does not need.
      //   2. Scan any games the fresh schedule newly reveals (e.g. a game
      //      that just went Live) — first poll, or slate changes.
      const knownCandidates = candidateGames(games);
      const knownPks = new Set(knownCandidates.map((g) => g.gamePk));
      const scheduleReady = scheduleFor(requestDate);
      const scanKnown = scanGames(knownCandidates, requestDate);

      const scheduleGames = await scheduleReady;
      if (requestDate !== dateStr) return;
      if (scheduleGames) games = scheduleGames;

      // Official team directory for the schedule's season: the schedule's own
      // team objects have NO abbreviation (verified live 2026-08-19), so
      // official abbreviations are resolved here — never fabricated. If this
      // request fails, official full names still render from the schedule and
      // abbreviation chips simply stay hidden. (Cached in api.js after the
      // first poll, so this is a no-op wait on essentially every cycle.)
      const season = (games.find((g) => g && g.season) || {}).season
        || requestDate.slice(0, 4);
      try {
        teamsById = await MLB.getTeams(season);
      } catch (dirErr) {
        console.warn('team directory unavailable — abbreviations hidden this poll', dirErr);
        teamsById = {};
      }
      if (requestDate !== dateStr) return;

      // Manager-challenge counters ride along on the schedule refresh
      // (hydrate=review — shape verified live 2026-08-28: every game carries
      // review.away/home.used/remaining). When the schedule is served from the
      // 3s cache nothing changes here — the per-game feed/live side-fetch in
      // ingestGame keeps counters fresh when an event actually moves them.
      if (scheduleGames) {
        games.forEach((g) => {
          if (g && g.gamePk != null && g.review) updateGameCounts(g.gamePk, g.review, null, false);
        });
      }

      let freshSuccess = 0;
      if (scheduleGames) {
        // Games not in the last-known slate (first poll, or a game that just
        // went Live). Their FIRST scan necessarily waits for the schedule.
        const freshCandidates = candidateGames(scheduleGames)
          .filter((g) => !knownPks.has(g.gamePk));
        freshSuccess = await scanGames(freshCandidates, requestDate);
      }
      if (requestDate !== dateStr) return;
      const knownSuccess = await scanKnown;

      // Nothing at all came back (host unreachable): back off like the old
      // single-fetch path instead of hammering a dead host every tick.
      // A schedule blip ALONE is not fatal — the cached slate still scans, and
      // the next poll refreshes the schedule.
      if (scheduleGames === null && knownSuccess === 0 && freshSuccess === 0) {
        statusLine.textContent = "Couldn't reach the MLB StatsAPI — retrying…";
        scheduleNext(10000);
        return;
      }

      // Run-at-risk scan. Done once per poll across the WHOLE slate (not per
      // game) so a key that moved games/re-keyed is reconciled in one pass,
      // and so one poll produces at most one alert no matter how many games
      // report at the same instant. Per-game alerting (maybeAlertNow inside
      // ingestGame) has usually already fired by now; this final pass both
      // reconciles keys and catches a poll where the alert arrived after all
      // games resolved (e.g. a run-risk key cleared and a new one started in
      // the same cycle).
      syncRunRiskTracking();
      maybeAlertNow();
      // Desktop notifications: once per poll, covering EVERY run that went
      // at-risk this cycle (the chime already fired immediately above).
      if (pendingRunRiskNotify.length) {
        notifyRunRisk(pendingRunRiskNotify);
        pendingRunRiskNotify = [];
      }
      isFirstLoad = false;

      // Periodic sync with server log to pick up entries logged by other browsers
      if (Date.now() - lastServerSyncAt >= 15000) {
        syncFeedLogFromServer();
      }

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
      if (requestDate !== dateStr) {
        load();
      } else if (reviewStatusFlipPending) {
        // The watcher saw a review flip while this scan was already running,
        // so its `load()` call was dropped by the requestInFlight guard.
        // Re-scan immediately instead of waiting for the next scheduled tick —
        // this is the difference between the row landing one poll later and
        // landing now. Cleared here so it can only ever cost ONE extra scan.
        reviewStatusFlipPending = false;
        load();
      }
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

  /**
   * Fire this poll's single CHIME immediately — called from ingestGame the
   * moment a NEW event or a newly-run-at-risk review is observed, instead of
   * waiting for every game in the slate to respond (the old flow). The
   * game under review is fetched with the top priority and in the same
   * parallel wave, so its response is typically the first change to land —
   * but even when another game wins, waiting for the SLOWEST game added a
   * variable extra 100s-of-ms to every alert. `pollAlertFired` keeps the
   * existing "at most one chime per poll" guarantee, so the sound is never
   * triggered twice over itself.
   *
   * A newly at-risk run always gets its desktop notification — but deferred
   * to the end of the poll (see load()) so a poll where two games go at-risk
   * in the same instant still raises ONE notification covering both. The
   * chime fires here, immediately; only a still-ACTIVE review can put a run
   * at risk, so there is no backlog of historical events to blast through.
   */
  function maybeAlertNow() {
    syncRunRiskTracking();
    if (pendingRunRiskAlerts.length) {
      // Accumulate for the end-of-poll notification (dedup by event key).
      const keys = new Set(pendingRunRiskNotify.map((e) => buildEventKey(e.gamePk, e.review)));
      pendingRunRiskAlerts.forEach((e) => {
        const key = buildEventKey(e.gamePk, e.review);
        if (!keys.has(key)) {
          keys.add(key);
          pendingRunRiskNotify.push(e);
        }
      });
      if (pollAlertFired) return;
      pollAlertFired = true;
      playRunRiskAlertSound();
    } else if (!isFirstLoad && pendingAlertableCount > 0) {
      // New non-ABS event after the initial page population.
      if (pollAlertFired) return;
      pollAlertFired = true;
      playAlertSound();
    }
  }

  /**
   * Fetch + extract one game. Returns true on success (including a settled
   * Final that was correctly skipped), false when the playByPlay fetch failed.
   */
  /**
   * Attribution + team-label context for one game's scoring-change diff,
   * read entirely from the feed's own observed state:
   *   reviewedPlays        — at-bats that EVER had a replay-review entry in
   *                          this feed (the change likely belongs to that
   *                          review, whose row already exists)
   *   activeReviewIndexes  — at-bats with a review IN PROGRESS right now
   *   pendingScoringIndexes — at-bats carrying an official-scorer PENDING
   *                          marker right now (the change is the ruling)
   *   teamLabels           — official away/home {id, name, abbrev} for the
   *                          batting-team chip (schedule + /teams directory).
   */
  function scoringContextFor(game, gamePk) {
    const activeReviewIndexes = new Set();
    const pendingScoringIndexes = new Set();
    const reviewedPlays = new Set();
    feedState.seen.forEach((entry) => {
      if (!entry || entry.gamePk !== gamePk || !entry.review) return;
      const r = entry.review;
      if (r.atBatIndex == null || r.typeKey === SCORING_CHANGE_TYPE_KEY) return;
      if (r.typeKey === 'pending_scoring') {
        if (r.inProgress) pendingScoringIndexes.add(r.atBatIndex);
        return;
      }
      // Any replay-review entry ever observed for this at-bat (active or
      // resolved): a classification change on the same play is attributed
      // to that review rather than double-tracked as a scorer change.
      reviewedPlays.add(r.atBatIndex);
      if (r.inProgress) activeReviewIndexes.add(r.atBatIndex);
    });
    const label = (side) => {
      const t = gameSideTeam(game, side);
      if (!t) return null;
      const dir = t.id != null ? teamsById[t.id] : null;
      return {
        id: t.id != null ? t.id : null,
        name: officialTeamName(t, teamsById, null),
        abbrev: (dir && dir.abbreviation) || (isUsableName(t.abbreviation) ? t.abbreviation : null),
      };
    };
    return {
      activeReviewIndexes,
      pendingScoringIndexes,
      reviewedPlays,
      teamLabels: { away: label('away'), home: label('home') },
    };
  }

  /**
   * Insert/refresh the scoring-change rows this poll produced into the
   * shared feedState (same store the review feed renders from). Keys are
   * stable (`<gamePk>:scoring-<atBatIndex>`), so a play that changes twice
   * UPDATES its row (and is flagged) instead of spawning a second one.
   */
  function admitScoringEntries(entries, game) {
    const added = [];
    const updated = [];
    const now = Date.now();
    const matchupLabel = gameTeamsLabel(game, teamsById);
    (entries || []).forEach(({ gamePk, review }) => {
      const key = `${gamePk}:${review.id}`;
      const existing = feedState.seen.get(key);
      if (!existing) {
        const entry = { gamePk, review, firstSeen: now, lastSeen: now, matchupLabel };
        feedState.seen.set(key, entry);
        feedState.order.push(key);
        added.push(entry);
        return;
      }
      existing.review = review;
      existing.lastSeen = now;
      existing.matchupLabel = matchupLabel;
      updated.push(existing);
    });
    return { added, updated };
  }

  async function ingestGame(game) {
    const gamePk = game.gamePk;
    const state = game.status && game.status.abstractGameState;
    // Finals are ordinarily scanned ONCE (settledGames), but official scoring
    // changes frequently land AFTER the game ends — MLB's own log states
    // changes occur "following the conclusion of the listed games". Within
    // the bounded grace window (and at most once per rescan gap) a Final is
    // still fetched so a late hit/error reclassification is caught live;
    // beyond the window it is settled for good, exactly like before.
    const isFinal = state === 'Final';
    if (isFinal) {
      const decision = finalScanDecision(
        scoringGraceFinals.get(gamePk) || null,
        settledGames.has(gamePk),
        Date.now(),
        SCORING_CHANGE_GRACE_MS,
        SCORING_FINAL_RESCAN_MS,
        SCORING_RECENT_RESCAN_MS,
        SCORING_RECENT_FINAL_WINDOW_MS,
      );
      if (decision === 'skip') return true;
    }

    let pbp;
    try {
      // Lean fields-projected playByPlay (see api.js PBP_FIELDS — verified
      // 2026-08-30 to carry every field the parser reads, ~3x smaller than
      // the raw response). Fail fast: retries are left to the next poll.
      pbp = await MLB.getPlayByPlay(gamePk, { timeout: PBP_TIMEOUT_MS, retries: PBP_RETRIES });
    } catch (err) {
      // A game that just started may not have a playByPlay yet; skip quietly.
      return false;
    }
    if (isFinal) {
      settledGames.add(gamePk);
      // The grace window starts when the page FIRST observes the Final, so a
      // page opened hours after the game still gets one bounded watch window
      // rather than an unbounded one. lastScanAt throttles the re-scans.
      const grace = scoringGraceFinals.get(gamePk) || {
        firstFinalObservedAt: Date.now(),
        lastScanAt: 0,
      };
      grace.lastScanAt = Date.now();
      scoringGraceFinals.set(gamePk, grace);
    }

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
    const result = mergeFeedEvents(feedState, gamePk, reviewData.reviews, reviewData.playsByAtBatIndex);

    // Official scoring-change tracker: diff every completed play's official
    // classification (hit / error / out / bases / runner error movements)
    // against what previous polls observed. A diff that survives the
    // signature comparison becomes a permanent feed row ("Single → Field
    // Error", "Double → Single", …) shown in the All feed and the ✏️ Scoring
    // Changes tab. Annotation-only edits (description / RBI / score without a
    // reclassification) are flagged as irregularities for review instead.
    const scoring = mergeScoringChanges(
      gamePk,
      [...(Array.isArray(pbp.allPlays) ? pbp.allPlays : []), pbp.currentPlay],
      scoringSnapshots.get(gamePk) || new Map(),
      Date.now(),
      scoringContextFor(game, gamePk),
    );
    scoringSnapshots.set(gamePk, scoring.snapshots);
    if (scoring.irregularities.length) {
      const list = scoringIrregularities.get(gamePk) || [];
      scoring.irregularities.forEach((note) => { if (!list.includes(note)) list.push(note); });
      scoringIrregularities.set(gamePk, list.slice(-30));
      console.warn(`official-scoring irregularity (game ${gamePk}) — flagged for review:`,
        scoring.irregularities);
    }
    // mergeScoringChanges() returns the minted rows split into added/updated
    // ({gamePk, review} pairs); admit merges them into feedState idempotently
    // by stable key.
    const scoringResult = admitScoringEntries([...scoring.added, ...scoring.updated], game);
    const combined = {
      added: [...result.added, ...scoringResult.added],
      updated: [...result.updated, ...scoringResult.updated],
      ended: result.ended,
    };
    // Log every tracked entry: any poll that adds, updates, ends, or flags
    // an entry (or advances a Final's grace window) persists the whole
    // observed state, so a refresh or a later visit restores it. Detection
    // above is untouched — this only writes what was observed.
    if (combined.added.length || combined.updated.length || combined.ended.length ||
        scoring.irregularities.length || isFinal) {
      scheduleFeedLogSave();
    }

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
    const eventsChanged = combined.added.length || combined.updated.length || combined.ended.length;
    const tracked = challengeCounts.get(gamePk);
    const needsCounts = hasEntries &&
      (eventsChanged || !tracked || !tracked.absAttempted);
    // Count new alertable events for the chime (challenges/reviews/boundary,
    // official scoring changes — not ABS)
    if (combined.added && combined.added.length) {
      const alertable = combined.added.filter((e) => {
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
    if (combined.added.length || combined.updated.length || combined.ended.length) {
      // renderFeedUpdates() already repaints the header stats, the LIVE REVIEW
      // strip and the ⚠️ RUNS AT RISK banner (it calls renderStats /
      // renderActiveStrip / renderTabs after rebuilding the rows), so all of
      // those land with the FIRST response that carries them — not after the
      // slowest game in the wave. Verified by tools/review-watcher-test.mjs
      // §4b, which holds one game's playByPlay pending for 4s while a second
      // game's review banner is asserted on screen.
      renderFeedUpdates(combined);
    }
    // Alert now (chime + desktop notification) if this game's response
    // carries the first new/at-risk event of the poll — render above already
    // painted, sound must not wait for the slowest game in the slate.
    maybeAlertNow();
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
    return true;
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
    // Official-scorer pending rulings (hit / error / fielder's choice
    // undecided). The value is the number of rulings pending RIGHT NOW; the
    // tooltip also reports how many have been tracked today so the feed is
    // transparent about the history it keeps.
    const osEntries = entries.filter((e) => e.review.typeKey === 'pending_scoring');
    if (osEntries.length) {
      const osActive = osEntries.filter((e) => e.review.inProgress).length;
      const item = stat('Scoring Pending', osActive, 'stat-os-pending');
      item.title = `${osEntries.length} official-scorer ruling${osEntries.length === 1 ? '' : 's'} tracked today, ${osActive} still pending. ` +
        'A ruling decides how the play is charged (hit / error / fielder\u2019s choice) — it never removes a run from the score. ' +
        'Detected only from the official StatsAPI event types os_ruling_pending_primary / os_ruling_pending_prior ("Official Scorer Ruling Pending", GET /api/v1/eventTypes).';
      wrap.appendChild(item);
    }
    // Official scoring changes (hit ↔ error, single ↔ double, out ↔ hit,
    // …) observed by diffing the official play-by-play between polls.
    const scEntries = entries.filter((e) => e.review.typeKey === 'scoring_change');
    if (scEntries.length) {
      let irregularTotal = 0;
      scoringIrregularities.forEach((notes) => { irregularTotal += notes.length; });
      const item = stat('Scoring Changes', scEntries.length, 'stat-scoring-change');
      item.title = `${scEntries.length} official scoring change${scEntries.length === 1 ? '' : 's'} tracked today — plays whose official hit/error/out ` +
        'classification changed between polls (initial call and final ruling both observed). ' +
        'Detected only by diffing the official play-by-play payload; the API carries no scoring-change marker. ' +
        `Official log: mlb.com/official-information/scoring-changes.` +
        (irregularTotal ? ` ${irregularTotal} irregularit${irregularTotal === 1 ? 'y' : 'ies'} flagged for review (see the Scoring Changes tab).` : '');
      wrap.appendChild(item);
    }
    wrap.appendChild(stat('Overturned', entries.filter((e) => e.review.outcome === 'overturned').length, 'stat-overturned'));
    wrap.appendChild(stat('Stands / Upheld', entries.filter((e) => e.review.outcome === 'stands').length, 'stat-stands'));
    // \"Under Review\" is a replay-review counter; official-scorer pending
    // rulings are counted by their own Scoring Pending stat above.
    const inProgress = entries.filter((e) => e.review.inProgress && e.review.typeKey !== 'pending_scoring');
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

    // Official-scorer pending rulings — their own live strip, distinct from
    // replay reviews ("LIVE REVIEW" would be wrong for a scoring decision).
    const osEntries = [];
    feedState.seen.forEach((entry) => {
      if (entry.review && entry.review.typeKey === 'pending_scoring' &&
          entry.review.inProgress) osEntries.push(entry);
    });
    if (osEntries.length) {
      const osBar = el('div', 'feed-active-strip feed-active-strip-os');
      osBar.appendChild(el('span', 'feed-active-badge feed-active-badge-os', '⚖️ SCORING PENDING'));
      osEntries.forEach((entry) => {
        const g = games.find((x) => x.gamePk === entry.gamePk);
        if (!g) return;
        const item = el('a', 'feed-active-link feed-active-link-os', '',
          { href: `game.html?gamePk=${entry.gamePk}` });
        item.appendChild(el('span', 'feed-active-game', matchupFor(entry, g)));
        item.appendChild(el('span', 'feed-active-type', entry.review.reviewType));
        if (entry.review.reason) {
          item.appendChild(el('span', 'feed-active-reason', entry.review.reason));
        }
        if (entry.review.battingTeamAbbrev || entry.review.battingTeamName) {
          const teamChip = el('span', 'feed-active-team',
            `Batting: ${entry.review.battingTeamAbbrev || entry.review.battingTeamName}`);
          if (entry.review.battingTeamName) teamChip.title = entry.review.battingTeamName;
          item.appendChild(teamChip);
        }
        osBar.appendChild(item);
      });
      wrap.appendChild(osBar);
    }

    const activeGames = new Map();

    feedState.seen.forEach((entry, key) => {
      // Official-scorer pending rulings have their own strip above; they are
      // never labeled "LIVE REVIEW" (a scoring decision is not a replay).
      if (entry.review.inProgress && entry.review.typeKey !== 'pending_scoring') {
        if (!activeGames.has(entry.gamePk)) activeGames.set(entry.gamePk, []);
        activeGames.get(entry.gamePk).push(entry);
      }
    });
    // A game whose official status says it is under review right now —
    // statusCode M*/N*/IH (registry-verified), not a word match, so a
    // crew-chief "Instant Replay" appears here too.
    games.forEach((g) => {
      if (isReviewStatusCode(g && g.status) && !activeGames.has(g.gamePk)) {
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
      // Official reason: from the feed row when we have one, else straight off
      // the game status (`status.reason` — "Tag play", "Home run", "Pitch
      // Result", …, all verbatim from GET /api/v1/gameStatus). That is what
      // makes this strip informative on the very first poll after the status
      // flips, before the play description carries any review text at all.
      const statusReason = !entries.length &&
        typeof (g.status && g.status.reason) === 'string' && g.status.reason.trim()
        ? g.status.reason.trim() : null;
      const reasonText = entries.length ? entries[0].review.reason : statusReason;
      if (reasonText) {
        item.appendChild(el('span', 'feed-active-reason', reasonText));
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
      // \"Under Review\" is a REPLAY-review surface; official-scorer pending
      // rulings are counted on their own Scoring Pending tab.
      live: entries.filter((e) => e.review.inProgress && e.review.typeKey !== 'pending_scoring').length,
      runrisk: entries.filter((e) => runsRemovableFromReview(e.review) > 0).length,
      pending_scoring: entries.filter((e) => e.review.typeKey === 'pending_scoring').length,
      scoring: entries.filter((e) => e.review.typeKey === 'scoring_change').length,
    };
    const tabs = [
      ['all', `All (${counts.all})`],
      ['scoring', `✏️ Scoring Changes (${counts.scoring})`],
      ['pending_scoring', `⚖️ Scoring Pending (${counts.pending_scoring})`],
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
        !games.length
          ? 'No games scheduled for this date.'
          : filter === 'scoring'
            ? 'No official scoring changes observed yet — the tracker snapshots every completed play and diffs each poll; when the official scorer changes a hit/error/out ruling, the initial call and final ruling appear here.'
            : 'No challenges or replay reviews in this category yet — events will appear here live.'));
      return;
    }
    if (filter === 'scoring') renderScoringIrregularities(wrap);
    sortFeedEntries(entries).forEach((entry) => wrap.appendChild(feedRow(entry)));
  }

  /**
   * Irregularities flagged for review, shown at the top of the ✏️ Scoring
   * Changes tab: official payload changes observed WITHOUT a hit/error/out
   * reclassification (description / RBI / score edits), or tracked plays
   * that vanished from the payload. Displayed exactly as observed — never
   * corrected, never hidden.
   */
  function renderScoringIrregularities(wrap) {
    const all = [];
    scoringIrregularities.forEach((notes, gamePk) => {
      const g = games.find((x) => x.gamePk === gamePk) || null;
      const label = g ? gameTeamsLabel(g, teamsById) : `Game ${gamePk}`;
      (notes || []).forEach((note) => all.push({ label, note }));
    });
    if (!all.length) return;
    const flag = el('div', 'scoring-irregularities');
    const head = el('div', 'scoring-irregularities-head',
      `⚑ ${all.length} irregularit${all.length === 1 ? 'y' : 'ies'} flagged for review`);
    head.title = 'Official payload changes observed WITHOUT a hit/error/out reclassification ' +
      '(description / RBI / score edits), or tracked plays that vanished from the payload. ' +
      'Shown exactly as observed — never corrected or hidden.';
    flag.appendChild(head);
    all.slice(0, 8).forEach(({ label, note }) => {
      flag.appendChild(el('div', 'scoring-irregularity', `${label} — ${note}`));
    });
    if (all.length > 8) {
      flag.appendChild(el('div', 'scoring-irregularity',
        `…and ${all.length - 8} more (full list in the browser console)`));
    }
    wrap.appendChild(flag);
  }

  function matchesFilter(entry) {
    // The All section shows every category EXCEPT ABS pitch challenges:
    // challenges, reviews, boundary calls, under review, runs at risk, and
    // official scoring changes (which also have their own ✏️ tab below).
    // ABS entries stay tracked in the feed state — they render under the
    // "ABS" tab (and wherever else their category applies: the Under
    // Review tab, active strip, run-at-risk surfaces).
    if (filter === 'all') return visibleInAllFeed(entry && entry.review);
    if (filter === 'live') return entry.review.inProgress && entry.review.typeKey !== 'pending_scoring';
    if (filter === 'runrisk') return runsRemovableFromReview(entry.review) > 0;
    if (filter === 'pending_scoring') return entry.review.typeKey === 'pending_scoring';
    if (filter === 'scoring') return entry.review.typeKey === 'scoring_change';
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
    // Official-scorer pending / scoring-change rows: the batting side (from
    // halfInning + official team ids) is context, not a "challenging team" —
    // no challenge counter.
    if ((r.typeKey === 'pending_scoring' || r.typeKey === 'scoring_change') &&
        (r.battingTeamAbbrev || r.battingTeamName)) {
      const bat = el('span', 'feed-batting',
        `Batting: ${r.battingTeamAbbrev || r.battingTeamName}`);
      if (r.battingTeamName) bat.title = r.battingTeamName;
      head.appendChild(bat);
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

    if (r.typeKey === 'scoring_change') {
      // Official scoring change: the initial call → final ruling block
      // replaces the generic reason/description lines (which would only
      // duplicate the final ruling).
      body.appendChild(scoringChangeBlock(r));
    } else {
      const title = el('div', 'feed-reason', r.reason);
      body.appendChild(title);

      if (window.MLBReviews && window.MLBReviews.renderScoreImpact) {
        const scoreImpact = window.MLBReviews.renderScoreImpact(r, 'feed');
        if (scoreImpact) body.appendChild(scoreImpact);
      }

      const desc = el('div', 'feed-desc', r.description);
      body.appendChild(desc);

      // Official-scorer pending rulings: show both the pending description and
      // the resolved ruling (hit/error/fielder's choice) when available.
      if (r.typeKey === 'pending_scoring' && r.resolvedDescription) {
        const resolved = el('div', 'feed-resolved', `Resolved as: ${r.resolvedDescription}`);
        resolved.title = 'Official scorer ruling: the play was charged as shown above.';
        body.appendChild(resolved);
      }
    }

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
      r.outcome === 'confirmed' ? 'outcome-confirmed' :
      r.outcome === 'resolved' ? 'outcome-resolved' :
      r.outcome === 'changed' ? 'outcome-changed' : 'outcome-stands';
    const icon = r.inProgress ? '⚡ ' :
      r.outcome === 'resolved' ? '✓ ' :
      r.outcome === 'overturned' ? '✓ ' :
      r.outcome === 'changed' ? '✏️ ' : '✗ ';
    return el('span', `review-outcome-pill ${cls}`, `${icon}${r.outcomeLabel}`);
  }

  /**
   * The initial-call → final-ruling block of one official scoring-change row
   * (the row head — matchup, chip, batting side, inning, pill — and the
   * batter/pitcher footer are rendered by feedRow like every other row).
   * Everything here is observed data: labels are the payload's own
   * result.event text, timestamps are the polls that observed each ruling,
   * and the scores are the payload's own result.awayScore/homeScore.
   */
  function scoringChangeBlock(r) {
    const block = el('div', 'feed-scoring');
    const headline = el('div', 'feed-scoring-headline');
    headline.appendChild(el('span', `feed-scoring-call feed-scoring-call-${r.initial.category}`, r.initial.label));
    headline.appendChild(el('span', 'feed-scoring-arrow', '→'));
    headline.appendChild(el('span', `feed-scoring-call feed-scoring-call-${r.final.category}`, r.final.label));
    if (r.changeCount > 1) {
      const multi = el('span', 'feed-scoring-multiple', `${r.changeCount} rulings observed`);
      multi.title = r.previousHeadline
        ? `Ruling history: ${r.previousHeadline}, then ${r.reason}. Flagged for review — multiple official rulings on one play are rare.`
        : 'Flagged for review — multiple official rulings on one play are rare.';
      headline.appendChild(multi);
    }
    block.appendChild(headline);

    const obsTime = (iso) => {
      const t = iso ? new Date(iso) : null;
      return t && !Number.isNaN(t.getTime())
        ? t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : null;
    };
    const initialWhen = obsTime(r.initialObservedAt);
    if (r.initialDescription) {
      const initLine = el('div', 'feed-scoring-line feed-scoring-initial',
        `Initial call${initialWhen ? ` (observed ${initialWhen})` : ''}: ${r.initialDescription}`);
      initLine.title = 'The official classification this play carried when this page first observed it — ' +
        'read from the official play-by-play payload on an earlier poll.';
      block.appendChild(initLine);
    }
    if (r.description && r.description !== r.initialDescription) {
      block.appendChild(el('div', 'feed-scoring-line feed-scoring-final', `Final ruling: ${r.description}`));
    }
    if (r.scoreAfter) {
      const changedScore = r.initialScoreAfter &&
        (r.initialScoreAfter.away !== r.scoreAfter.away || r.initialScoreAfter.home !== r.scoreAfter.home);
      block.appendChild(el('div', 'feed-scoring-line feed-scoring-score',
        `Official score after play: ${r.scoreAfter.away}–${r.scoreAfter.home}` +
        (changedScore ? ` (was ${r.initialScoreAfter.away}–${r.initialScoreAfter.home} on the initial call)` : '')));
    }
    if (r.mechanism && isUsableName(r.mechanism.label)) {
      const mech = el('div', 'feed-scoring-line feed-scoring-mechanism', r.mechanism.label);
      mech.title = r.mechanism.key === 'replay_review'
        ? 'The play carries the official replay-review flag (about.hasReview) or a review was active for this at-bat when the change landed. The outcome is tracked on its replay-review row in this feed.'
        : r.mechanism.key === 'pending_ruling'
          ? 'The play carried the official "Official Scorer Ruling Pending" marker before this change — also tracked on its ⚖️ Scoring Pending row.'
          : 'No replay review was observed for this play. Per MLB\u2019s official log, scoring changes are made by the Official Scorer, the Elias Sports Bureau, or after a player/club review: mlb.com/official-information/scoring-changes.';
      block.appendChild(mech);
    }
    if (Array.isArray(r.flags) && r.flags.length) {
      const flag = el('div', 'feed-challenges feed-challenges-flag', `⚠️ ${r.flags.join('; ')}`);
      flag.title = 'Flagged for review — shown exactly as observed, never corrected or guessed.';
      block.appendChild(flag);
    }
    return block;
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
    // Registry-based: the official statusCode/codedGameState, so a crew-chief
    // "Instant Replay" (IH) drops the poll to the fast cadence too.
    return games.some((g) => isReviewStatusCode(g && g.status));
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
    // The watcher has its own timer; a hidden tab must stop sweeping too.
    stopReviewStatus();
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

  /* ------------------------------------------------ review-status watcher */

  /**
   * Watcher cadence. Fast only while a review is possible: a review cannot
   * start on a game that has not started, so a slate with nothing Live backs
   * off to 5s and the watcher costs nothing overnight.
   */
  function reviewStatusIntervalMs() {
    const canReview = games.some((g) => g && g.status &&
      (g.status.abstractGameState === 'Live' || isReviewStatusCode(g.status)));
    return canReview ? REVIEW_STATUS_POLL_MS : REVIEW_STATUS_IDLE_MS;
  }

  function scheduleReviewStatus() {
    clearTimeout(reviewStatusTimer);
    // A hidden tab parks at the idle cadence instead of spinning at 250ms
    // (stopPolling() normally clears this timer outright; this is the safety
    // net for a tab hidden between ticks).
    const wait = document.hidden
      ? REVIEW_STATUS_IDLE_MS : reviewStatusIntervalMs();
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
   * One sweep. Never throws: the ordinary schedule cache keeps refreshing
   * status on its 3s tick no matter what happens here, so a failed sweep is
   * silently retried on the next tick rather than surfaced as an error.
   */
  async function pollReviewStatus() {
    // No endpoint = no feature (api.js always ships it on reviews.html). Stop
    // rather than park a timer that can never do anything.
    if (!MLB.getReviewStatus) return;
    // A sweep must never overlap itself: the in-flight one reschedules in its
    // own finally, so this call simply drops.
    if (reviewStatusInFlight) return;
    const requestDate = dateStr;
    reviewStatusInFlight = true;
    try {
      const list = await MLB.getReviewStatus(requestDate,
        { timeout: REVIEW_STATUS_TIMEOUT_MS, retries: 0 });
      if (requestDate !== dateStr) return;
      const diff = reviewStatusFlips(reviewStatusCodes, list);
      reviewStatusCodes = diff.codes;
      if (diff.changed.length) {
        mergeReviewStatusIntoGames(list);
        reviewStatusFlipPending = true;
        // Paint the "LIVE REVIEW" strip from the status alone, right now —
        // the full feed row (batter/pitcher, score impact, runs at risk)
        // follows from the out-of-band scan kicked off just below. Only the
        // strip is touched: a full render() here could race the in-flight
        // scan's incremental row updates.
        renderActiveStrip();
        load();
      }
    } catch (err) {
      // Deliberately quiet: see the doc comment above.
    } finally {
      reviewStatusInFlight = false;
      scheduleReviewStatus();
    }
  }

  /**
   * Copy the watcher's fresh official status onto the matching `games`
   * entries so every consumer of `games` — ingestGame's pseudo-feed,
   * reviewFetchPriority, hasActiveReviewSignal, renderActiveStrip — sees the
   * current status without waiting for the 3s hydrated-schedule refresh.
   * Merged field-by-field: a projected sweep must never delete a status field
   * the hydrated schedule supplied.
   */
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
    // Test seam: force-write this date's feed log now (returns true when
    // saved). The page itself saves automatically after every changing poll.
    _flushFeedLog() { return saveFeedLogNow(); },
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
      if (!document.hidden) {
        load();
        // Catch up on anything that started while the tab was hidden — one
        // sweep now, then back to the watcher cadence.
        pollReviewStatus();
      } else {
        // Flush the log on hide: a refresh or a closed tab must keep every
        // entry tracked so far.
        saveFeedLogNow();
        stopPolling();
      }
    });
    try {
      if (typeof window.addEventListener === 'function') {
        // Last-resort flush for refresh/close/navigation (the visibility
        // handler above already covers tab-hide; this covers the rest).
        window.addEventListener('pagehide', () => { saveFeedLogNow(); });
      }
    } catch (_) {}
    // Restore this date's logged feed BEFORE the first scan, and paint it
    // immediately: a refresh or a later visit shows every logged entry on
    // the first paint, and the first poll diffs against the restored
    // baselines instead of starting over.
    restorePersistedLog();
    render();
    syncFeedLogFromServer();
    load();
    // First sweep immediately rather than one cadence later: a page opened
    // mid-review must show the review on the first paint, and the sweep also
    // seeds reviewStatusCodes so later polls diff correctly.
    pollReviewStatus();
  });

  /* Node test export (pure helpers only). */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      buildEventKey, mergeFeedEvents, reconcileScoreImpact, reviewChanged,
      completePendingScoringReview,
      sortFeedEntries, gameTeamsLabel,
      isUsableName, officialTeamName, gameSideTeam,
      pollIntervalMs, waitAfterScan, reviewFetchPriority, mapPool,
      isReviewStatusCode, reviewStatusFlips,
      shouldAlertForReview, visibleInAllFeed,
      runsRemovableFromReview, shouldRunRiskAlert, diffRunRiskKeys,
      normalizeChallengeCounts, challengeCountIrregularities,
      teamSideInGame, teamChallengeLine, gameChallengeLine,
      // Official scoring-change tracker (pure layer)
      SCORING_CHANGE_TYPE_KEY, SCORING_CHANGE_LABEL,
      SCORING_HIT_EVENT_TYPES, SCORING_PA_ERROR_EVENT_TYPES,
      SCORING_RUNNER_ERROR_EVENT_TYPES, SCORING_PENDING_EVENT_TYPES,
      buildScoringSnapshot, scoringSnapshotSignature, scoringCategory,
      scoringEventLabel, scoringInningLabel, scoringMechanism,
      scoringChangeSummary, mergeScoringChanges, finalScanDecision,
      // Feed-log persistence (pure layer — every tracked entry survives a
      // refresh / revisit via a per-date localStorage log)
      FEED_LOG_VERSION, FEED_LOG_KEY_PREFIX, FEED_LOG_INDEX_KEY,
      FEED_LOG_MAX_ENTRIES, FEED_LOG_MAX_SNAPSHOTS_PER_GAME,
      FEED_LOG_MAX_IRREGULARITIES_PER_GAME, FEED_LOG_MAX_DATES,
      feedLogStorageKey, isFeedLogDateStr,
      serializeFeedLog, restoreFeedLog, pruneFeedLogIndex,
    };
  }
})();
