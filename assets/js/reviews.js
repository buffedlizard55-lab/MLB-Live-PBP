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
   * Determine the normalized review type key from raw string or event structure.
   */
  function normalizeType(rawType, text) {
    const combined = `${rawType || ''} ${text || ''}`.toLowerCase();
    if (combined.includes('abs') || combined.includes('automated ball-strike') || combined.includes('ball-strike') || combined.includes('pitch challenge')) {
      return { key: 'abs', label: 'ABS Challenge' };
    }
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

    // Common MLB review description patterns:
    // "Manager challenge (call at 1st base): ..."
    // "Crew chief review (home run): ..."
    // "ABS challenge (called strike): ..."
    const parenMatch = clean.match(/(?:challenge|review)\s*\(([^)]+)\)/i);
    if (parenMatch) return parenMatch[1].trim();

    // Specific baseball review trigger patterns
    if (/home run|boundary|fan interference|over the wall/i.test(clean)) return 'Home Run / Boundary Call';
    if (/ball[-\s]strike|called (?:strike|ball)|abs challenge/i.test(clean)) return 'Ball / Strike Call (ABS)';
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
        if (t && t.id) {
          teamNames[t.id] = { name: t.name, abbrev: t.abbreviation || t.name.slice(0, 3).toUpperCase(), side };
        }
      });
    }

    const reviews = [];
    const seenKeys = new Set();

    function processPlay(play, isLiveCurrent = false) {
      if (!play) return;
      const about = play.about || {};
      const result = play.result || {};
      const matchup = play.matchup || {};
      const playEvents = play.playEvents || [];
      const playReviewDetails = play.reviewDetails || null;
      const hasPlayReview = about.hasReview === true || !!playReviewDetails;

      // 1. Check playEvents for review events / ABS pitch challenges
      playEvents.forEach((event, evIdx) => {
        const details = event.details || {};
        const eventReviewDetails = event.reviewDetails || null;
        const hasEventReview = details.hasReview === true || !!eventReviewDetails;
        const desc = details.description || details.event || '';
        const isReviewText = /challenge|review|overturned|call stands|call confirmed|abs\b/i.test(desc);

        if (hasEventReview || (hasPlayReview && isReviewText) || (isReviewText && details.eventType === 'review')) {
          const revDetails = eventReviewDetails || playReviewDetails || {};
          const isCurrentActive = isLiveCurrent && (revDetails.inProgress || (!about.isComplete && isGameInReviewStatus));
          const outcome = determineOutcome(revDetails, desc || result.description, isCurrentActive);
          const typeMeta = normalizeType(revDetails.reviewType, desc || result.description);
          const challengeTeamId = revDetails.challengeTeamId || null;
          const team = challengeTeamId ? teamNames[challengeTeamId] : null;

          const key = `play-${about.atBatIndex || 0}-ev-${evIdx}-${typeMeta.key}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            reviews.push({
              id: key,
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
              reason: extractReason(desc || result.description),
              description: desc || result.description || 'Play reviewed.',
              timestamp: event.startTime || about.endTime || about.startTime || null,
              isPitch: !!event.isPitch,
              pitchVelo: event.pitchData && event.pitchData.startSpeed ? Math.round(event.pitchData.startSpeed) : null,
              batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
              pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
            });
          }
        }
      });

      // 2. If play has about.hasReview or reviewDetails or description mentions review but no event added yet
      const playDesc = result.description || '';
      const isPlayReviewText = /challenge|review|overturned|call stands|call confirmed/i.test(playDesc);
      if (hasPlayReview || isPlayReviewText) {
        const key = `play-${about.atBatIndex || 0}-main`;
        if (!seenKeys.has(key) && !reviews.some((r) => r.atBatIndex === about.atBatIndex)) {
          seenKeys.add(key);
          const revDetails = playReviewDetails || {};
          const isCurrentActive = isLiveCurrent && (revDetails.inProgress || (!about.isComplete && isGameInReviewStatus));
          const outcome = determineOutcome(revDetails, playDesc, isCurrentActive);
          const typeMeta = normalizeType(revDetails.reviewType, playDesc);
          const challengeTeamId = revDetails.challengeTeamId || null;
          const team = challengeTeamId ? teamNames[challengeTeamId] : null;

          reviews.push({
            id: key,
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
            reason: extractReason(playDesc),
            description: playDesc || 'Play reviewed.',
            timestamp: about.endTime || about.startTime || null,
            isPitch: false,
            pitchVelo: null,
            batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
            pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
          });
        }
      }
    }

    // Process all plays
    allPlays.forEach((play) => processPlay(play, false));

    // Check current play
    if (currentPlay) {
      processPlay(currentPlay, true);
    }

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

    // Footer: Batter / Pitcher context
    if (review.batter || review.pitcher) {
      const foot = UI.el('div', 'review-card-foot');
      if (review.batter) {
        foot.appendChild(UI.el('span', 'review-player-tag', `Batter: ${review.batter.fullName}`));
      }
      if (review.pitcher) {
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
