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

  /* ====================================================================
   * OFFICIAL GAME-STATUS REGISTRY — GET https://statsapi.mlb.com/api/v1/gameStatus
   * ---------------------------------------------------------------------
   * Verified live 2026-09-02 (all 4 pages of the registry read; this is the
   * API's own list of every value `status` can take, not a guess). The
   * review/challenge subset — every entry with abstractGameState "Live":
   *
   *   codedGameState "I" : IH  "Instant Replay"                 reason "Review"
   *   codedGameState "M" : manager challenges + the player/ABS
   *                        pitch challenge MJ ("Player challenge:
   *                        Pitch Result")                      (23 codes)
   *   codedGameState "N" : umpire reviews + the umpire/ABS pitch
   *                        challenge NJ ("Umpire Challenge:
   *                        Pitch Result")                      (23 codes)
   *
   * 47 codes in total — 1 + 23 + 23 — which tools/review-status-test.mjs §1
   * pins, and tools/smoke-test.mjs re-diffs against the live registry.
   *
   * `detailedState` and `reason` below are the registry's own strings,
   * verbatim. Nothing is inferred from the code letter.
   *
   * CROSS-CHECK against this repo's own live captures — the registry's
   * `statusCode` is the SAME two-letter vocabulary the feed puts in
   * `reviewDetails.reviewType`, and every code this project already observed
   * matches the registry's meaning exactly:
   *   MA "Tag play"           — game 823341 "Tigers challenged (tag play)"
   *   MF "Close play at 1st"  — game 824075 "Royals challenged (play at 1st)"
   *   MJ "Pitch Result" = ABS — games 823342 / 823667 / 824075 ABS challenges
   *   NH "Home run"           — game 824801 foul/potential-HR boundary review
   *
   * WHY THIS IS THE LATENCY FIX:
   *   `status.detailedState` / `status.statusCode` flip the instant a review
   *   is CALLED. The play text this parser also reads ("Tigers challenged
   *   (tag play), call on the field was overturned: …") is written when the
   *   review RESOLVES. So the status is the earliest official signal that a
   *   review exists, and it carries the official reason before any play text
   *   exists. It is also cheap: one `fields`-projected schedule request
   *   returns gamePk + status for the whole slate (see MLB.getReviewStatus).
   *
   *   The old detection was `/challenge|review/i.test(detailedState)`. That
   *   misses the crew-chief state verbatim: "Instant Replay" contains
   *   neither word, so `IH` reviews were never seen as active. Detection is
   *   now by registry code / codedGameState, with the old text test kept
   *   only as a fallback for payloads that carry detailedState alone.
   * ==================================================================== */
  const REVIEW_STATUS_BY_CODE = {
    /* ---- codedGameState "I" — generic instant-replay review ---- */
    IH: { codedGameState: 'I', detailedState: 'Instant Replay', reason: 'Review' },

    /* ---- codedGameState "M" — manager challenges (MJ is the player/ABS
     *      pitch challenge, whose detailedState reads "Player challenge") ---- */
    MF: { codedGameState: 'M', detailedState: 'Manager challenge: Close play at 1st', reason: 'Close play at 1st' },
    MA: { codedGameState: 'M', detailedState: 'Manager challenge: Tag play', reason: 'Tag play' },
    MU: { codedGameState: 'M', detailedState: 'Manager challenge: Tag-up play', reason: 'Tag-up play' },
    MM: { codedGameState: 'M', detailedState: 'Manager challenge: Timing play', reason: 'Timing play' },
    MC: { codedGameState: 'M', detailedState: 'Manager challenge: Force play', reason: 'Force play' },
    MP: { codedGameState: 'M', detailedState: 'Manager challenge: Home-plate collision', reason: 'Home-plate collision' },
    ME: { codedGameState: 'M', detailedState: 'Manager challenge: Slide interference', reason: 'Slide interference' },
    MH: { codedGameState: 'M', detailedState: 'Manager challenge: Home run', reason: 'Home run' },
    MO: { codedGameState: 'M', detailedState: 'Manager challenge: Fair/foul in outfield', reason: 'Fair/foul in outfield' },
    MD: { codedGameState: 'M', detailedState: 'Manager challenge: Catch/drop in outfield', reason: 'Catch/drop in outfield' },
    MT: { codedGameState: 'M', detailedState: 'Manager challenge: Trap play in outfield', reason: 'Trap play in outfield' },
    MI: { codedGameState: 'M', detailedState: 'Manager challenge: Hit by pitch', reason: 'Hit by pitch' },
    MB: { codedGameState: 'M', detailedState: 'Manager challenge: Touching a base', reason: 'Touching a base' },
    MR: { codedGameState: 'M', detailedState: 'Manager challenge: Passing runners', reason: 'Passing runners' },
    MN: { codedGameState: 'M', detailedState: 'Manager challenge: Fan interference', reason: 'Fan interference' },
    MS: { codedGameState: 'M', detailedState: 'Manager challenge: Stadium boundary call', reason: 'Stadium boundary call' },
    MG: { codedGameState: 'M', detailedState: 'Manager challenge: Grounds rule', reason: 'Grounds rule' },
    MQ: { codedGameState: 'M', detailedState: 'Manager challenge: Rules check', reason: 'Rules check' },
    MK: { codedGameState: 'M', detailedState: 'Manager challenge: Record keeping', reason: 'Record keeping' },
    ML: { codedGameState: 'M', detailedState: 'Manager challenge: Multiple issues', reason: 'Multiple issues' },
    MX: { codedGameState: 'M', detailedState: 'Manager challenge', reason: null },
    MV: { codedGameState: 'M', detailedState: 'Manager challenge: Catchers Interference', reason: 'Catchers Interference' },
    MJ: { codedGameState: 'M', detailedState: 'Player challenge: Pitch Result', reason: 'Pitch Result' },

    /* ---- codedGameState "N" — umpire reviews (NJ is the umpire/ABS pitch
     *      challenge) ---- */
    NF: { codedGameState: 'N', detailedState: 'Umpire review: Close play at 1st', reason: 'Close play at 1st' },
    NA: { codedGameState: 'N', detailedState: 'Umpire review: Tag play', reason: 'Tag play' },
    NW: { codedGameState: 'N', detailedState: 'Umpire review: Def Shift Violation', reason: 'Def Shift Violation' },
    NU: { codedGameState: 'N', detailedState: 'Umpire review: Tag-up play', reason: 'Tag-up play' },
    NM: { codedGameState: 'N', detailedState: 'Umpire review: Timing play', reason: 'Timing play' },
    NC: { codedGameState: 'N', detailedState: 'Umpire review: Force play', reason: 'Force play' },
    NP: { codedGameState: 'N', detailedState: 'Umpire review: Home-plate collision', reason: 'Home-plate collision' },
    NE: { codedGameState: 'N', detailedState: 'Umpire review: Slide interference', reason: 'Slide interference' },
    NH: { codedGameState: 'N', detailedState: 'Umpire review: Home run', reason: 'Home run' },
    NO: { codedGameState: 'N', detailedState: 'Umpire review: Fair/foul in outfield', reason: 'Fair/foul in outfield' },
    ND: { codedGameState: 'N', detailedState: 'Umpire review: Catch/drop in outfield', reason: 'Catch/drop in outfield' },
    NT: { codedGameState: 'N', detailedState: 'Umpire review: Trap play in outfield', reason: 'Trap play in outfield' },
    NI: { codedGameState: 'N', detailedState: 'Umpire review: Hit by pitch', reason: 'Hit by pitch' },
    NB: { codedGameState: 'N', detailedState: 'Umpire review: Touching a base', reason: 'Touching a base' },
    NR: { codedGameState: 'N', detailedState: 'Umpire review: Passing runners', reason: 'Passing runners' },
    NN: { codedGameState: 'N', detailedState: 'Umpire review: Fan interference', reason: 'Fan interference' },
    NS: { codedGameState: 'N', detailedState: 'Umpire review: Stadium boundary call', reason: 'Stadium boundary call' },
    NG: { codedGameState: 'N', detailedState: 'Umpire review: Grounds rule', reason: 'Grounds rule' },
    NQ: { codedGameState: 'N', detailedState: 'Umpire review: Rules check', reason: 'Rules check' },
    NK: { codedGameState: 'N', detailedState: 'Umpire review: Record keeping', reason: 'Record keeping' },
    NL: { codedGameState: 'N', detailedState: 'Umpire review: Multiple issues', reason: 'Multiple issues' },
    NX: { codedGameState: 'N', detailedState: 'Umpire review', reason: null },
    NJ: { codedGameState: 'N', detailedState: 'Umpire Challenge: Pitch Result', reason: 'Pitch Result' },
  };

  /**
   * The review category a registry `statusCode` belongs to. Same buckets the
   * feed parser already uses, so a row built from the status and a row built
   * later from `reviewDetails.reviewType` never disagree:
   *   MJ / NJ → ABS pitch challenge (the registry calls these "Player
   *             challenge" / "Umpire Challenge", reason "Pitch Result")
   *   NH      → boundary call (registry "Umpire review: Home run" — the
   *             potential-home-run / fair-foul-at-the-wall review this repo
   *             already verified live in game 824801)
   *   IH      → generic instant-replay review
   *   other M → manager challenge
   *   other N → umpire review (the same bucket the description-text path
   *             below already assigns to "umpire review" / "crew chief")
   */
  function reviewTypeForStatusCode(code) {
    const raw = String(code || '').trim().toUpperCase();
    if (raw === 'MJ' || raw === 'NJ') return { key: 'abs', label: 'ABS Challenge' };
    if (raw === 'NH') return { key: 'boundary', label: 'Boundary Call' };
    if (raw === 'IH') return { key: 'review', label: 'Instant Replay' };
    if (raw.charAt(0) === 'M') return { key: 'manager', label: 'Manager Challenge' };
    if (raw.charAt(0) === 'N') return { key: 'crew_chief', label: 'Umpire Review' };
    return null;
  }

  /**
   * Text fallback for a status that carries only `detailedState`. The old
   * `/challenge|review/i` test plus "instant replay", which is the verbatim
   * registry wording for the crew-chief state (statusCode IH) that the old
   * test silently missed.
   */
  function isReviewStatusText(text) {
    return /challenge|review|instant replay/i.test(String(text == null ? '' : text));
  }

  /**
   * Is this an official game `status` object for a game that is under review
   * RIGHT NOW? Registry-first (statusCode, then codedGameState M/N), text
   * only as a last resort. Pure; never throws.
   *
   * Every "Live" review state in the registry is covered, and no non-review
   * state is: `tools/review-status-test.mjs` walks the whole registry table
   * and asserts both directions.
   */
  function isReviewGameStatus(status) {
    if (!status || typeof status !== 'object') return false;
    const code = String(status.statusCode || '').trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(REVIEW_STATUS_BY_CODE, code)) return true;
    // codedGameState "M" and "N" are used ONLY by the registry's challenge /
    // umpire-review states — "I" is plain "In Progress" and must NOT match.
    const coded = String(status.codedGameState || '').trim().toUpperCase();
    if (coded === 'M' || coded === 'N') return true;
    return isReviewStatusText(status.detailedState);
  }

  /**
   * Everything the official status tells us about a live review, or null.
   * `reason` is the registry's own `reason` string; when the registry entry
   * has none (MX / NX are bare) the payload's own `status.reason` is used,
   * and if that is absent too the reason stays null rather than being
   * invented.
   */
  function reviewStatusInfo(status) {
    if (!isReviewGameStatus(status)) return null;
    const code = String(status.statusCode || '').trim().toUpperCase();
    const entry = Object.prototype.hasOwnProperty.call(REVIEW_STATUS_BY_CODE, code)
      ? REVIEW_STATUS_BY_CODE[code] : null;
    const coded = String(status.codedGameState || '').trim().toUpperCase();
    const detailed = typeof status.detailedState === 'string' && status.detailedState.trim()
      ? status.detailedState : (entry ? entry.detailedState : null);
    const payloadReason = typeof status.reason === 'string' && status.reason.trim()
      ? status.reason.trim() : null;
    const type = reviewTypeForStatusCode(code) ||
      reviewTypeForStatusCode(`${coded}X`) ||
      normalizeType(detailed, detailed);
    return {
      statusCode: code || null,
      codedGameState: coded || null,
      detailedState: detailed,
      reason: (entry && entry.reason) || payloadReason || null,
      typeKey: type ? type.key : 'review',
      typeLabel: type ? type.label : (detailed || 'Replay Review'),
    };
  }

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

    // 2. Short code from reviewDetails.reviewType. The game-status registry
    //    above is the authority: `status.statusCode` and
    //    `reviewDetails.reviewType` are the same two-letter vocabulary (see
    //    the registry's cross-check against games 823341/824075/823342/
    //    824801). NJ — the umpire pitch challenge — previously fell through
    //    to the generic "Replay Review" label here.
    if (/^[A-Za-z]{1,4}$/.test(raw)) {
      const code = raw.toUpperCase();
      const registry = reviewTypeForStatusCode(code);
      if (registry) return { key: registry.key, label: registry.label };
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
   * Official StatsAPI event-type registry — GET /api/v1/eventTypes — the
   * same vocabulary the feed uses for playEvents[].details.eventType.
   * Verified live (statsapi.mlb.com, 2026-08-30). These are the ONLY two
   * codes whose description is "Official Scorer Ruling Pending":
   *
   *   os_ruling_pending_primary → plateAppearance: true  — the primary
   *                               plate-appearance event (hit / error /
   *                               fielder's choice / etc.) is undecided.
   *   os_ruling_pending_prior   → baseRunningEvent: true, plateAppearance:
   *                               false — a prior base-running event of the
   *                               same play is undecided.
   *
   * Nothing else is treated as a pending ruling. Both codes and the exact
   * description text come straight from the registry; we never detect by
   * substring, and never invent a code or label.
   */
  const OFFICIAL_SCORER_PENDING_TYPES = new Set([
    'os_ruling_pending_primary',
    'os_ruling_pending_prior',
  ]);
  const OFFICIAL_SCORER_PENDING_TEXT = 'Official Scorer Ruling Pending';
  const PENDING_SCORING_TYPE_KEY = 'pending_scoring';
  const PENDING_SCORING_LABEL = 'Official Scoring Pending';

  /**
   * True iff an event/result object carries the official-scorer-pending
   * marker. Exact registry values only, at the fields the StatsAPI uses for
   * event-type codes / descriptions:
   *   playEvents[].details.eventType | .event | .description
   *   playEvents[].type | .eventType          (defensive, exact code only)
   *   play.result.eventType | .event | .description
   * A value is accepted ONLY if it equals one of the two registered codes or
   * the registered description verbatim. Pure; never throws.
   */
  function isOfficialScoringPendingEvent(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    const details = candidate.details || {};
    const values = [
      details.eventType, details.event, details.description,
      candidate.eventType, candidate.event, candidate.type,
      candidate.result && candidate.result.eventType,
      candidate.result && candidate.result.event,
      candidate.result && candidate.result.description,
    ];
    return values.some((v) =>
      typeof v === 'string' &&
      (OFFICIAL_SCORER_PENDING_TYPES.has(v) || v === OFFICIAL_SCORER_PENDING_TEXT));
  }

  /**
   * Scan one play for official-scorer-pending markers. Returns null when the
   * play has none, else:
   *   pendingEvents  — the playEvents that carry the marker
   *   pendingCodes   — the unique registered codes observed
   *   primary/prior  — booleans for the two registered codes
   *   atResult       — true when play.result itself carries the marker
   * Pure, reads only the supplied play object.
   */
  function findOfficialScoringPendingPlay(play) {
    if (!play || typeof play !== 'object') return null;
    const pendingEvents = [];
    const pendingCodes = [];
    const noteCode = (v) => {
      if (typeof v === 'string' && OFFICIAL_SCORER_PENDING_TYPES.has(v) &&
          !pendingCodes.includes(v)) pendingCodes.push(v);
    };

    (play.playEvents || []).forEach((event) => {
      if (!event || typeof event !== 'object') return;
      const details = event.details || {};
      const values = [
        details.eventType, details.event, details.description,
        event.eventType, event.event, event.type,
      ];
      const hit = values.find((v) =>
        typeof v === 'string' &&
        (OFFICIAL_SCORER_PENDING_TYPES.has(v) || v === OFFICIAL_SCORER_PENDING_TEXT));
      if (!hit) return;
      pendingEvents.push(event);
      values.forEach(noteCode);
    });

    const result = play.result || {};
    const resultValues = [result.eventType, result.event, result.description];
    const resultHit = resultValues.find((v) =>
      typeof v === 'string' &&
      (OFFICIAL_SCORER_PENDING_TYPES.has(v) || v === OFFICIAL_SCORER_PENDING_TEXT));
    const atResult = !!resultHit;
    if (atResult) resultValues.forEach(noteCode);

    if (!pendingEvents.length && !atResult) return null;
    return {
      pendingEvents,
      pendingCodes,
      primary: pendingCodes.includes('os_ruling_pending_primary'),
      prior: pendingCodes.includes('os_ruling_pending_prior'),
      atResult,
    };
  }

  /**
   * One feed entry for a play whose official scoring ruling is pending.
   * Produced ONLY from findOfficialScoringPendingPlay() — i.e. from the
   * official registered codes / description above. The entry carries the
   * observed payload text verbatim; if the payload had no play/no result
   * description yet, the exact registry description is used, never a
   * paraphrase and never a guessed final ruling (hit/error/etc.).
   */
  function buildPendingScoringEntry({ play, pending, teamNames, teamIdBySide }) {
    const about = (play && play.about) || {};
    const result = (play && play.result) || {};
    const matchup = (play && play.matchup) || {};
    const marker = pending.pendingEvents[0] || null;
    const markerDesc = marker && marker.details &&
      (marker.details.description || marker.details.event);
    const desc = markerDesc ||
      (pending.atResult && (result.description || result.event)) ||
      OFFICIAL_SCORER_PENDING_TEXT;
    const half = String(about.halfInning || '').toLowerCase();
    const battingSide = half === 'top' ? 'away' : half === 'bottom' ? 'home' : null;
    const battingTeamId = battingSide && teamIdBySide ? teamIdBySide[battingSide] : null;
    const battingTeam = battingTeamId != null && teamNames ? teamNames[battingTeamId] : null;
    const pendingNote = [
      pending.primary ? 'primary plate-appearance ruling' : null,
      pending.prior ? 'prior base-running ruling' : null,
    ].filter(Boolean).join(' + ');

    return {
      id: `osp-${about.atBatIndex != null ? about.atBatIndex : 'cp'}`,
      atBatIndex: about.atBatIndex != null ? about.atBatIndex : null,
      inning: about.inning || 1,
      halfInning: half || 'top',
      inningLabel: formatInning(about),
      reviewType: PENDING_SCORING_LABEL,
      typeKey: PENDING_SCORING_TYPE_KEY,
      // No challenging team: an official-scorer ruling is not charged to a
      // team's challenge counter. The BATTING side is still shown as context
      // (from halfInning + the official team ids — never guessed).
      teamId: null,
      teamName: null,
      teamAbbrev: null,
      battingSide,
      battingTeamId,
      battingTeamName: battingTeam ? battingTeam.name : null,
      battingTeamAbbrev: battingTeam ? battingTeam.abbrev : null,
      inProgress: true,
      isOverturned: null,
      outcome: 'in_progress',
      outcomeLabel: 'Ruling Pending',
      reason: pendingNote
        ? `Official scorer ruling pending (${pendingNote})`
        : 'Official scorer ruling pending',
      description: desc,
      timestamp: (marker && (marker.startTime || marker.endTime)) ||
        about.endTime || about.startTime || null,
      isPitch: false,
      pitchVelo: null,
      batter: matchup.batter ? { id: matchup.batter.id, fullName: matchup.batter.fullName } : null,
      pitcher: matchup.pitcher ? { id: matchup.pitcher.id, fullName: matchup.pitcher.fullName } : null,
      countBefore: null,
      countAfter: null,
      atBatCount: readPitchCount(play && play.count),
      challenger: null,
      pendingCodes: pending.pendingCodes,
      scoreImpact: null,
      officialScoringPending: true,
    };
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
    if (!feed) return { reviews: [], activeReview: null, summary: emptySummary(), pendingScoring: [] };

    const liveData = feed.liveData || {};
    const gameData = feed.gameData || {};
    const playsData = liveData.plays || {};
    const allPlays = playsData.allPlays || [];
    const currentPlay = playsData.currentPlay || null;
    const gameStatus = gameData.status || {};
    const status = (gameStatus.detailedState) || '';
    // Official registry lookup, not a word match: "Instant Replay" (statusCode
    // IH, the crew-chief state) contains neither "challenge" nor "review" and
    // was therefore invisible to the old `/challenge|review/i` test.
    const statusInfo = reviewStatusInfo(gameStatus);
    const isGameInReviewStatus = !!statusInfo;
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

    // Official-scorer pending rulings. Separate from replay reviews: these
    // come from the API's own event-type registry (os_ruling_pending_primary /
    // os_ruling_pending_prior, description "Official Scorer Ruling Pending"),
    // NOT from reviewDetails. One entry per at-bat; a play that appears in
    // BOTH allPlays and currentPlay is deduped by its atBatIndex.
    const pendingByKey = new Map();
    const processPending = (play) => {
      if (!play) return;
      const pending = findOfficialScoringPendingPlay(play);
      if (!pending) return;
      const entry = buildPendingScoringEntry({ play, pending, teamNames, teamIdBySide });
      const key = `${entry.atBatIndex != null ? entry.atBatIndex : 'cp'}:${entry.battingSide || ''}`;
      if (!pendingByKey.has(key)) pendingByKey.set(key, entry);
    };
    allPlays.forEach(processPending);
    if (currentPlay) processPending(currentPlay);

    const reviews = [...entriesByKey.values(), ...pendingByKey.values()];

    // If game state explicitly says "Manager Challenge" / "Umpire review" /
    // "Instant Replay" but no in-progress review recorded yet:
    if (isGameInReviewStatus && !reviews.some((r) => r.inProgress)) {
      // The registry classification (from statusCode) wins over the
      // detailedState text: it is what separates MJ/NJ (ABS pitch challenge),
      // NH (boundary call), M* (manager) and N* (umpire) before any play text
      // exists. Text-only payloads still fall back to normalizeType().
      const activeTypeMeta = (statusInfo && statusInfo.statusCode &&
          reviewTypeForStatusCode(statusInfo.statusCode)) ||
        normalizeType(status, status);
      const cp = currentPlay || (allPlays.length ? allPlays[allPlays.length - 1] : null) || {};
      const about = cp.about || {};
      const matchup = cp.matchup || {};
      const liveDesc = (cp.result && cp.result.description) || 'Play currently under review.';
      // The challenging club, when the feed already exposes it. Read from the
      // official challengeTeamId only — the game status says which TOPIC is
      // under review, never which side challenged, so teamId stays null
      // rather than being guessed from the batting side.
      const liveChallengeTeamId = (cp.reviewDetails && cp.reviewDetails.challengeTeamId) || null;
      const liveTeam = liveChallengeTeamId ? teamNames[liveChallengeTeamId] : null;
      const liveAbs = buildAbsContext({
        play: cp,
        event: null,
        typeKey: activeTypeMeta.key,
        desc: liveDesc,
        challengeTeamId: liveChallengeTeamId,
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
        teamId: liveChallengeTeamId,
        teamName: liveTeam ? liveTeam.name : null,
        teamAbbrev: liveTeam ? liveTeam.abbrev : null,
        inProgress: true,
        isOverturned: null,
        outcome: 'in_progress',
        outcomeLabel: 'In Progress',
        // The registry's own `reason` ("Tag play", "Home run", "Pitch
        // Result", …) — official, and available the instant the status flips,
        // long before the play description carries the review text.
        reason: (statusInfo && statusInfo.reason) || 'Call under replay review',
        description: liveDesc,
        timestamp: new Date().toISOString(),
        isPitch: false,
        pitchVelo: null,
        // Provenance for the "as soon as the play is under review" path: the
        // exact official status this row was synthesized from.
        statusCode: statusInfo ? statusInfo.statusCode : null,
        officialStatus: statusInfo ? statusInfo.detailedState : null,
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

    // Build a map of all plays keyed by atBatIndex for resolving pending
    // rulings. When a pending marker clears, the caller can use this to look
    // up the resolved play and capture its final description.
    const playsByAtBatIndex = new Map();
    [currentPlay, ...allPlays].forEach((play) => {
      if (play && play.about && play.about.atBatIndex != null) {
        const key = String(play.about.atBatIndex);
        // Store the first play we see for each atBatIndex (dedupe).
        if (!playsByAtBatIndex.has(key)) {
          playsByAtBatIndex.set(key, play);
        }
      }
    });

    return { reviews, activeReview, summary, pendingScoring: [...pendingByKey.values()], playsByAtBatIndex };
  }

  function emptySummary() {
    return {
      total: 0,
      overturned: 0,
      stands: 0,
      inProgress: 0,
      pendingScoring: 0,
      pendingScoringActive: 0,
      overturnRate: '0.0%',
      byType: { manager: 0, crew_chief: 0, abs: 0, boundary: 0, umpire: 0, rules: 0, review: 0, pending_scoring: 0 },
      byTeam: {},
    };
  }

  function buildSummary(reviews) {
    const summary = emptySummary();
    summary.total = reviews.length;

    reviews.forEach((r) => {
      // Official-scorer pending rulings are NOT replay outcomes: a resolved
      // scoring ruling (hit/error/fielder's choice) is neither "overturned"
      // nor "stands" in the replay sense, so it never enters the overturn
      // rate. It is tracked separately (pendingScoring below) and as
      // inProgress while the scorer is still deciding.
      if (r.typeKey === 'pending_scoring') {
        // NOT counted in summary.inProgress: \"Under Review\" on the game
        // page is a replay-review counter. Active scoring rulings have their
        // own counts/stats (pendingScoringActive).
        if (r.inProgress) summary.pendingScoringActive += 1;
        summary.pendingScoring += 1;
        summary.byType[r.typeKey] = (summary.byType[r.typeKey] || 0) + 1;
        return;
      }
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
    // Registry lookup (statusCode / codedGameState), not a word match —
    // "Instant Replay" (crew-chief review, statusCode IH) contains neither
    // "challenge" nor "review" and was missed by the old text test.
    const info = reviewStatusInfo(status);
    if (info) {
      const typeMeta = (info.statusCode && reviewTypeForStatusCode(info.statusCode)) ||
        normalizeType(detailed, detailed);
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
    const badge = UI.el('span', 'review-alert-badge',
      activeReview.typeKey === PENDING_SCORING_TYPE_KEY
        ? '⚖️ OFFICIAL SCORER RULING'
        : '🚨 LIVE REVIEW');
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
    // Official-scorer pending: the batting side (from halfInning + official
    // team ids) is context, not a "challenging team" — no challenge counter.
    // Rendered only when a real name exists; never guessed.
    if (review.typeKey === 'pending_scoring' && (review.battingTeamAbbrev || review.battingTeamName)) {
      const bat = UI.el('span', 'review-team-tag review-batting-tag',
        `Batting: ${review.battingTeamAbbrev || review.battingTeamName}`);
      if (review.battingTeamName) bat.title = review.battingTeamName;
      left.appendChild(bat);
    }
    head.appendChild(left);

    const right = UI.el('div', 'review-card-head-right');
    const outcomeCls = review.inProgress ? 'outcome-in-progress' :
      review.outcome === 'overturned' ? 'outcome-overturned' :
      review.outcome === 'confirmed' ? 'outcome-confirmed' :
      review.outcome === 'resolved' ? 'outcome-resolved' : 'outcome-stands';
    const outcomeIcon = review.inProgress ? '⚡ ' :
      review.outcome === 'resolved' ? '✓ ' :
      review.outcome === 'overturned' ? '✓ ' : '✗ ';
    right.appendChild(UI.el('span', `review-outcome-pill ${outcomeCls}`, `${outcomeIcon}${review.outcomeLabel}`));
    head.appendChild(right);
    card.appendChild(head);

    // Body: Reason headline + Play description
    const body = UI.el('div', 'review-card-body');
    body.appendChild(UI.el('h4', 'review-reason-title', review.reason || review.headline || 'Scoring Change'));

    if (review.typeKey === 'scoring_change') {
      const block = UI.el('div', 'feed-scoring');
      if (review.initial && review.final) {
        const headline = UI.el('div', 'feed-scoring-headline');
        headline.appendChild(UI.el('span', `feed-scoring-call feed-scoring-call-${review.initial.category || 'hit'}`, review.initial.label || 'Initial'));
        headline.appendChild(UI.el('span', 'feed-scoring-arrow', '→'));
        headline.appendChild(UI.el('span', `feed-scoring-call feed-scoring-call-${review.final.category || 'hit'}`, review.final.label || 'Final'));
        if (review.changeCount > 1) {
          headline.appendChild(UI.el('span', 'feed-scoring-multiple', `${review.changeCount} rulings observed`));
        }
        block.appendChild(headline);
      }
      const initDesc = review.initialDescription || (review.initial && review.initial.label);
      if (initDesc) {
        block.appendChild(UI.el('div', 'feed-scoring-line feed-scoring-initial', `Initial call: ${initDesc}`));
      }
      if (review.description) {
        block.appendChild(UI.el('div', 'feed-scoring-line feed-scoring-final', `Final ruling: ${review.description}`));
      }
      if (review.scoreAfter && (review.scoreAfter.away != null || review.scoreAfter.home != null)) {
        block.appendChild(UI.el('div', 'feed-scoring-line feed-scoring-score',
          `Score after play: Away ${review.scoreAfter.away} – Home ${review.scoreAfter.home}`));
      }
      if (review.mechanism && review.mechanism.label) {
        block.appendChild(UI.el('div', 'feed-scoring-line feed-scoring-mechanism', review.mechanism.label));
      }
      body.appendChild(block);
    } else {
      const scoreImpact = renderScoreImpact(review, 'review-card');
      if (scoreImpact) body.appendChild(scoreImpact);
      const absMeta = renderAbsContext(review);
      if (absMeta) body.appendChild(absMeta);
      body.appendChild(UI.el('p', 'review-desc-text', review.description));
      // Official-scorer pending rulings: show the resolved ruling when available.
      if (review.typeKey === 'pending_scoring' && review.resolvedDescription) {
        body.appendChild(UI.el('p', 'review-resolved-text', `Resolved as: ${review.resolvedDescription}`));
      }
    }
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
    // Official-scorer pending rulings are tracked separately from replay
    // outcome stats (see buildSummary). Value = rulings pending RIGHT NOW,
    // matching the Replay Feed stat; the tooltip reports the tracked total.
    if (summary.pendingScoring > 0) {
      const item = statItem('Scoring Pending', summary.pendingScoringActive, 'stat-os-pending');
      item.title = `${summary.pendingScoring} official-scorer ruling${summary.pendingScoring === 1 ? '' : 's'} tracked for this game, ${summary.pendingScoringActive} still pending. ` +
        'A ruling decides how the play is charged (hit / error / fielder\u2019s choice) — it never removes a run from the score. ' +
        'Detected only from the StatsAPI event registry os_ruling_pending_primary / os_ruling_pending_prior (GET /api/v1/eventTypes).';
      statsBar.appendChild(item);
    }
    const scoringChanges = reviewData.scoringChanges || (reviews || []).filter((r) => r && r.typeKey === 'scoring_change');
    if (scoringChanges.length > 0) {
      const item = statItem('Scoring Changes', scoringChanges.length, 'stat-scoring-change');
      item.title = `${scoringChanges.length} official scoring change${scoringChanges.length === 1 ? '' : 's'} tracked for this game. ` +
        'Initial call and final ruling from official scorer changes.';
      statsBar.appendChild(item);
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
        'No challenges, replay reviews, or official scoring changes in this game yet.'));
      return;
    }

    const list = UI.el('div', 'reviews-list');
    reviews.forEach((r) => list.appendChild(renderReviewCard(r)));
    container.appendChild(list);
  }

  /**
   * True iff the review is in progress AND the original call on the field
   * credited one or more runs that are tied to the reviewed event (so an
   * overturn COULD remove those runs from the score).
   *
   * This is the precise predicate the replay feed uses for its ASAP alert:
   *   - The review must be active (in-progress), not resolved — an already
   *     overturned/stood review cannot remove another run.
   *   - A positive run count must be tied to the reviewed event. Those counts
   *     come from reviewedScoringRunners(), which only accepts scoring
   *     movements whose playIndex matches the reviewed event (verified
   *     against statsapi.mlb.com, see reviewedScoringRunners()). A score
   *     delta across a whole at-bat or across unrelated plays does NOT
   *     count: earlier steals/wild pitches/etc. cannot be removed here.
   *   - The type of review is irrelevant — a manager challenge, crew chief
   *     review, umpire review, boundary call, "under review" status entry or
   *     an ABS pitch challenge all qualify if (and only if) runs are tied to
   *     the reviewed event. In practice an ABS ball/strike challenge credits
   *     no runner, so deriveScoreImpact() reports 0 for it and this returns
   *     false — by the data, not by a hardcoded type exclusion.
   *
   * Pure function — reads only fields on the supplied review object.
   * Returns false for any falsy/malformed input; never throws.
   *
   * See runsRemovableByReview() below for the exact counting rule.
   */
  function reviewCouldRemoveRuns(review) {
    return runsRemovableByReview(review) > 0;
  }

  /**
   * Number of runs that COULD be removed by this in-progress review.
   *
   * Counting rule (all three inputs are observed, none is predicted):
   *   - `runsCredited` is the length of reviewedScoringRunners() — the scoring
   *     movements StatsAPI ties to the reviewed event itself. An unrelated
   *     steal home or wild pitch earlier in the same plate appearance is
   *     already excluded there.
   *   - `runsAtRisk` / `runsAtRiskAtStart` are the same number captured on the
   *     first poll that saw the review active; reconcileScoreImpact() in the
   *     replay feed deliberately keeps that first snapshot and may therefore
   *     still read 0 on a poll where the runner records have since appeared.
   * The largest of the finite candidates is used so a run that only becomes
   * visible on a later poll is never silently dropped from the alert.
   *
   * Returns 0 for resolved reviews, for reviews with no runs tied to the
   * reviewed event, and for any malformed input. Never throws, never returns
   * a negative or non-finite number.
   */
  function runsRemovableByReview(review) {
    if (!review) return 0;
    if (review.inProgress !== true) return 0;
    // An official-scorer pending ruling decides how to CHARGE the play (hit /
    // error / fielder's choice, earned vs. unearned runs) — it never removes
    // a run from the scoreboard, so nothing is "at risk". See MLB Official
    // Scoring Rules (official scorer decides hits/errors) and the API's
    // registered os_ruling_pending_* event types.
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
   * Structured "a run on the scoreboard could come off" summary for the alert
   * surfaces (feed banner, active strip, notification body).
   *
   * Every field is either copied from the observed payload or formatted from
   * it. Nothing is predicted: `possibleScore` is the conditional score that
   * deriveScoreImpact() only fills in when the call-on-field score is known
   * AND it is large enough to subtract the credited runs from, and it stays
   * null otherwise rather than being invented. `headline` mirrors the
   * scoreImpactPresentation() 'at-risk' title so both surfaces agree.
   *
   * Returns null when no run is at risk. Pure; never throws.
   */
  function runRiskSummary(review) {
    const runs = runsRemovableByReview(review);
    if (!runs) return null;
    const impact = review.scoreImpact;
    const labels = impact.teamLabels || { away: 'Away', home: 'Home' };
    const side = impact.scoringSide === 'away' || impact.scoringSide === 'home'
      ? impact.scoringSide
      : null;
    const startPair = impact.scoreAtReviewStart || impact.scoreBeforeReview ||
      impact.currentScore;
    const possiblePair = impact.possibleScoreAfterReview || impact.possibleScoreIfRemoved;
    const runners = Array.isArray(impact.creditedRunnerNames)
      ? impact.creditedRunnerNames.filter((n) => typeof n === 'string' && n.trim())
      : [];
    return {
      runs,
      side,
      teamLabel: side ? (labels[side] || null) : null,
      context: impact.context || null,
      runnerNames: runners,
      startScore: formatScorePair(startPair, labels),
      possibleScore: formatScorePair(possiblePair, labels),
      headline: `${runs} ${runs === 1 ? 'RUN' : 'RUNS'} AT RISK`,
      badge: `⚠️ ${runs} ${runs === 1 ? 'RUN' : 'RUNS'} AT RISK`,
    };
  }

  return {
    normalizeType,
    extractReason,
    determineOutcome,
    extractReviews,
    inspectScheduleGame,
    /* Official game-status registry (GET /api/v1/gameStatus, verified live
     * 2026-09-02) — the earliest official signal that a review exists. */
    REVIEW_STATUS_BY_CODE,
    reviewTypeForStatusCode,
    isReviewStatusText,
    isReviewGameStatus,
    reviewStatusInfo,
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
    reviewCouldRemoveRuns,
    runsRemovableByReview,
    runRiskSummary,
    OFFICIAL_SCORER_PENDING_TYPES,
    OFFICIAL_SCORER_PENDING_TEXT,
    PENDING_SCORING_TYPE_KEY,
    PENDING_SCORING_LABEL,
    isOfficialScoringPendingEvent,
    findOfficialScoringPendingPlay,
    buildPendingScoringEntry,
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
