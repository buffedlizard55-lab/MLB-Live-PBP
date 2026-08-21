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
   *   "NH"  → Boundary-call review (crew-chief-initiated: potential home run /
   *           fair-foul at the wall). Event-level on the affected pitch, bare
   *           pitch description ("Foul"), no review text in the play
   *           description. (Verified in game 824801, 2026-08-19, atBatIndex 57:
   *           Pete Alonso's drive down the left-field line was ruled foul and
   *           the call stood after a crew-chief review —
   *           {"isOverturned":false,"inProgress":false,"reviewType":"NH"} on
   *           the "Foul" pitch event, which also carries
   *           details.hasReview:true.)
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
      if (code === 'NH') return { key: 'boundary', label: 'Boundary Call' };
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
   * `typeKey` (optional) disambiguates bare pitch descriptions: "Foul" means
   * an ABS ball/strike topic for an "MJ" review, but a boundary-call topic
   * for an "NH" review (verified shape, game 824801).
   */
  function extractReason(text, typeKey) {
    if (!text) return 'Play under review';
    const clean = String(text);

    // Common MLB review description patterns (real feeds use "challenged"):
    // "Manager challenge (call at 1st base): ..."
    // "Tigers challenged (tag play), call on the field was overturned: ..."
    // "Crew chief review (home run): ..."
    // "ABS challenge (called strike): ..."
    const parenMatch = clean.match(/(?:challeng\w*|review|replay)\s*\(([^)]+)\)/i);
    if (parenMatch) return parenMatch[1].trim();

    // Boundary-call reviews (NH) carry a bare pitch description ("Foul") with
    // no review text — the topic is the review category itself, same as the
    // "Home Run / Boundary Call" text pattern below.
    if (typeKey === 'boundary') return 'Home Run / Boundary Call';

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
   * Read a StatsAPI count object. GUMBO (the official feed spec) documents
   * playEvents[].count as balls/strikes AFTER the pitch event. play.count is
   * the at-bat's current/final count (verified by tools/smoke-test.mjs).
   * Returns null unless both balls and strikes are real numbers — never guess.
   */
  function readPitchCount(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const balls = obj.balls;
    const strikes = obj.strikes;
    if (typeof balls !== 'number' || typeof strikes !== 'number') return null;
    if (!Number.isFinite(balls) || !Number.isFinite(strikes)) return null;
    const out = { balls, strikes };
    if (typeof obj.outs === 'number' && Number.isFinite(obj.outs)) out.outs = obj.outs;
    return out;
  }

  /** Official baseball notation, e.g. "3-2". Null-safe. */
  function formatCount(count) {
    if (!count || typeof count.balls !== 'number' || typeof count.strikes !== 'number') return null;
    return `${count.balls}-${count.strikes}`;
  }

  /**
   * Count entering the reviewed pitch.
   *   - first pitch of the PA → 0-0 (every at-bat starts there)
   *   - otherwise the previous pitch event's count (GUMBO: that count is
   *     AFTER the previous pitch, which is the count BEFORE this one)
   * Missing previous-pitch counts stay null — we do not reconstruct them.
   */
  function countEnteringPitch(playEvents, reviewedEvent) {
    if (!reviewedEvent) return null;
    const pitches = (playEvents || []).filter((e) => e && e.isPitch);
    const idx = pitches.indexOf(reviewedEvent);
    if (idx < 0) return null;
    if (idx === 0) return { balls: 0, strikes: 0 };
    for (let i = idx - 1; i >= 0; i -= 1) {
      const prev = readPitchCount(pitches[i].count);
      if (prev) return { balls: prev.balls, strikes: prev.strikes };
    }
    return null;
  }

  function namesMatch(a, b) {
    if (!a || !b) return false;
    const norm = (s) => String(s).toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const pa = na.split(' ');
    const pb = nb.split(' ');
    if (pa.length >= 2 && pb.length >= 2 &&
        pa[pa.length - 1] === pb[pb.length - 1] &&
        pa[0].charAt(0) === pb[0].charAt(0)) {
      return true;
    }
    return false;
  }

  /**
   * Who initiated the challenge, from official feed text + IDs only.
   *
   * Observed play descriptions (2026-08-19):
   *   "Michael Massey challenged (pitch result), call on the field was …"
   *   "Tigers challenged (tag play), call on the field was …"
   * reviewDetails.challengeTeamId is the challenging club (verified).
   *
   * ABS rules (MLB 2026): only the batter, catcher, or pitcher may
   * challenge. We therefore:
   *   - label Batter / Pitcher when the official "X challenged" name
   *     matches matchup.batter / matchup.pitcher
   *   - label Catcher when the official name is a person who is neither
   *   - otherwise, if only challengeTeamId is known: batting team → Batter,
   *     fielding team → "Catcher or pitcher" (we do not invent which)
   * reviewDetails has no challengePlayerId in observed feeds.
   */
  function resolveChallenger({ desc, typeKey, challengeTeamId, about, matchup, teamNames, teamIdBySide }) {
    const batter = matchup && matchup.batter;
    const pitcher = matchup && matchup.pitcher;
    const text = String(desc || '');
    const challenged = text.match(/^(.{2,80}?)\s+challenged\b/i);
    const parsed = challenged ? challenged[1].replace(/^the\s+/i, '').trim() : null;

    if (parsed && batter && namesMatch(parsed, batter.fullName)) {
      return { role: 'batter', name: batter.fullName, label: `Batter ${batter.fullName}` };
    }
    if (parsed && pitcher && namesMatch(parsed, pitcher.fullName)) {
      return { role: 'pitcher', name: pitcher.fullName, label: `Pitcher ${pitcher.fullName}` };
    }

    if (parsed && challengeTeamId && teamNames && teamNames[challengeTeamId]) {
      const t = teamNames[challengeTeamId];
      const teamBits = [t.name, t.abbrev];
      if (t.name && t.name.indexOf(' ') >= 0) teamBits.push(t.name.slice(t.name.lastIndexOf(' ') + 1));
      if (teamBits.filter(Boolean).some((bit) => String(bit).toLowerCase() === parsed.toLowerCase())) {
        return { role: 'team', name: t.name || parsed, label: t.name || parsed };
      }
    }

    // Named person who is not the batter or pitcher. ABS: only B/P/C
    // may challenge, so this is the catcher. Name comes from official text.
    if (typeKey === 'abs' && parsed && /\s/.test(parsed) &&
        !/^(call|review|manager|crew|umpire)\b/i.test(parsed)) {
      return { role: 'catcher', name: parsed, label: `Catcher ${parsed}` };
    }

    if (typeKey === 'abs' && challengeTeamId != null && about && teamIdBySide) {
      const half = String(about.halfInning || '').toLowerCase();
      const battingSide = half === 'bottom' ? 'home' : half === 'top' ? 'away' : null;
      if (battingSide && teamIdBySide[battingSide] != null) {
        if (challengeTeamId === teamIdBySide[battingSide]) {
          return {
            role: 'batter',
            name: (batter && batter.fullName) || null,
            label: batter && batter.fullName ? `Batter ${batter.fullName}` : 'Batter',
          };
        }
        const fieldingSide = battingSide === 'home' ? 'away' : 'home';
        if (challengeTeamId === teamIdBySide[fieldingSide]) {
          return { role: 'defense', name: null, label: 'Catcher or pitcher' };
        }
      }
    }

    if (parsed) return { role: null, name: parsed, label: parsed };
    return { role: null, name: null, label: null };
  }

  function findReviewedPitch(playEvents, preferredEvent) {
    if (preferredEvent && preferredEvent.isPitch) return preferredEvent;
    return (playEvents || []).find((e) =>
      e && e.isPitch && (e.reviewDetails || (e.details && e.details.hasReview === true))) || null;
  }

  function buildAbsContext({ play, event, typeKey, desc, challengeTeamId, teamNames, teamIdBySide }) {
    const playEvents = (play && play.playEvents) || [];
    const reviewed = findReviewedPitch(playEvents, event);
    const countAfter = readPitchCount(reviewed && reviewed.count);
    const countBefore = countEnteringPitch(playEvents, reviewed);
    const atBatCount = readPitchCount(play && play.count);
    const challenger = resolveChallenger({
      desc,
      typeKey,
      challengeTeamId,
      about: (play && play.about) || {},
      matchup: (play && play.matchup) || {},
      teamNames,
      teamIdBySide,
    });
    return {
      countBefore,
      countAfter: countAfter ? { balls: countAfter.balls, strikes: countAfter.strikes } : null,
      atBatCount,
      challenger,
    };
  }

  /**
   * Plain-text lines for ABS count / challenger UI. Empty array when the
   * feed did not supply the underlying fields — callers must not invent text.
   */
  function absContextLines(review) {
    if (!review || review.typeKey !== 'abs') return [];
    const lines = [];
    const before = formatCount(review.countBefore);
    if (before) lines.push(`Count before challenge: ${before}`);
    const who = review.challenger && review.challenger.label;
    if (who) lines.push(`${who} challenged`);
    const after = formatCount(review.countAfter);
    if (after && !review.inProgress) {
      const word = review.outcome === 'overturned' ? 'overturned'
        : review.outcome === 'stands' ? 'stands'
        : review.outcome === 'confirmed' ? 'confirmed'
        : 'resolved';
      lines.push(`After call ${word}: ${after}`);
    }
    const atBat = formatCount(review.atBatCount);
    const afterSame = after && atBat && after === atBat;
    if (atBat && !afterSame) lines.push(`At-bat count: ${atBat}`);
    return lines;
  }

  /**
   * Strictly read an away/home score pair. `result` objects expose
   * awayScore/homeScore; linescores expose teams.away/home.runs. A partial or
   * non-numeric pair is rejected so the UI never fills a missing score.
   */
  function readScorePair(source) {
    if (!source || typeof source !== 'object') return null;
    const away = source.teams && source.teams.away
      ? source.teams.away.runs
      : (source.awayScore != null ? source.awayScore : source.away);
    const home = source.teams && source.teams.home
      ? source.teams.home.runs
      : (source.homeScore != null ? source.homeScore : source.home);
    if (typeof away !== 'number' || typeof home !== 'number') return null;
    if (!Number.isFinite(away) || !Number.isFinite(home) || away < 0 || home < 0) return null;
    return { away, home };
  }

  /** Last official result score before this at-bat, when the PBP supplies it. */
  function scoreBeforePlay(allPlays, play) {
    const target = play && play.about && play.about.atBatIndex;
    if (typeof target !== 'number' || !Number.isFinite(target)) return null;
    let prior = null;
    (allPlays || []).forEach((candidate) => {
      const idx = candidate && candidate.about && candidate.about.atBatIndex;
      if (typeof idx !== 'number' || idx >= target) return;
      const score = readScorePair(candidate.result);
      if (score) prior = score;
    });
    return prior;
  }

  /**
   * Scoring movements tied to the reviewed event.
   *
   * A play's runners array can contain movements from earlier pitches/actions
   * in the same plate appearance. For event-level reviews, details.playIndex
   * must therefore match the reviewed event.index. If either index is absent,
   * we only use all scoring movements for an explicit boundary-reviewed home
   * run. Play-level reviews match runner records to the final result's event /
   * eventType and playIndex before using its scoring movements.
   */
  function reviewedScoringRunners(play, event, typeKey) {
    const runners = (play && play.runners) || [];
    const scoring = runners.filter((runner) =>
      runner && runner.details && runner.details.isScoringEvent === true);

    if (!event) {
      // Play-level reviewDetails applies to the result play. Match runner
      // records to result.eventType/event and then use their playIndex; this
      // excludes an earlier steal/wild-pitch run from the same at-bat.
      const result = (play && play.result) || {};
      const resultIndexes = runners
        .filter((runner) => {
          const details = runner && runner.details;
          return details && (
            (result.eventType && details.eventType === result.eventType) ||
            (result.event && details.event === result.event));
        })
        .map((runner) => runner.details.playIndex)
        .filter((idx) => typeof idx === 'number' && Number.isFinite(idx));
      if (resultIndexes.length) {
        return scoring.filter((runner) => resultIndexes.includes(runner.details.playIndex));
      }
      return [];
    }

    if (typeof event.index === 'number' && Number.isFinite(event.index)) {
      return scoring.filter((runner) =>
        runner.details && runner.details.playIndex === event.index);
    }

    const eventType = play && play.result && play.result.eventType;
    if (typeKey === 'boundary' && eventType === 'home_run') return scoring;
    return [];
  }

  function scoreTeamLabels(teamNames, teamIdBySide) {
    const label = (side, fallback) => {
      const id = teamIdBySide && teamIdBySide[side];
      const team = id != null && teamNames ? teamNames[id] : null;
      return (team && (team.abbrev || team.name)) || fallback;
    };
    return { away: label('away', 'Away'), home: label('home', 'Home') };
  }

  /**
   * Derive only what the official play payload can support about score impact.
   * This does NOT predict the replay ruling. During an active review it reports
   * runs already credited by the call on the field and computes the conditional
   * score if all of those credited runs were removed. Boundary replay may place
   * runners instead, so that conditional score is explicitly a scenario, not a
   * forecast or guaranteed result.
   */
  function deriveScoreImpact({
    play, event, typeKey, outcome, previousScore, fallbackScore,
    teamNames, teamIdBySide,
  }) {
    const about = (play && play.about) || {};
    const result = (play && play.result) || {};
    const inProgress = outcome && outcome.key === 'in_progress';
    const half = String(about.halfInning || '').toLowerCase();
    const scoringSide = half === 'top' ? 'away' : half === 'bottom' ? 'home' : null;
    const events = ((play && play.playEvents) || []);
    const eventPosition = event ? events.indexOf(event) : -1;
    const isTerminalEvent = eventPosition >= 0 && eventPosition === events.length - 1;
    // A completed plate appearance's result score is not necessarily the score
    // immediately after an earlier pitch review. Use it only for play-level or
    // terminal-event reviews; an active review may use the score observed now.
    const resultAppliesToReview = !event || inProgress || isTerminalEvent;
    const currentScore = (resultAppliesToReview ? readScorePair(result) : null) ||
      (inProgress ? readScorePair(fallbackScore) : null);
    const beforeScore = readScorePair(previousScore);
    const scoringRunners = reviewedScoringRunners(play, event, typeKey);

    const text = [
      result.event,
      result.eventType,
      result.description,
      event && event.details && event.details.description,
    ].filter(Boolean).join(' ');
    const isBoundary = typeKey === 'boundary';
    const isHomeRun = /\bhome run\b|\bhomers?\b|\bover the wall\b/i.test(text) ||
      result.eventType === 'home_run';
    const isHomePlate = /\b(?:safe|out|play|tag(?:ged)?)\s+at\s+home\b|\bhome plate\b/i.test(text) ||
      scoringRunners.some((runner) => runner.movement && runner.movement.outBase === '4B');
    const context = isBoundary ? 'boundary'
      : isHomeRun ? 'home_run'
      : isHomePlate ? 'home_plate'
      : scoringRunners.length ? 'scoring_play'
      : null;

    // A numeric warning requires explicit scoring-runner records tied to the
    // reviewed event. A score delta across a whole at-bat is not enough: it can
    // include an earlier steal home, wild pitch, or other unrelated action.
    const runsCredited = scoringRunners.length;

    let possibleScoreIfRemoved = null;
    if (outcome && outcome.key === 'in_progress' && scoringSide &&
        runsCredited > 0 && currentScore && currentScore[scoringSide] >= runsCredited) {
      possibleScoreIfRemoved = { ...currentScore };
      possibleScoreIfRemoved[scoringSide] -= runsCredited;
    }

    const runnerNames = [];
    scoringRunners.forEach((runner) => {
      const name = runner.details && runner.details.runner && runner.details.runner.fullName;
      if (name && !runnerNames.includes(name)) runnerNames.push(name);
    });

    return {
      context,
      activeReviewObserved: !!inProgress,
      scoringSide,
      runsCredited,
      runsAtRisk: inProgress ? runsCredited : 0,
      runsAtRiskAtStart: inProgress ? runsCredited : 0,
      creditedRunnerNames: runnerNames,
      // Three distinct score snapshots. `currentScore` and
      // `possibleScoreIfRemoved` remain as internal/backward-compatible aliases.
      scoreAtReviewStart: inProgress ? currentScore : null,
      possibleScoreAfterReview: possibleScoreIfRemoved,
      officialScoreAfterReview: inProgress ? null : currentScore,
      currentScore,
      scoreBeforePlay: beforeScore,
      possibleScoreIfRemoved,
      teamLabels: scoreTeamLabels(teamNames, teamIdBySide),
    };
  }

  function formatScorePair(score, labels) {
    const pair = readScorePair(score);
    if (!pair) return null;
    const names = labels || { away: 'Away', home: 'Home' };
    return `${names.away || 'Away'} ${pair.away} – ${names.home || 'Home'} ${pair.home}`;
  }

  /**
   * User-facing score tracker. The three rows deliberately separate:
   *   1. score when the active review was first observed (call on the field),
   *   2. conditional score outcome(s) supported by the scoring movements, and
   *   3. official score attached to the play after the review resolves.
   * A final-only payload cannot recreate row 1 or 2, so those rows say the
   * active review was not observed. An observed active payload without a
   * complete score is labeled unavailable instead of being reconstructed.
   */
  function scoreImpactPresentation(review) {
    const impact = review && review.scoreImpact;
    if (!impact) return null;
    const labels = impact.teamLabels || { away: 'Away', home: 'Home' };
    const startPair = impact.scoreAtReviewStart || impact.scoreBeforeReview ||
      (review.inProgress ? impact.currentScore : null);
    const possiblePair = impact.possibleScoreAfterReview || impact.possibleScoreIfRemoved;
    const actualPair = impact.officialScoreAfterReview || impact.scoreAfterReview ||
      (!review.inProgress ? impact.currentScore : null);
    const start = formatScorePair(startPair, labels);
    const possible = formatScorePair(possiblePair, labels);
    const actual = formatScorePair(actualPair, labels);
    const activeObserved = impact.activeReviewObserved === true || !!start;
    const observedRisk = Number.isFinite(impact.runsAtRiskAtStart)
      ? impact.runsAtRiskAtStart
      : null;
    const runs = observedRisk != null
      ? observedRisk
      : (impact.runsAtRisk || impact.actualRunsRemoved ||
        impact.runsRetained || impact.runsCredited || 0);

    let possibleText;
    if (start && possible) {
      const alternate = impact.context === 'home_plate' && runs === 1
        ? 'If the safe-at-home call becomes an out'
        : runs === 1
          ? 'If the credited run is removed'
          : `If all ${runs} credited runs are removed`;
      possibleText = `Call stands: ${start} · ${alternate}: ${possible}`;
    } else if (!start) {
      possibleText = activeObserved
        ? 'Not available — no complete score was available when the review was observed'
        : 'Not available — the active review was not observed';
    } else if (impact.context === 'boundary') {
      possibleText = `Call stands: ${start} · Alternate score undetermined; replay may place runners`;
    } else {
      possibleText = `Call stands: ${start} · No alternate score is supported by the current play data`;
    }

    const rows = [
      {
        label: 'Before review',
        value: start || (activeObserved
          ? 'Unavailable in the observed active payload'
          : 'Not observed — final payload only'),
        state: start ? 'known' : 'unavailable',
      },
      {
        label: 'Possible after',
        value: possibleText,
        state: start ? 'scenario' : 'unavailable',
      },
      {
        label: 'Actual after',
        value: review.inProgress ? 'Pending — review in progress' : (actual || 'Unavailable in official play data'),
        state: review.inProgress ? 'pending' : (actual ? 'known' : 'unavailable'),
      },
    ];

    if (review.inProgress && runs > 0) {
      return {
        status: 'at-risk',
        title: `${runs} ${runs === 1 ? 'RUN' : 'RUNS'} AT RISK`,
        detail: `${rows[0].value} · ${rows[1].value}`,
        note: impact.context === 'boundary'
          ? '“Before review” is the call-on-field score when the review was first observed. The alternate is not a prediction or guaranteed final score; replay may place runners.'
          : '“Before review” is the call-on-field score when the review was first observed, not the score before the play. The alternate is not a prediction or guaranteed final score.',
        rows,
      };
    }

    if (review.inProgress && impact.context === 'boundary') {
      return {
        status: 'pending',
        title: 'BOUNDARY CALL — SCORE IMPACT PENDING',
        detail: start ? `Score when review started: ${start}.` : 'No complete official score is available yet.',
        note: 'The current play data does not credit a removable run. Replay may change the boundary call or runner placement, so no alternate score is invented.',
        rows,
      };
    }

    if (review.inProgress && start) {
      return {
        status: 'pending',
        title: 'REVIEW SCORE TRACKER',
        detail: `Score when review started: ${start}.`,
        note: 'No alternate score is shown unless official scoring movements tie a run to the reviewed event.',
        rows,
      };
    }

    if (review.inProgress) {
      return {
        status: 'pending',
        title: 'REVIEW SCORE TRACKER',
        detail: 'No complete score was available when this active review was observed.',
        note: 'Before, possible, and actual values remain unavailable rather than being reconstructed.',
        rows,
      };
    }

    if (impact.actualRunsRemoved > 0) {
      const n = impact.actualRunsRemoved;
      return {
        status: 'removed',
        title: `${n} ${n === 1 ? 'RUN' : 'RUNS'} REMOVED BY REVIEW`,
        detail: start && actual ? `${start} → ${actual}.` : `${n} ${n === 1 ? 'run was' : 'runs were'} removed from the official score.`,
        note: 'The before and actual scores were observed from the same review event across live StatsAPI polls.',
        rows,
      };
    }

    if (impact.actualRunsAdded > 0) {
      const n = impact.actualRunsAdded;
      return {
        status: 'added',
        title: `${n} ${n === 1 ? 'RUN' : 'RUNS'} ADDED BY REVIEW`,
        detail: start && actual ? `${start} → ${actual}.` : `${n} ${n === 1 ? 'run was' : 'runs were'} added to the official score.`,
        note: 'The before and actual scores were observed from the same review event across live StatsAPI polls.',
        rows,
      };
    }

    if (impact.runsRetained > 0) {
      const n = impact.runsRetained;
      return {
        status: 'retained',
        title: `${n} AT-RISK ${n === 1 ? 'RUN REMAINED' : 'RUNS REMAINED'} IN THE SCORE`,
        detail: actual ? `Official score after review: ${actual}.` : 'The official score did not decrease on resolution.',
        note: 'The before and actual scores were observed from the same review event across live StatsAPI polls.',
        rows,
      };
    }

    // Completed review: Actual can come from the resolved play, while a
    // final-only payload still cannot recreate the temporary call-on-field score.
    if (actual) {
      const n = impact.runsCredited || 0;
      return {
        status: 'final',
        title: impact.context === 'boundary' || impact.context === 'home_plate'
          ? (n > 0
            ? `FINAL REVIEWED PLAY: ${n} ${n === 1 ? 'RUN' : 'RUNS'} CREDITED`
            : 'FINAL REVIEWED PLAY: NO RUN CREDITED')
          : 'REVIEW SCORE COMPLETE',
        detail: `Official score after review: ${actual}.`,
        note: start
          ? 'The review was tracked live from its call-on-field score through the final ruling.'
          : activeObserved
            ? 'The active review was observed without a complete start score, so no before/possible score is inferred.'
            : 'The final score is official. The active review was not observed, so no temporary before/possible score is inferred.',
        rows,
      };
    }

    return {
      status: 'final',
      title: 'REVIEW SCORE TRACKER',
      detail: 'The official score immediately after this review is unavailable.',
      note: activeObserved
        ? 'The active review was observed, but the official payloads did not provide complete score snapshots.'
        : 'The final payload does not expose a score attributable to this review; no snapshots are reconstructed.',
      rows,
    };
  }

  function renderScoreImpact(review, variant) {
    const display = scoreImpactPresentation(review);
    if (!display) return null;
    const variantClass = variant ? `${variant}-score-impact` : '';
    const wrap = UI.el('div', `score-impact score-impact-${display.status} ${variantClass}`.trim());
    wrap.appendChild(UI.el('strong', 'score-impact-title', display.title));
    if (display.rows && display.rows.length) {
      const scoreRows = UI.el('div', 'score-impact-rows');
      display.rows.forEach((row) => {
        const line = UI.el('div', `score-impact-row score-impact-row-${row.state || 'known'}`);
        line.appendChild(UI.el('span', 'score-impact-row-label', row.label));
        line.appendChild(UI.el('span', 'score-impact-row-value', row.value));
        scoreRows.appendChild(line);
      });
      wrap.appendChild(scoreRows);
    } else {
      wrap.appendChild(UI.el('span', 'score-impact-detail', display.detail));
    }
    if (display.note) wrap.appendChild(UI.el('span', 'score-impact-note', display.note));
    return wrap;
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
    const fallbackScore = readScorePair(liveData.linescore);

    const teamNames = {};
    const teamIdBySide = { away: null, home: null };
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
          teamIdBySide[side] = t.id;
        }
      });
    }

    // One entry per `atBatIndex:typeKey` — play-level entries replace
    // event-level entries of the same type (they have the full description).
    const entriesByKey = new Map();

    function buildEntry({ id, about, result, matchup, revDetails, desc, outcome, typeMeta, challengeTeamId, isPitch, pitchVelo, timestamp, play, event }) {
      const team = challengeTeamId ? teamNames[challengeTeamId] : null;
      const abs = buildAbsContext({
        play,
        event,
        typeKey: typeMeta.key,
        desc,
        challengeTeamId,
        teamNames,
        teamIdBySide,
      });
      const scoreImpact = deriveScoreImpact({
        play,
        event,
        typeKey: typeMeta.key,
        outcome,
        previousScore: scoreBeforePlay(allPlays, play),
        fallbackScore,
        teamNames,
        teamIdBySide,
      });
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
        reason: extractReason(desc, typeMeta.key),
        description: desc || 'Play reviewed.',
        timestamp,
        isPitch: !!isPitch,
        pitchVelo,
        batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
        pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
        countBefore: abs.countBefore,
        countAfter: abs.countAfter,
        atBatCount: abs.atBatCount,
        challenger: abs.challenger,
        scoreImpact,
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
            play,
            event,
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
          play,
          event: null,
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
      const liveDesc = (cp.result && cp.result.description) || 'Play currently under review.';
      const liveAbs = buildAbsContext({
        play: cp,
        event: null,
        typeKey: activeTypeMeta.key,
        desc: liveDesc,
        challengeTeamId: (cp.reviewDetails && cp.reviewDetails.challengeTeamId) || null,
        teamNames,
        teamIdBySide,
      });
      const liveScoreImpact = deriveScoreImpact({
        play: cp,
        event: null,
        typeKey: activeTypeMeta.key,
        outcome: { key: 'in_progress' },
        previousScore: scoreBeforePlay(allPlays, cp),
        fallbackScore,
        teamNames,
        teamIdBySide,
      });
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
        description: liveDesc,
        timestamp: new Date().toISOString(),
        isPitch: false,
        pitchVelo: null,
        batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
        pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
        countBefore: liveAbs.countBefore,
        countAfter: liveAbs.countAfter,
        atBatCount: liveAbs.atBatCount,
        challenger: liveAbs.challenger,
        scoreImpact: liveScoreImpact,
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
      byType: { manager: 0, crew_chief: 0, abs: 0, boundary: 0, umpire: 0, rules: 0, review: 0 },
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
    const scoreImpact = renderScoreImpact(activeReview, 'review-alert');
    if (scoreImpact) content.appendChild(scoreImpact);
    const absLine = absContextSummary(activeReview);
    if (absLine) content.appendChild(UI.el('span', 'review-alert-abs', absLine));

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
    const scoreImpact = renderScoreImpact(review, 'review-card');
    if (scoreImpact) body.appendChild(scoreImpact);
    const absMeta = renderAbsContext(review);
    if (absMeta) body.appendChild(absMeta);
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

  /** Single compact sentence for banners / chips. Null if nothing official to show. */
  function absContextSummary(review) {
    const lines = absContextLines(review);
    return lines.length ? lines.join(' · ') : null;
  }

  function renderAbsContext(review) {
    const lines = absContextLines(review);
    if (!lines.length) return null;
    const wrap = UI.el('div', 'review-abs-meta');
    lines.forEach((line) => wrap.appendChild(UI.el('span', 'review-abs-line', line)));
    return wrap;
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
    readPitchCount,
    formatCount,
    countEnteringPitch,
    resolveChallenger,
    absContextLines,
    absContextSummary,
    renderAbsContext,
    readScorePair,
    scoreBeforePlay,
    reviewedScoringRunners,
    deriveScoreImpact,
    scoreImpactPresentation,
    renderScoreImpact,
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
