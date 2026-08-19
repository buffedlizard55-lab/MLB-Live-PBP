/* ============================================================================
 * reviews.js — Replay Reviews, Manager Challenges & ABS Challenges Parser & UI
 * ----------------------------------------------------------------------------
 * Extracts, normalizes, and aggregates all replay review and challenge events
 * from the MLB StatsAPI (Manager Challenges, Crew Chief Reviews, Umpire Reviews,
 * and ABS Automated Ball-Strike System Challenges).
 * ==========================================================================*/
'use strict';

const MLBReviews = (() => {
  /**
   * MLB StatsAPI sends SHORT CODES in `reviewDetails.reviewType`, not full
   * sentences. Verified against live feeds (statsapi.mlb.com, 2026-08-19):
   *
   *   "MJ"  → ABS (Automated Ball-Strike) pitch challenge. Attached to a pitch
   *           event (older pattern) or to the play itself with text like
   *           "… challenged (pitch result), call on the field was …".
   *           Matches feed.gameData.absChallenges.{away,home}.usedSuccessful/
   *           usedFailed counts. (Verified in games 823342, 823667, 824075.)
   *   "MA"  → Manager challenge on a play. Play-level reviewDetails with text
   *           like "Tigers challenged (tag play), call on the field was
   *           overturned: …". (Verified in game 823341.)
   *   "MF"  → Manager challenge on a play. Same shape. (Verified in game 824075:
   *           "Royals challenged (play at 1st), call on the field was …".)
   *
   * Other M-prefixed codes are treated the same as MA/MF (traditional play
   * reviews); unknown codes fall back to description-text detection and then
   * to a generic "Replay Review" label — we never invent labels for codes we
   * have not observed.
   */
  function normalizeType(rawType, text) {
    const combined = `${rawType || ''} ${text || ''}`.toLowerCase();
    const raw = String(rawType || '').trim();

    // 1. Explicit ABS language in the description wins (covers feeds whose
    //    text says "ABS Challenge (…)"/"pitch result" without a reviewType code).
    if (combined.includes('abs') || combined.includes('automated ball-strike') ||
        combined.includes('ball-strike') || combined.includes('pitch challenge') ||
        /pitch result/i.test(combined)) {
      return { key: 'abs', label: 'ABS Challenge' };
    }

    // 2. Short code from reviewDetails.reviewType (observed values above).
    if (/^[A-Za-z]{1,4}$/.test(raw)) {
      const code = raw.toUpperCase();
      if (code === 'MJ') return { key: 'abs', label: 'ABS Challenge' };
      if (code.startsWith('M')) return { key: 'manager', label: 'Manager Challenge' };
      // Unverified codes: label honestly as a generic replay review.
      return { key: 'review', label: 'Replay Review' };
    }

    // 3. Full-text detection for feeds that use human-readable types.
    if (combined.includes('crew chief') || combined.includes('umpire review') || combined.includes('crew_chief')) {
      return { key: 'crew_chief', label: 'Crew Chief Review' };
    }
    if (combined.includes('manager') || combined.includes('challenge')) {
      return { key: 'manager', label: 'Manager Challenge' };
    }
    if (combined.includes('rule') || combined.includes('record')) {
      return { key: 'rules', label: 'Rules Check' };
    }
    return { key: 'review', label: rawType || 'Replay Review' };
  }

  /**
   * Extract a concise review reason / topic from play/event descriptions.
   */
  function extractReason(text) {
    if (!text) return 'Play under review';
    const clean = String(text);

    // Common MLB review description patterns (real feeds use "challenged"):
    // "Manager challenge (call at 1st base): ..."
    // "Tigers challenged (tag play), call on the field was overturned: ..."
    // "Crew chief review (home run): ..."
    // "ABS challenge (called strike): ..."
    const parenMatch = clean.match(/(?:challeng\w*|review|replay)\s*\(([^)]+)\)/i);
    if (parenMatch) return parenMatch[1].trim();

    // Specific baseball review trigger patterns
    if (/home run|boundary|fan interference|over the wall/i.test(clean)) return 'Home Run / Boundary Call';
    // Real ABS pitch-challenge events carry bare descriptions on the reviewed
    // pitch ("Ball", "Called Strike") with reviewDetails.reviewType "MJ".
    if (/^(?:ball|called strike|foul|swinging strike|missed bunt|ball in dirt)$/i.test(clean) ||
        /ball[-\s]strike|called (?:strike|ball)|abs challenge|pitch result/i.test(clean)) {
      return 'Ball / Strike Call (ABS)';
    }
    if (/tag(?:ged)?|slide|safe|out at (?:1st|2nd|3rd|home)/i.test(clean)) {
      const baseMatch = clean.match(/(?:at|on)\s+([123]st|[123]nd|[123]rd|first|second|third|home)(?:\s+base)?/i);
      return baseMatch ? `Tag / Force Play at ${baseMatch[1]}` : 'Tag / Force Play';
    }
    if (/force out|force play/i.test(clean)) return 'Force Play';
    if (/catch|trap|fair\/foul|line drive/i.test(clean)) return 'Catch / Trap / Fair-Foul';
    if (/hit by pitch|hbp/i.test(clean)) return 'Hit by Pitch';
    if (/collision|blocking the plate|slide rule/i.test(clean)) return 'Collision / Slide Rule';
    if (/count|score|record/i.test(clean)) return 'Count / Record Keeping';

    return 'Play Review';
  }

  /**
   * Determine the outcome of a review.
   */
  function determineOutcome(reviewDetails, text, inProgressState) {
    if (inProgressState || (reviewDetails && reviewDetails.inProgress)) {
      return { key: 'in_progress', label: 'In Progress', isOverturned: null };
    }

    if (reviewDetails && typeof reviewDetails.isOverturned === 'boolean') {
      if (reviewDetails.isOverturned) {
        return { key: 'overturned', label: 'Call Overturned', isOverturned: true };
      }
      return { key: 'stands', label: 'Call Stands', isOverturned: false };
    }

    const t = (text || '').toLowerCase();
    if (t.includes('overturned') || t.includes('call was overturned') || t.includes('call overturned')) {
      return { key: 'overturned', label: 'Call Overturned', isOverturned: true };
    }
    if (t.includes('call stands') || t.includes('call was upheld') || t.includes('stands')) {
      return { key: 'stands', label: 'Call Stands', isOverturned: false };
    }
    if (t.includes('confirmed') || t.includes('call was confirmed')) {
      return { key: 'confirmed', label: 'Call Confirmed', isOverturned: false };
    }
    if (t.includes('under review') || t.includes('in review') || t.includes('review in progress')) {
      return { key: 'in_progress', label: 'In Progress', isOverturned: null };
    }

    return { key: 'completed', label: 'Review Completed', isOverturned: false };
  }

  /**
   * Helper to format inning label from about object.
   */
  function formatInning(about) {
    if (!about || !about.inning) return '';
    const half = (about.halfInning || '').toLowerCase();
    const glyph = half === 'top' ? '▲' : half === 'bottom' ? '▼' : '';
    const num = MLB.ordinal ? MLB.ordinal(about.inning) : `${about.inning}th`;
    return `${glyph} ${half === 'top' ? 'Top' : 'Bot'} ${num}`.trim();
  }

  /**
   * Extract all reviews from a live game feed payload.
   * Scans feed.liveData.plays.allPlays, currentPlay, playEvents, and game status.
   *
   * Handles both real-world feed patterns (verified against statsapi.mlb.com):
   *   - play-level  reviewDetails (manager challenges: "MA"/"MF", rich text)
   *   - event-level reviewDetails on pitch events (ABS challenges: "MJ")
   * When a play has BOTH (e.g. an ABS pitch event plus a play-level manager
   * challenge), one entry per review TYPE is kept — the play-level entry wins
   * for the same type because it carries the full description.
   */
  function extractReviews(feed) {
    if (!feed) return { reviews: [], activeReview: null, summary: emptySummary() };

    const liveData = feed.liveData || {};
    const gameData = feed.gameData || {};
    const playsData = liveData.plays || {};
    const allPlays = playsData.allPlays || [];
    const currentPlay = playsData.currentPlay || null;
    const status = (gameData.status && gameData.status.detailedState) || '';
    const isGameInReviewStatus = /challenge|review/i.test(status);

    const teamNames = {};
    if (gameData.teams) {
      ['away', 'home'].forEach((side) => {
        const t = gameData.teams[side];
        if (t && t.id != null) {
          // Official values only. feed/live teams carry `abbreviation`
          // (verified live: gameData.teams.away.abbreviation === "DET");
          // schedule-based pseudo-feeds carry only { id, name, link }, in
          // which case abbrev stays null and the caller resolves it from
          // MLB.getTeams(). An abbreviation is never fabricated from the name
          // (name.slice(0,3) produced wrong codes like "SAN"/"CHI"/"LOS").
          teamNames[t.id] = {
            name: t.name || null,
            abbrev: t.abbreviation || null,
            side,
          };
        }
      });
    }

    // One entry per `atBatIndex:typeKey` — play-level entries replace
    // event-level entries of the same type (they have the full description).
    const entriesByKey = new Map();

    function buildEntry({ id, about, result, matchup, revDetails, desc, outcome, typeMeta, challengeTeamId, isPitch, pitchVelo, timestamp }) {
      const team = challengeTeamId ? teamNames[challengeTeamId] : null;
      return {
        id,
        atBatIndex: about.atBatIndex != null ? about.atBatIndex : null,
        inning: about.inning || 1,
        halfInning: about.halfInning || 'top',
        inningLabel: formatInning(about),
        reviewType: typeMeta.label,
        typeKey: typeMeta.key,
        teamId: challengeTeamId,
        teamName: team ? team.name : null,
        teamAbbrev: team ? team.abbrev : null,
        inProgress: outcome.key === 'in_progress',
        isOverturned: outcome.isOverturned,
        outcome: outcome.key,
        outcomeLabel: outcome.label,
        reason: extractReason(desc),
        description: desc || 'Play reviewed.',
        timestamp,
        isPitch: !!isPitch,
        pitchVelo,
        batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
        pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
      };
    }

    function processPlay(play, isLiveCurrent = false) {
      if (!play) return;
      const about = play.about || {};
      const result = play.result || {};
      const matchup = play.matchup || {};
      const playEvents = play.playEvents || [];
      const playReviewDetails = play.reviewDetails || null;
      const hasPlayReview = about.hasReview === true || !!playReviewDetails;

      // 1. Event-level candidates (ABS pitch challenges, older feed pattern).
      playEvents.forEach((event, evIdx) => {
        const details = event.details || {};
        const eventReviewDetails = event.reviewDetails || null;
        const hasEventReview = details.hasReview === true || !!eventReviewDetails;
        const desc = details.description || details.event || '';
        const isReviewText = /challenge|review|overturned|call stands|call confirmed|abs\b/i.test(desc);

        if (!(hasEventReview || (hasPlayReview && isReviewText) || (isReviewText && details.eventType === 'review'))) return;

        const revDetails = eventReviewDetails || playReviewDetails || {};
        const isCurrentActive = isLiveCurrent && (revDetails.inProgress || (!about.isComplete && isGameInReviewStatus));
        const outcome = determineOutcome(revDetails, desc || result.description, isCurrentActive);
        const typeMeta = normalizeType(revDetails.reviewType, desc || result.description);
        const mapKey = `${about.atBatIndex || 0}:${typeMeta.key}`;

        if (!entriesByKey.has(mapKey)) {
          entriesByKey.set(mapKey, buildEntry({
            id: `play-${about.atBatIndex || 0}-ev-${evIdx}`,
            about, result, matchup, revDetails,
            desc: desc || result.description || 'Play reviewed.',
            outcome, typeMeta,
            challengeTeamId: revDetails.challengeTeamId || null,
            isPitch: event.isPitch,
            pitchVelo: event.pitchData && event.pitchData.startSpeed ? Math.round(event.pitchData.startSpeed) : null,
            timestamp: event.startTime || about.endTime || about.startTime || null,
          }));
        }
      });

      // 2. Play-level review (manager challenges "MA"/"MF" — newer pattern).
      const playDesc = result.description || '';
      const isPlayReviewText = /challenge|review|overturned|call stands|call confirmed/i.test(playDesc);
      if (hasPlayReview || isPlayReviewText) {
        const revDetails = playReviewDetails || {};
        const isCurrentActive = isLiveCurrent && (revDetails.inProgress || (!about.isComplete && isGameInReviewStatus));
        const outcome = determineOutcome(revDetails, playDesc, isCurrentActive);
        const typeMeta = normalizeType(revDetails.reviewType, playDesc);
        const mapKey = `${about.atBatIndex || 0}:${typeMeta.key}`;

        // A bare play-flag (about.hasReview) with no play-level reviewDetails
        // and no review text adds nothing beyond an event entry already
        // captured for the same at-bat — don't mint a generic duplicate.
        if (!playReviewDetails && !isPlayReviewText && typeMeta.key === 'review') {
          const hasSameBatEntries = [...entriesByKey.keys()]
            .some((k) => k.startsWith(`${about.atBatIndex || 0}:`));
          if (hasSameBatEntries) return;
        }

        // Play-level wins over a same-type event-level entry: it carries the
        // complete "Team challenged (reason), call on the field was …" text.
        entriesByKey.set(mapKey, buildEntry({
          id: `play-${about.atBatIndex || 0}-main`,
          about, result, matchup, revDetails,
          desc: playDesc || 'Play reviewed.',
          outcome, typeMeta,
          challengeTeamId: revDetails.challengeTeamId || null,
          isPitch: false,
          pitchVelo: null,
          timestamp: about.endTime || about.startTime || null,
        }));
      }
    }

    // Process all plays
    allPlays.forEach((play) => processPlay(play, false));

    // Check current play
    if (currentPlay) {
      processPlay(currentPlay, true);
    }

    const reviews = [...entriesByKey.values()];

    // If game state explicitly says "Manager Challenge" or "Review" but no in-progress review recorded yet:
    if (isGameInReviewStatus && !reviews.some((r) => r.inProgress)) {
      const activeTypeMeta = normalizeType(status, status);
      const cp = currentPlay || (allPlays.length ? allPlays[allPlays.length - 1] : null) || {};
      const about = cp.about || {};
      const matchup = cp.matchup || {};
      const activeEntry = {
        id: 'live-active-review',
        atBatIndex: about.atBatIndex != null ? about.atBatIndex : null,
        inning: about.inning || (liveData.linescore && liveData.linescore.currentInning) || 1,
        halfInning: about.halfInning || (liveData.linescore && liveData.linescore.inningState === 'Top' ? 'top' : 'bottom'),
        inningLabel: formatInning(about) || (liveData.linescore ? `${liveData.linescore.inningState || ''} ${liveData.linescore.currentInningOrdinal || ''}` : ''),
        reviewType: activeTypeMeta.label,
        typeKey: activeTypeMeta.key,
        teamId: null,
        teamName: null,
        teamAbbrev: null,
        inProgress: true,
        isOverturned: null,
        outcome: 'in_progress',
        outcomeLabel: 'In Progress',
        reason: 'Call under replay review',
        description: (cp.result && cp.result.description) || 'Play currently under review.',
        timestamp: new Date().toISOString(),
        isPitch: false,
        pitchVelo: null,
        batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
        pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
      };
      reviews.unshift(activeEntry);
    }

    // Sort: in-progress first, then newest to oldest
    reviews.sort((a, b) => {
      if (a.inProgress && !b.inProgress) return -1;
      if (!a.inProgress && b.inProgress) return 1;
      return (b.atBatIndex || 0) - (a.atBatIndex || 0);
    });

    const activeReview = reviews.find((r) => r.inProgress) || null;
    const summary = buildSummary(reviews);

    return { reviews, activeReview, summary };
  }

  function emptySummary() {
    return {
      total: 0,
      overturned: 0,
      stands: 0,
      inProgress: 0,
      overturnRate: '0.0%',
      byType: { manager: 0, crew_chief: 0, abs: 0, umpire: 0, rules: 0, review: 0 },
      byTeam: {},
    };
  }

  function buildSummary(reviews) {
    const summary = emptySummary();
    summary.total = reviews.length;

    reviews.forEach((r) => {
      if (r.inProgress) summary.inProgress += 1;
      else if (r.outcome === 'overturned') summary.overturned += 1;
      else summary.stands += 1;

      summary.byType[r.typeKey] = (summary.byType[r.typeKey] || 0) + 1;

      if (r.teamId) {
        if (!summary.byTeam[r.teamId]) {
          summary.byTeam[r.teamId] = {
            teamId: r.teamId,
            teamName: r.teamName,
            teamAbbrev: r.teamAbbrev,
            total: 0,
            overturned: 0,
            stands: 0,
          };
        }
        summary.byTeam[r.teamId].total += 1;
        if (r.outcome === 'overturned') summary.byTeam[r.teamId].overturned += 1;
        else if (!r.inProgress) summary.byTeam[r.teamId].stands += 1;
      }
    });

    const completed = summary.overturned + summary.stands;
    summary.overturnRate = completed > 0
      ? `${((summary.overturned / completed) * 100).toFixed(1)}%`
      : '—';

    return summary;
  }

  /**
   * Check if a game on the scoreboard schedule has an active challenge or review.
   */
  function inspectScheduleGame(game) {
    if (!game) return { hasActiveReview: false, typeLabel: null };
    const status = game.status || {};
    const detailed = status.detailedState || '';
    const isReview = /challenge|review/i.test(detailed);
    if (isReview) {
      const typeMeta = normalizeType(detailed, detailed);
      return { hasActiveReview: true, typeLabel: typeMeta.label };
    }
    const ls = game.linescore;
    if (ls && ls.lastPlay && ls.lastPlay.about && ls.lastPlay.about.hasReview && status.abstractGameState === 'Live') {
      return { hasActiveReview: true, typeLabel: 'Review in Progress' };
    }
    return { hasActiveReview: false, typeLabel: null };
  }

  /* ----------------------------------------------------------- UI Builders */

  /**
   * Render an eye-catching Live Alert banner for games with an active challenge/review.
   */
  function renderLiveAlertBanner(activeReview) {
    if (!activeReview) return null;
    const banner = UI.el('div', 'review-live-alert');
    const badge = UI.el('span', 'review-alert-badge', '🚨 LIVE REVIEW');
    const typeChip = UI.el('span', `chip-review-type chip-${activeReview.typeKey}`, activeReview.reviewType);
    const content = UI.el('div', 'review-alert-content');
    const title = UI.el('strong', 'review-alert-title',
      `${activeReview.teamAbbrev ? `${activeReview.teamAbbrev} ` : ''}${activeReview.reviewType}: ${activeReview.reason}`);
    const desc = UI.el('span', 'review-alert-desc', activeReview.description);
    content.appendChild(title);
    content.appendChild(desc);

    banner.appendChild(badge);
    banner.appendChild(typeChip);
    banner.appendChild(content);
    return banner;
  }

  /**
   * Render a review card for the dedicated Challenges & Reviews list.
   */
  function renderReviewCard(review) {
    const card = UI.el('div', `review-card ${review.inProgress ? 'review-card-active' : `review-card-${review.outcome}`}`);

    // Header: Inning, Type chip, Outcome chip, Timestamp
    const head = UI.el('div', 'review-card-head');
    const left = UI.el('div', 'review-card-head-left');
    if (review.inningLabel) {
      left.appendChild(UI.el('span', 'review-inn-badge', review.inningLabel));
    }
    left.appendChild(UI.el('span', `chip-review-type chip-${review.typeKey}`, review.reviewType));
    if (review.teamAbbrev) {
      left.appendChild(UI.el('span', 'review-team-tag', review.teamAbbrev));
    }
    head.appendChild(left);

    const right = UI.el('div', 'review-card-head-right');
    const outcomeCls = review.inProgress ? 'outcome-in-progress' :
      review.outcome === 'overturned' ? 'outcome-overturned' :
      review.outcome === 'confirmed' ? 'outcome-confirmed' : 'outcome-stands';
    const outcomeIcon = review.inProgress ? '⚡ ' : review.outcome === 'overturned' ? '✓ ' : '✗ ';
    right.appendChild(UI.el('span', `review-outcome-pill ${outcomeCls}`, `${outcomeIcon}${review.outcomeLabel}`));
    head.appendChild(right);
    card.appendChild(head);

    // Body: Reason headline + Play description
    const body = UI.el('div', 'review-card-body');
    body.appendChild(UI.el('h4', 'review-reason-title', review.reason));
    body.appendChild(UI.el('p', 'review-desc-text', review.description));
    card.appendChild(body);

    // Footer: Batter / Pitcher context (only when a name actually exists —
    // never render "Batter: undefined")
    if ((review.batter && review.batter.fullName) || (review.pitcher && review.pitcher.fullName)) {
      const foot = UI.el('div', 'review-card-foot');
      if (review.batter && review.batter.fullName) {
        foot.appendChild(UI.el('span', 'review-player-tag', `Batter: ${review.batter.fullName}`));
      }
      if (review.pitcher && review.pitcher.fullName) {
        foot.appendChild(UI.el('span', 'review-player-tag',
          `Pitcher: ${review.pitcher.fullName}${review.pitchVelo ? ` (${review.pitchVelo} mph)` : ''}`));
      }
      card.appendChild(foot);
    }

    return card;
  }

  /**
   * Render the full Challenges & Reviews tab view.
   */
  function renderReviewsTab(container, reviewData) {
    if (!container) return;
    UI.clear(container);

    const { reviews, activeReview, summary } = reviewData;

    // 1. Summary Stats Bar
    const statsBar = UI.el('div', 'reviews-summary-bar');
    const statItem = (lbl, val, cls) => {
      const b = UI.el('div', `review-stat-item ${cls || ''}`);
      b.appendChild(UI.el('span', 'review-stat-label', lbl));
      b.appendChild(UI.el('strong', 'review-stat-value', String(val)));
      return b;
    };
    statsBar.appendChild(statItem('Total Reviews', summary.total));
    statsBar.appendChild(statItem('Overturned', summary.overturned, 'stat-overturned'));
    statsBar.appendChild(statItem('Stands / Upheld', summary.stands, 'stat-stands'));
    statsBar.appendChild(statItem('Overturn Rate', summary.overturnRate));
    if (summary.inProgress > 0) {
      statsBar.appendChild(statItem('Under Review', summary.inProgress, 'stat-active-pulse'));
    }
    container.appendChild(statsBar);

    // 2. Active Review Live Callout if present
    if (activeReview) {
      const activeAlert = renderLiveAlertBanner(activeReview);
      if (activeAlert) container.appendChild(activeAlert);
    }

    // 3. List of Reviews / Challenges
    if (!reviews.length) {
      container.appendChild(UI.el('div', 'empty small',
        'No challenges or replay reviews in this game yet.'));
      return;
    }

    const list = UI.el('div', 'reviews-list');
    reviews.forEach((r) => list.appendChild(renderReviewCard(r)));
    container.appendChild(list);
  }

  return {
    normalizeType,
    extractReason,
    determineOutcome,
    extractReviews,
    inspectScheduleGame,
    renderLiveAlertBanner,
    renderReviewCard,
    renderReviewsTab,
  };
})();

// Export for browser window and Node test environments
if (typeof window !== 'undefined') {
  window.MLBReviews = MLBReviews;
}
if (typeof globalThis !== 'undefined') {
  globalThis.MLBReviews = MLBReviews;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MLBReviews;
}
