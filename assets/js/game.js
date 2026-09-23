/* ============================================================================
 * game.js — single-game "Gameday" view
 * Renders: score header, live "at bat" module (batter, pitcher, count,
 * runners), linescore, box score, and the play-by-play timeline.
 * Polls the live feed while the game is in progress.
 * ==========================================================================*/
'use strict';

(() => {
  // Cadence is the gap between poll STARTS (scan duration is subtracted).
  // Live play-by-play: 500ms. While a review is in flight: 250ms — the game is
  // frozen during a review, so each 250ms tick probes the lean playByPlay
  // endpoint (not the full feed) and only pulls the full feed once when the
  // review state actually flips. Preview/final back off.
  const LIVE_POLL_MS = 500;
  const REVIEW_POLL_MS = 250;
  const PREVIEW_POLL_MS = 60000;
  const FINAL_POLL_MS = 180000;
  // Review probe fetch: fail fast. The probe runs at the 250ms cadence while
  // a review is in flight, so a retry inside the SAME probe only delays the
  // next tick; the next probe retries anyway (probe failure → retry in 1s).
  const PROBE_TIMEOUT_MS = 3000;
  const PROBE_RETRIES = 0;
  // Standalone review-status watcher (added 2026-09-05 — see
  // docs/latency-audit.md addendum). While the game is live and NOT already
  // known to be in review, this timer sweeps the ~150-byte per-game status
  // projection (MLB.getGameStatus — verified live 2026-09-05 to return
  // exactly {"gameData":{"status":{…}}} in one small response) every 250ms,
  // so a brand-new challenge/review is seen at ≤250ms instead of at the next
  // 500ms full-feed cycle. The official status is the field MLB flips the
  // instant a review is CALLED (registry codes M*/N*/IH — see
  // statusSaysReview below), i.e. the earliest signal that exists.
  const STATUS_WATCH_POLL_MS = 250;
  const STATUS_WATCH_RECHECK_MS = 1000; // in-review: timer-only check-ins (no fetch)
  const STATUS_WATCH_IDLE_MS = 5000;    // parked when preview/final/hidden
  const STATUS_WATCH_TIMEOUT_MS = 2500; // stalled sweep fails fast; next tick retries
  // MLB writes the review STATUS before the feed content carries the review.
  // For this long after a watcher flip, renderAll() must NOT clobber the
  // watcher's lastActiveReview (and its 🚨 status line) just because the
  // freshly downloaded feed does not show the review yet — otherwise the two
  // writers flap at 250ms and every flap re-downloads the 1-2MB full feed.
  // The grace is short and self-expiring; once the feed shows the review the
  // flag is authoritative again, and a status that reverts clears naturally.
  const STATUS_LEAD_GRACE_MS = 3000;

  let gamePk = null;
  let feed = null;
  let pollTimer = null;
  let countdownTimer = null;
  let nextRefreshAt = 0;
  let lastCycleStartedAt = 0;
  let lastToken = null;
  let lastReviewSig = null;
  let lastActiveReview = false;
  let activeTab = 'plays';
  let requestInFlight = false;
  // Review-status watcher state: its own timer (never shares the poll timer)
  // and an in-flight guard so a sweep can never overlap itself and stack
  // requests on a slow network.
  let statusWatchTimer = null;
  let statusWatchInFlight = false;
  // When the watcher last saw the official status enter a review state, plus
  // the official label to show while the full feed catches up (see
  // STATUS_LEAD_GRACE_MS above).
  let statusReviewObservedAt = 0;
  let statusLeadLabel = '';

  /**
   * Is this official game `status` a review/challenge state?
   *
   * Registry authority: GET https://statsapi.mlb.com/api/v1/gameStatus
   * (verified live 2026-09-02). Every review state is statusCode M*
   * (manager/player challenge), N* (umpire review) or IH ("Instant Replay");
   * codedGameState "M"/"N" belong to those and nothing else, while "I" alone
   * is plain "In Progress" and must NOT match. The text test is the fallback
   * for a payload with only detailedState, and it includes "instant replay" —
   * the verbatim registry wording the old /challenge|review/i test missed, so
   * crew-chief reviews previously never reached the 250ms probe cadence here.
   *
   * Same self-contained predicate as reviews-feed.js / scoreboard.js / ui.js
   * (they cannot all assume reviews.js is loaded); tools/review-status-test.mjs
   * walks the full registry and asserts every copy agrees with
   * MLBReviews.isReviewGameStatus.
   */
  function statusSaysReview(status) {
    if (window.MLBReviews && typeof window.MLBReviews.isReviewGameStatus === 'function') {
      return window.MLBReviews.isReviewGameStatus(status);
    }
    if (!status || typeof status !== 'object') return false;
    const code = String(status.statusCode || '').trim().toUpperCase();
    if (/^[MN][A-Z]$/.test(code) || code === 'IH') return true;
    const coded = String(status.codedGameState || '').trim().toUpperCase();
    if (coded === 'M' || coded === 'N') return true;
    return /challenge|review|instant replay/i.test(String(status.detailedState || ''));
  }

  /* ------------------------------------------------------------------ boot */

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    gamePk = params.get('gamePk');
    if (!gamePk || !/^\d+$/.test(gamePk)) {
      $('#main').appendChild(UI.el('div', 'empty',
        'No game selected. Pick a game from the scoreboard.'));
      $('#main').appendChild(UI.el('a', 'btn', '← Back to scoreboard', { href: 'index.html' }));
      return;
    }
    wireTabs();
    $('#refresh-btn').addEventListener('click', () => load(true));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        // load() already calls scheduleNext() on success/failure.
        // There is no startPolling() in this file (verified). The status
        // watcher (stopped on hide) restarts here — its only re-arming
        // points are boot and "tab shown" (it self-perpetuates otherwise).
        scheduleStatusWatch();
        load(true);
      } else {
        stopPolling();
      }
    });
    // Arm the 250ms review-status watcher once; it re-evaluates its own
    // cadence every tick (fast while live && !in-review, parked otherwise).
    scheduleStatusWatch();
    load(true);
  });

  /* ----------------------------------------------------------------- fetch */

  /**
   * Compact signature of every review state in a playByPlay payload, plus a
   * boolean for whether any review is still in progress.
   *
   * While a review is in flight the game is frozen — no pitch, count or score
   * can move — so the ONLY fields that can still change on the server are the
   * review flags. Comparing this signature lets load() probe the lean
   * playByPlay endpoint (no boxscore/rosters) at the 250ms cadence and fetch
   * the full feed exactly once: the moment the review state flips.
   *
   * Safety: the probe carries NO gameData.status, so a review that is visible
   * only in the game status (the synthesized "live-active-review" entry) has no
   * reviewDetails here at all. `hasInProgress` is therefore the gate — the full
   * feed is fetched whenever the probe can no longer see an in-progress review
   * (it just resolved, or it was status-only all along), so a status-only
   * resolution can never be missed.
   */
  function reviewProbeState(plays) {
    const all = (plays && plays.allPlays) || [];
    const cur = plays && plays.currentPlay;
    let hasInProgress = false;
    const sigFor = (play) => {
      if (!play) return '';
      const rd = play.reviewDetails;
      if (rd && rd.inProgress) hasInProgress = true;
      const bits = [rd && rd.inProgress, rd && rd.isOverturned, rd && rd.reviewType];
      (play.playEvents || []).forEach((e) => {
        if (!e) return;
        const erd = e.reviewDetails;
        if (!erd && !(e.details && e.details.hasReview)) return;
        if (erd && erd.inProgress) hasInProgress = true;
        bits.push(`${e.index}:${erd && erd.inProgress}:${erd && erd.isOverturned}:${erd && erd.reviewType}`);
      });
      return bits.join('|');
    };
    const allSig = all.map(sigFor).join(',');
    const curSig = sigFor(cur);
    return { sig: `${all.length}:${allSig}#${curSig}`, hasInProgress };
  }

  async function load(showSpinner) {
    if (!gamePk || requestInFlight) return;
    requestInFlight = true;
    lastCycleStartedAt = Date.now();
    if (showSpinner && !feed) $('#loading').classList.add('visible');
    try {
      let data;
      if (lastActiveReview) {
        // Fast path: probe the lean playByPlay endpoint while a review is
        // in flight. Skip the 1-2MB full feed download — and tick again in
        // 250ms — ONLY when the probe still sees the review in progress and
        // nothing review-related changed. Every other case (resolved,
        // overturned, confirmed, status-only review, or a probe failure)
        // falls through to the full feed, so no review update can be missed.
        let probe = null;
        try {
          probe = await MLB.getPlayByPlay(gamePk, {
            timeout: PROBE_TIMEOUT_MS, retries: PROBE_RETRIES,
          });
        } catch (probeErr) {
          // Network trouble: don't chain a (likely-failing) full feed after
          // it; retry the probe on the next fast tick instead.
          console.warn('review probe failed, retrying', probeErr);
          $('#loading').classList.remove('visible');
          scheduleNext(1000);
          return;
        }
        const probeState = reviewProbeState(probe);
        if (probeState.hasInProgress && lastReviewSig != null &&
            probeState.sig === lastReviewSig) {
          $('#loading').classList.remove('visible');
          renderStatusLine();
          scheduleNext();
          return;
        }
      }
      // NOTE (2026-09-05): a brand-new review is no longer detected by racing
      // a ~150-byte status projection inside this 500ms cycle — the dedicated
      // 250ms status watcher below (scheduleStatusWatch / pollGameStatus)
      // sees the official status flip at ≤250ms BETWEEN cycles and kicks an
      // out-of-band load() immediately, so the banner lands one feed round
      // trip after the flip instead of up to a full cycle later. renderAll()
      // below still decides everything from the authoritative full payload.
      data = await MLB.getLiveFeed(gamePk);
      const token = feedToken(data);
      const changed = token !== lastToken || !feed;
      feed = data;
      lastToken = token;
      lastReviewSig = reviewProbeState((feed.liveData && feed.liveData.plays) || {}).sig;
      // A live feed can be large. Keep the existing DOM when no baseball state changed.
      if (changed) {
        renderAll();
        syncGameScoringChanges();
      } else {
        // Recompute review-ness even when nothing else changed: right after a
        // review resolves — before any further play — the token is stable, and
        // the flag must not stay stuck on (the status watcher re-arms off it;
        // caught by tools/page-status-watcher-test.mjs §B4). A status-only
        // review still goes through renderAll: its detailedState is part of
        // the token, so a status flip always counts as a change.
        const reviewData = window.MLBReviews
          ? window.MLBReviews.extractReviews(data)
          : { reviews: [], activeReview: null, summary: {} };
        lastActiveReview = !!(reviewData && reviewData.activeReview) || statusLeadGraceActive();
        renderStatusLine();
      }
      $('#loading').classList.remove('visible');
      scheduleNext();
    } catch (err) {
      console.error(err);
      $('#loading').classList.remove('visible');
      $('#status-line').textContent = `Update failed: ${err.message || err} — retrying…`;
      scheduleNext(5000);
    } finally {
      requestInFlight = false;
    }
  }

  /**
   * State token deliberately ignores the feed timestamp: it changes even when no
   * play changed. This prevents a costly full timeline/box-score redraw on idle polls.
   */
  function feedToken(data) {
    const plays = data.liveData && data.liveData.plays;
    const current = plays && plays.currentPlay;
    const all = (plays && plays.allPlays) || [];
    const last = all[all.length - 1] || {};
    const event = current && current.playEvents && current.playEvents[current.playEvents.length - 1];
    const ls = data.liveData && data.liveData.linescore;
    const status = data.gameData && data.gameData.status;
    const reviewDetails = (current && current.reviewDetails) || (last && last.reviewDetails);
    const eventReview = event && event.reviewDetails;
    // ABS challenges live on playEvents[].reviewDetails (code MJ). The last
    // event's playId/description can stay put while inProgress/isOverturned
    // flip — include those fields or the reviews tab would miss the outcome.
    const currentReviewSig = ((current && current.playEvents) || []).map((e) => {
      if (!e) return '';
      const rd = e.reviewDetails;
      if (!rd && !(e.details && e.details.hasReview)) return '';
      return [rd && rd.inProgress, rd && rd.isOverturned, rd && rd.reviewType,
        e.details && e.details.description].join(':');
    }).filter(Boolean).join(',');
    return [
      all.length,
      last.about && last.about.atBatIndex,
      last.about && last.about.endTime,
      last.about && last.about.hasReview,
      current && current.about && current.about.atBatIndex,
      current && current.about && current.about.hasReview,
      reviewDetails && reviewDetails.inProgress,
      reviewDetails && reviewDetails.isOverturned,
      eventReview && eventReview.inProgress,
      eventReview && eventReview.isOverturned,
      eventReview && eventReview.reviewType,
      currentReviewSig,
      status && status.detailedState,
      event && (event.playId || event.index),
      event && event.details && event.details.description,
      event && event.details && event.details.hasReview,
      current && current.count && `${current.count.balls}-${current.count.strikes}-${current.count.outs}`,
      ls && ls.currentInning, ls && ls.inningState,
      ls && ls.teams && ls.teams.away && ls.teams.away.runs,
      ls && ls.teams && ls.teams.home && ls.teams.home.runs,
    ].join('|');
  }

  /* ------------------------------------------------------------- scheduling */

  function isLive() {
    return feed && feed.gameData && feed.gameData.status &&
           feed.gameData.status.abstractGameState === 'Live';
  }

  function currentInterval() {
    if (!isLive()) {
      return gd().status && gd().status.abstractGameState === 'Final'
        ? FINAL_POLL_MS : PREVIEW_POLL_MS;
    }
    return lastActiveReview ? REVIEW_POLL_MS : LIVE_POLL_MS;
  }

  function scheduleNext(overrideMs) {
    const interval = overrideMs != null ? overrideMs : currentInterval();
    const elapsed = lastCycleStartedAt ? Date.now() - lastCycleStartedAt : 0;
    const wait = overrideMs != null ? interval : Math.max(0, interval - elapsed);
    nextRefreshAt = Date.now() + wait;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { load(false); }, wait);
    startCountdown(wait);
  }

  function stopPolling() {
    clearTimeout(pollTimer);
    clearInterval(countdownTimer);
    $('#countdown').textContent = '';
    // The watcher has its own timer; a hidden tab must stop sweeping too.
    stopStatusWatch();
  }

  /* ------------------------------------------- standalone review-status watch
   * The LATENCY FIX for "a play is being challenged / is under review" on
   * this page (2026-09-05; previously bounded by the 500ms live cycle):
   *
   *   worst case before : ~500ms (next full-feed cycle) + one feed RTT
   *   worst case after  : ~250ms (watcher) + one feed RTT
   *
   * MLB flips the official game status the instant a review is CALLED,
   * before any play text exists (verified finding, verification-report
   * §16). While the game is live and not already known to be in review,
   * pollGameStatus() sweeps MLB.getGameStatus — the ~150-byte `fields`
   * projection of feed/live carrying ONLY gameData.status (verified live
   * 2026-09-05, game 823256: exactly {"gameData":{"status":{…}}}) — every
   * 250ms on its own timer. On a review flip it:
   *   1. flips lastActiveReview so the very next tick is the 250ms lean
   *      review probe (not a 500ms full-feed cycle),
   *   2. paints "🚨 <official detailedState> — loading details…" from the
   *      status alone, and
   *   3. kicks an OUT-OF-BAND load() so the banner + review tab render from
   *      the authoritative full feed right now, not on the next tick.
   *
   * It parks (5s, no requests; 1s timer-only check-ins once a review is
   * known) when the game is preview/final or the tab is hidden, and is armed
   * exactly twice per shown-tab lifetime (boot + tab-show) — see the
   * self-perpetuation note inside scheduleStatusWatch. Cost while live:
   * four ~150-byte requests per second — the same projection the old
   * in-cycle race fetched twice per second, now on a faster clock.
   */
  function statusWatchIntervalMs() {
    if (document.hidden) return STATUS_WATCH_IDLE_MS;
    // Before the first feed lands there is nothing to sweep yet — re-park at
    // the fast cadence WITHOUT fetching (pure timer tick, zero requests) so
    // the watcher is hot the moment the first feed says the game is live.
    if (!feed) return STATUS_WATCH_POLL_MS;
    if (!isLive()) return STATUS_WATCH_IDLE_MS; // preview/final: nothing to watch
    if (lastActiveReview) {
      // A review is known: the 250ms lean probe owns updates, so no sweeps —
      // but check in every second (timer-only, zero requests) so the watcher
      // resumes its fast sweep within ~1s of the review resolving, instead of
      // staying parked at the 5s idle cadence (a back-to-back status-only
      // challenge must not wait 5s — the old in-cycle race caught it in 500ms).
      return STATUS_WATCH_RECHECK_MS;
    }
    return STATUS_WATCH_POLL_MS;
  }

  function scheduleStatusWatch() {
    clearTimeout(statusWatchTimer);
    // The timer is SELF-PERPETUATING (every path — including the hidden park
    // and pollGameStatus's finally — re-arms it, recomputing the cadence from
    // current state), so nothing else may re-arm it: resetting the phase from
    // every 500ms poll cycle would stretch the 250ms sweep to ~2/s (caught by
    // tools/page-status-watcher-test.mjs §B1). It is armed exactly once per
    // "shown" lifetime: at boot and on visibilitychange→show.
    statusWatchTimer = setTimeout(() => {
      if (document.hidden) { scheduleStatusWatch(); return; }
      pollGameStatus();
    }, statusWatchIntervalMs());
  }

  function stopStatusWatch() {
    clearTimeout(statusWatchTimer);
    statusWatchTimer = null;
  }

  /**
   * One sweep. Never throws: a failed sweep is silently retried on the next
   * tick (fail-fast timeout, no retry), and the full feed remains the
   * authority for everything rendered. A sweep must never overlap itself.
   */
  async function pollGameStatus() {
    if (!gamePk || statusWatchInFlight) { scheduleStatusWatch(); return; }
    // Nothing to sweep until the first feed lands (boot phase): re-park at
    // the fast cadence without fetching (see statusWatchIntervalMs).
    if (!feed) { scheduleStatusWatch(); return; }
    // Only sweep while the sweep can learn something: a review can only be
    // CALLED on a live game, and once lastActiveReview is true the 250ms
    // lean probe (reviewProbeState) owns every in-review update.
    if (!isLive() || lastActiveReview) { scheduleStatusWatch(); return; }
    statusWatchInFlight = true;
    try {
      const payload = await MLB.getGameStatus(gamePk,
        { timeout: STATUS_WATCH_TIMEOUT_MS, retries: 0 });
      const st = payload && payload.gameData && payload.gameData.status;
      if (st && statusSaysReview(st) && !lastActiveReview) {
        lastActiveReview = true;
        statusReviewObservedAt = Date.now();
        statusLeadLabel = st.detailedState || 'Review in progress';
        const line = $('#status-line');
        if (line) {
          line.textContent = `🚨 ${statusLeadLabel} — loading details…`;
        }
        // Out-of-band full feed: renders the banner + review tab now. If a
        // cycle is already in flight its own full feed carries the review;
        // the requestInFlight guard makes the redundant call a no-op.
        load(false);
      }
    } catch (err) {
      // Deliberately quiet — see the doc comment above.
    } finally {
      statusWatchInFlight = false;
      scheduleStatusWatch();
    }
  }

  function startCountdown(interval) {
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const left = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000));
      $('#countdown').textContent = UI.fmtCountdown(left);
    }, 250);
  }

  /* ------------------------------------------------------------ data access */

  function gd() { return (feed && feed.gameData) || {}; }
  function ld() { return (feed && feed.liveData) || {}; }

  function player(id) {
    const players = gd().players || {};
    return players[`ID${id}`] || null;
  }

  function playerName(id) {
    const p = player(id);
    if (p) return p.fullName;
    // fallback bundle: search boxscore player map
    const box = ld().boxscore || {};
    return ['away', 'home'].reduce((found, side) => {
      const pMap = box.teams && box.teams[side] && box.teams[side].players || {};
      const entry = pMap[`ID${id}`];
      return found || (entry && entry.person && entry.person.fullName) || null;
    }, null) || `#${id}`;
  }

  function teamInfo(side) {
    const g = gd().teams && gd().teams[side];
    if (g && g.id) {
      return { id: g.id, name: g.name, abbrev: g.abbreviation, record: g.record && g.record.leagueRecord };
    }
    const box = ld().boxscore && ld().boxscore.teams && ld().boxscore.teams[side];
    if (box && box.team && box.team.id) {
      return { id: box.team.id, name: box.team.name, abbrev: box.team.abbreviation, record: null };
    }
    return { id: null, name: side === 'away' ? 'Away' : 'Home', abbrev: side === 'away' ? 'AWY' : 'HOM', record: null };
  }

  function teamRecord(side) {
    const t = teamInfo(side);
    return t.record ? `${t.record.wins}-${t.record.losses}` : '';
  }

  function score(side) {
    const ls = ld().linescore;
    return ls && ls.teams && ls.teams[side] ? ls.teams[side].runs : null;
  }

  function linescore() { return ld().linescore || null; }
  function boxscore() { return ld().boxscore || null; }
  function playsData() { return ld().plays || null; }

  /* ------------------------------------------------------------- rendering */

  /** Within STATUS_LEAD_GRACE_MS of a watcher flip the official status is
   *  trusted over the (lagging) feed — see STATUS_LEAD_GRACE_MS. */
  function statusLeadGraceActive() {
    return isLive() && lastActiveReview && statusReviewObservedAt > 0 &&
      (Date.now() - statusReviewObservedAt) < STATUS_LEAD_GRACE_MS;
  }

  let gameScoringChanges = [];
  let lastScoringSyncAt = 0;

  async function syncGameScoringChanges() {
    if (!window.MLBFeedLog) return;
    const now = Date.now();
    if (now - lastScoringSyncAt < 3000) return;
    lastScoringSyncAt = now;
    const date = (gd() && gd().datetime && gd().datetime.officialDate) ||
                 (gd() && gd().datetime && gd().datetime.originalDate) ||
                 (new URLSearchParams(window.location.search).get('date')) ||
                 new Date().toISOString().slice(0, 10);
    if (!date || !gamePk) return;
    try {
      const changes = await window.MLBFeedLog.getScoringChangesForGame(date, gamePk);
      if (Array.isArray(changes) && changes.length !== gameScoringChanges.length) {
        gameScoringChanges = changes;
        renderAll();
      }
    } catch (_) {}
  }

  function renderAll() {
    document.title = pageTitle();
    const rawReviewData = window.MLBReviews ? window.MLBReviews.extractReviews(feed) : { reviews: [], activeReview: null, summary: {} };
    const allReviews = [...(rawReviewData.reviews || []), ...gameScoringChanges];
    const reviewData = {
      ...rawReviewData,
      reviews: allReviews,
      scoringChanges: gameScoringChanges,
    };
    // The feed is authoritative EXCEPT during the status-lead grace window,
    // when MLB has flipped the official status to a review state but has not
    // written the review into the feed yet (verified finding, verification-
    // report §16). Without the grace the two writers flap and each flap
    // re-downloads the full feed.
    lastActiveReview = !!(reviewData && reviewData.activeReview) || statusLeadGraceActive();
    renderLiveReviewAlert(reviewData.activeReview);
    renderReviewTabBadge(allReviews.length);
    renderHeader();
    renderLivePanel(reviewData.activeReview);
    renderLinescore();
    // The box score is the heaviest view; render it only when it can be seen.
    if (activeTab === 'boxscore') renderBoxscore();
    if (activeTab === 'plays') renderPlays(reviewData);
    if (activeTab === 'props' && window.Props) window.Props.render($('#props-wrap'), feed);
    if (activeTab === 'reviews' && window.MLBReviews) window.MLBReviews.renderReviewsTab($('#reviews-wrap'), reviewData);
    renderStatusLine();
  }

  function renderLiveReviewAlert(activeReview) {
    const wrap = UI.clear($('#live-review-banner-wrap'));
    if (!activeReview || !window.MLBReviews) return;
    const banner = window.MLBReviews.renderLiveAlertBanner(activeReview);
    if (banner) wrap.appendChild(banner);
  }

  function renderReviewTabBadge(count) {
    const badge = $('#reviews-tab-count');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function pageTitle() {
    const status = gd().status;
    const ls = linescore();
    const away = teamInfo('away');
    const home = teamInfo('home');
    const label = MLB.inningLabel(ls, status);
    const aS = score('away'), hS = score('home');
    const base = `${away.abbrev} ${aS == null ? '-' : aS}, ${home.abbrev} ${hS == null ? '-' : hS}`;
    return status && status.abstractGameState === 'Live' ? `${base} · ${label}` : base;
  }

  /* -------------------------------------------------------------- header */

  function renderHeader() {
    const status = gd().status;
    const ls = linescore();
    const away = teamInfo('away');
    const home = teamInfo('home');

    const awayBlock = teamBlock('away', away);
    const homeBlock = teamBlock('home', home);

    const center = UI.clear($('#header-center'));
    center.appendChild(UI.el('div', 'big-score',
      `${score('away') == null ? '–' : score('away')} – ${score('home') == null ? '–' : score('home')}`));

    const chip = UI.statusChip(status || { detailedState: 'Unknown', abstractGameState: '' },
      MLB.inningLabel(ls, status) || (status && status.detailedState));
    center.appendChild(chip);
    if (status && status.abstractGameState === 'Live' && ls) {
      center.appendChild(UI.el('div', 'header-inning',
        `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''} · ` +
        `${ls.inningState || ''} · ${ls.outs == null ? '' : ls.outs + ' out'}`));
    } else if (status && status.abstractGameState === 'Preview') {
      center.appendChild(UI.el('div', 'header-inning', `First pitch ${MLB.localTime(gd().datetime && gd().datetime.dateTime)}`));
    }

    $('#header-away').replaceChildren(awayBlock);
    $('#header-home').replaceChildren(homeBlock);

    /* meta strip */
    const meta = UI.clear($('#header-meta'));
    const bits = [];
    const dt = gd().datetime;
    if (dt) bits.push(MLB.localDateTime(dt.dateTime));
    if (gd().venue && gd().venue.name) bits.push(gd().venue.name);
    const att = attendance();
    if (att) bits.push(`Att: ${att}`);
    const wx = gd().weather;
    if (wx && wx.temp) {
      bits.push(`${wx.temp}°F${wx.condition ? ', ' + wx.condition : ''}`);
    }
    meta.appendChild(UI.el('span', '', bits.join(' · ')));

    /* decisions */
    const decisions = ld().decisions || {};
    const decLine = UI.clear($('#header-decisions'));
    if (decisions.winner || decisions.loser || decisions.save) {
      const parts = [];
      if (decisions.winner) parts.push(`W: ${decisionName(decisions.winner, 'wins', 'losses')}`);
      if (decisions.loser) parts.push(`L: ${decisionName(decisions.loser, 'wins', 'losses')}`);
      if (decisions.save) parts.push(`SV: ${decisionName(decisions.save, 'saves')}`);
      decLine.appendChild(UI.el('span', 'decisions', parts.join('   ·   ')));
    }

    const gameNote = gd().game && (gd().game.description || gd().game.notes && gd().game.notes[0]);
    if (gameNote && status && status.abstractGameState === 'Preview') {
      decLine.appendChild(UI.el('span', 'game-note', gameNote));
    }
  }

  function teamBlock(side, t) {
    const block = UI.el('div', `team-block team-${side}`);
    const logo = UI.teamLogo(t.id, t.name, t.abbrev, 'header-logo');
    block.appendChild(logo);
    const info = UI.el('div', 'team-block-info');
    info.appendChild(UI.el('div', 'team-block-name', t.name));
    info.appendChild(UI.el('div', 'team-block-record', teamRecord(side)));
    block.appendChild(info);
    return block;
  }

  function decisionName(d, statA, statB) {
    const stats = pitcherStats(d.id);
    const a = stats && stats[statA];
    const b = stats && stats[statB];
    const rec = a != null && b != null ? ` (${a}-${b})` : '';
    return `${playerName(d.id)}${rec}`;
  }

  function pitcherStats(id) {
    const box = boxscore();
    if (!box || !box.teams) return null;
    for (const side of ['away', 'home']) {
      const entry = box.teams[side].players[`ID${id}`];
      if (entry && entry.stats && entry.stats.pitching) return entry.stats.pitching;
    }
    return null;
  }

  function attendance() {
    const box = boxscore();
    if (!box || !box.info) return null;
    for (const item of box.info) {
      if (item && /attendance/i.test(item.label)) return item.value;
    }
    return null;
  }

  /* ------------------------------------------------------- live "now" panel */

  function renderLivePanel(activeReview) {
    const panel = UI.clear($('#live-panel'));
    const status = gd().status;
    const abstract = status && status.abstractGameState;

    if (abstract === 'Preview') {
      panel.appendChild(previewPanel());
      return;
    }
    if (abstract === 'Final') {
      panel.appendChild(finalPanel());
      return;
    }

    // Prominent live review notification in the live module if active.
    // An official-scorer pending ruling is NOT a replay review, so it uses
    // its own heading (the scorer is deciding hit/error/fielder's choice).
    if (activeReview) {
      const isPendingScoring = activeReview.typeKey === 'pending_scoring';
      const revStrip = UI.el('div', 'live-active-review-card');
      revStrip.appendChild(UI.el('div', 'live-review-pulse', isPendingScoring ? '⚖️' : '🚨'));
      const textWrap = UI.el('div', 'live-review-body');
      textWrap.appendChild(UI.el('div', 'live-review-head',
        isPendingScoring
          ? `OFFICIAL SCORER RULING PENDING${activeReview.battingTeamAbbrev ? ` (${activeReview.battingTeamAbbrev} batting)` : ''}`
          : `PLAY UNDER REVIEW — ${activeReview.reviewType.toUpperCase()}${activeReview.teamAbbrev ? ` (${activeReview.teamAbbrev})` : ''}`));
      textWrap.appendChild(UI.el('div', 'live-review-reason', activeReview.reason));
      textWrap.appendChild(UI.el('div', 'live-review-desc', activeReview.description));
      const scoreImpact = window.MLBReviews && window.MLBReviews.renderScoreImpact
        ? window.MLBReviews.renderScoreImpact(activeReview, 'live-review')
        : null;
      if (scoreImpact) textWrap.appendChild(scoreImpact);
      const absLine = window.MLBReviews && window.MLBReviews.absContextSummary
        ? window.MLBReviews.absContextSummary(activeReview)
        : null;
      if (absLine) textWrap.appendChild(UI.el('div', 'live-review-abs', absLine));
      revStrip.appendChild(textWrap);
      const ctaBtn = UI.el('button', 'btn btn-ghost btn-sm', 'View All Reviews', {
        onclick: "document.querySelector(\"[data-tab='reviews']\").click()",
      });
      revStrip.appendChild(ctaBtn);
      panel.appendChild(revStrip);
    }

    const plays = playsData();
    const cp = (plays && plays.currentPlay) || {};
    const about = cp.about || {};
    const matchup = cp.matchup || {};
    const count = cp.count || {};
    const ls = linescore();

    /* between innings */
    const between = (ls && (ls.inningState === 'Middle' || ls.inningState === 'End')) ||
                    (about.isComplete && (ls && ls.inningState !== 'Bottom' && ls.inningState !== 'Top'));

    const grid = UI.el('div', 'live-grid');

    /* --- at bat card --- */
    const atBat = UI.el('div', 'panel-card at-bat-card');
    atBat.appendChild(UI.el('h3', 'panel-title', between ? 'In Between Innings' : 'At Bat'));

    if (between) {
      atBat.appendChild(UI.el('p', 'between-text',
        `${MLB.inningGlyph(ls)} ${ls.currentInningOrdinal || ''} — between innings`));
    } else {
      const batter = matchup.batter || {};
      const battingSide = about.halfInning === 'bottom' ? 'home' : 'away';
      const orderPos = battingOrderPosition(battingSide, batter.id);

      const row = UI.el('div', 'ab-row');
      const shot = UI.headshot(batter.id, batter.fullName, 'ab-headshot');
      row.appendChild(shot);
      const info = UI.el('div', 'ab-info');
      info.appendChild(UI.el('div', 'ab-name', batter.fullName || '—'));
      info.appendChild(UI.el('div', 'ab-meta',
        `${batSideDesc(matchup.batSide)}${orderPos ? ` · #${orderPos} hitter` : ''}`));
      row.appendChild(info);
      atBat.appendChild(row);

      // A compact version of the two-sided model is visible without opening
      // the Props tab. It remains a pre-plate-appearance forecast, so the
      // current count never changes the estimate mid-at-bat.
      const forecast = liveHitForecast(matchup);
      if (forecast) atBat.appendChild(forecast);

      /* count + outs */
      const countWrap = UI.el('div', 'count-wrap');
      countWrap.appendChild(UI.countDots(count.balls, count.strikes, count.outs));
      atBat.appendChild(countWrap);

      /* runners: linescore offense is the authoritative live base state. */
      const baseState = basesOnField(ls, cp);
      if (baseState.labels.length) {
        const runRow = UI.el('div', 'runners-row');
        runRow.appendChild(UI.diamond(baseState.bases));
        runRow.appendChild(UI.el('span', 'runners-text',
          `Runners on ${baseState.labels.join(', ')}`));
        atBat.appendChild(runRow);
      } else {
        atBat.appendChild(UI.el('div', 'runners-empty', 'Bases empty'));
      }

      /* on deck / in the hole */
      const next = nextBatters(battingSide, batter.id);
      if (next.length) {
        const deck = UI.el('div', 'deck-row');
        next.forEach((n, i) => {
          deck.appendChild(UI.el('span', `deck ${i === 0 ? 'deck-1' : ''}`,
            `${i === 0 ? 'On deck' : 'In the hole'}: ${n}`));
        });
        atBat.appendChild(deck);
      }
    }

    /* --- pitching card --- */
    const pitch = UI.el('div', 'panel-card pitching-card');
    pitch.appendChild(UI.el('h3', 'panel-title', 'Pitching'));
    const pitcher = matchup.pitcher || {};
    const pStats = pitcherStats(pitcher.id);
    // Boxscore counters are supplied by the live feed and avoid rescanning every pitch.
    const pitchCount = pStats && pStats.pitchesThrown != null
      ? { total: pStats.pitchesThrown, strikes: pStats.strikes || 0 }
      : countPitcherPitches(pitcher.id);

    const prow = UI.el('div', 'ab-row');
    const pshot = UI.headshot(pitcher.id, pitcher.fullName, 'ab-headshot');
    prow.appendChild(pshot);
    const pinfo = UI.el('div', 'ab-info');
    pinfo.appendChild(UI.el('div', 'ab-name', pitcher.fullName || '—'));
    const pMetaBits = [];
    if (pStats && pStats.inningsPitched) pMetaBits.push(`${UI.fmtInnings(pStats.inningsPitched)} IP`);
    if (pStats && pStats.hits != null) pMetaBits.push(`${pStats.hits} H`);
    if (pStats && pStats.earnedRuns != null) pMetaBits.push(`${pStats.earnedRuns} ER`);
    if (pStats && pStats.baseOnBalls != null) pMetaBits.push(`${pStats.baseOnBalls} BB`);
    if (pStats && pStats.strikeOuts != null) pMetaBits.push(`${pStats.strikeOuts} K`);
    pinfo.appendChild(UI.el('div', 'ab-meta',
      [pitchHandDesc(matchup.pitchHand), pMetaBits.join(' · ')].filter(Boolean).join(' · ')));
    prow.appendChild(pinfo);
    pitch.appendChild(prow);

    const pitchStats = UI.el('div', 'pitch-stats');
    pitchStats.appendChild(UI.el('span', 'stat-chip', `Pitches: ${pitchCount.total}`));
    if (pitchCount.strikes) {
      pitchStats.appendChild(UI.el('span', 'stat-chip', `${pitchCount.strikes} strikes`));
    }
    if (pStats && pStats.pitchesThrown != null) {
      pitchStats.appendChild(UI.el('span', 'stat-chip',
        `PC-ST: ${pStats.pitchesThrown}-${pStats.strikes || 0}`));
    }
    const lastVelo = lastPitchVelo(pitcher.id);
    if (lastVelo) pitchStats.appendChild(UI.el('span', 'stat-chip', `Last pitch: ${lastVelo} mph`));
    pitch.appendChild(pitchStats);

    grid.appendChild(atBat);
    grid.appendChild(pitch);
    panel.appendChild(grid);

    /* last play strip */
    const lastPlay = UI.el('div', 'last-play');
    lastPlay.appendChild(UI.el('span', 'last-play-label', 'Last play'));
    lastPlay.appendChild(UI.el('span', 'last-play-text',
      (cp.result && cp.result.description) || '—'));
    panel.appendChild(lastPlay);
  }

  function previewPanel() {
    const wrap = UI.el('div', 'panel-card preview-card');
    wrap.appendChild(UI.el('h3', 'panel-title', 'Game Preview'));
    const dt = gd().datetime;
    wrap.appendChild(UI.el('p', 'preview-line',
      `First pitch: ${MLB.localDateTime(dt && dt.dateTime)}`));
    if (gd().venue && gd().venue.name) {
      wrap.appendChild(UI.el('p', 'preview-line', `Venue: ${gd().venue.name}`));
    }
    wrap.appendChild(UI.el('p', 'preview-note',
      'Lineups, starting pitchers and live coverage appear here once the game starts.'));
    return wrap;
  }

  function finalPanel() {
    const wrap = UI.el('div', 'panel-card final-card');
    wrap.appendChild(UI.el('h3', 'panel-title', 'Game Over'));
    const away = teamInfo('away');
    const home = teamInfo('home');
    wrap.appendChild(UI.el('p', 'final-line',
      `${away.name} ${score('away')}, ${home.name} ${score('home')}`));
    const ls = linescore();
    if (ls && ls.teams) {
      wrap.appendChild(UI.el('p', 'final-stats',
        `${ls.teams.away.hits} hits, ${ls.teams.away.errors} errors · ` +
        `${ls.teams.home.hits} hits, ${ls.teams.home.errors} errors`));
    }
    return wrap;
  }

  /* --------------------------------------- compact live two-sided forecast */

  function gameSeason() {
    const season = gd().game && gd().game.season;
    return /^\d{4}$/.test(String(season || '')) ? String(season) : null;
  }

  /**
   * Put the model where fans need it most: directly below the active batter.
   * The element is intentionally local to the render, so a delayed response
   * from an older at-bat cannot overwrite a newer matchup after a poll.
   */
  function liveHitForecast(matchup) {
    const batter = matchup && matchup.batter;
    const pitcher = matchup && matchup.pitcher;
    if (!batter || !batter.id || !pitcher || !pitcher.id ||
        !window.Props || !window.Props.getHitPrediction) return null;

    const bHand = matchup.batSide && matchup.batSide.code;
    const pHand = matchup.pitchHand && matchup.pitchHand.code;
    const key = `${batter.id}:${pitcher.id}:${bHand || ''}:${pHand || ''}`;
    const forecast = UI.el('div', 'live-hit-forecast loading', '', {
      'aria-live': 'polite',
      'data-matchup-key': key,
    });
    forecast.appendChild(UI.el('span', 'live-hit-label', 'Two-sided hit forecast'));
    forecast.appendChild(UI.el('span', 'live-hit-value', 'Loading…'));

    const ls = linescore() || {};
    const halfInning = ls.inningHalf ? ls.inningHalf.toLowerCase() : 'top';
    const isHomeBatting = halfInning === 'bottom';
    const battingSide = isHomeBatting ? 'home' : 'away';
    const orderPos = battingOrderPosition(battingSide, batter.id);
    const scoreAway = ls.teams && ls.teams.away && ls.teams.away.runs;
    const scoreHome = ls.teams && ls.teams.home && ls.teams.home.runs;
    const plays = playsData() || {};
    const liveCount = (plays.currentPlay && plays.currentPlay.count) || null;
    const facedToday = window.Props.timesFacedToday
      ? window.Props.timesFacedToday(plays.allPlays, batter.id, pitcher.id)
      : 0;
    const gameContext = {
      inning: ls.currentInning,
      halfInning,
      battingOrderPos: orderPos,
      isHomeBatting,
      scoreAway,
      scoreHome,
      outs: ls.outs,
      gameState: gd().status && gd().status.abstractGameState,
      gameDate: gd().datetime && gd().datetime.dateTime,
      count: liveCount,
      timesFacedToday: facedToday,
    };

    window.Props.getHitPrediction(batter.id, pitcher.id, bHand, pHand, gameSeason(), gameContext)
      .then((model) => {
        if (!forecast.isConnected || forecast.dataset.matchupKey !== key) return;
        forecast.replaceChildren();
        forecast.classList.remove('loading');
        forecast.classList.add(`model-${model.coverage}`);

        const heading = UI.el('div', 'live-hit-heading');
        heading.appendChild(UI.el('span', 'live-hit-label', 'Hit forecast — this PA'));
        const valueWrap = UI.el('span', 'live-hit-value-wrap');
        valueWrap.appendChild(UI.el('strong', 'live-hit-value', `${model.prob}%`));
        if (model.tier) {
          const pill = UI.el('span', `tier-pill tier-${model.tier.key} tier-sm`, model.tier.label);
          pill.title = 'Matchup tier from the per-plate-appearance hit probability';
          valueWrap.appendChild(pill);
        }
        heading.appendChild(valueWrap);
        forecast.appendChild(heading);

        const details = UI.el('div', 'live-hit-details');
        const batterSignal = model.batter.available ? model.batter.rate.toFixed(3) : '—';
        const pitcherSignal = model.pitcher.available ? model.pitcher.rate.toFixed(3) : '—';
        details.appendChild(UI.el('span', '', `Batter ${batterSignal}`));
        details.appendChild(UI.el('span', '', `Pitcher ${pitcherSignal}`));
        details.appendChild(UI.el('span', '', `No hit ${model.noHitProb}%`));
        if (model.countFactor && model.countFactor.applied) {
          details.appendChild(UI.el('span', '', `Count ${model.countFactor.label} live`));
        }
        forecast.appendChild(details);

        // The WIDE number: chance of ≥1 hit across the remaining PAs. This is
        // what fans read on a broadcast graphic and it is where the promised
        // 16-95% spread actually lives (50-95% during live games). It is only
        // meaningful mid-game; on a Final game there are no PAs left.
        if (model.remainingPAs > 0.05 && model.gameFlowProbability > 0) {
          const proj = UI.el('div', 'forecast-projection');
          const projHead = UI.el('div', 'forecast-projection-header');
          projHead.appendChild(UI.el('span', 'forecast-projection-label',
            `≥1 hit in next ${model.remainingPAs.toFixed(1)} PAs`));
          projHead.appendChild(UI.el('strong', 'forecast-projection-value',
            `${model.gameFlowProb}%`));
          proj.appendChild(projHead);
          const projTrack = UI.el('div', 'forecast-projection-track');
          const projBar = UI.el('div', 'forecast-projection-bar tier-fill-projection');
          projBar.style.width = `${Math.max(0, Math.min(1, model.gameFlowProbability)) * 100}%`;
          projTrack.appendChild(projBar);
          proj.appendChild(projTrack);
          proj.title = '1 − (1 − per-PA hit chance) ^ remaining PAs — fan-style projection, not a betting line';
          forecast.appendChild(proj);
        }

        forecast.appendChild(UI.el('div', 'live-hit-coverage', model.coverageLabel));
        forecast.title = `Live at-bat hit forecast: ${window.Props.describeHitModel
          ? window.Props.describeHitModel(model)
          : model.coverageLabel}`;
      })
      .catch(() => {
        if (!forecast.isConnected || forecast.dataset.matchupKey !== key) return;
        forecast.classList.remove('loading');
        forecast.replaceChildren(UI.el('span', 'live-hit-label', 'Hit forecast unavailable'));
      });

    return forecast;
  }

  /* -------------------------------------------------------------- linescore */

  function renderLinescore() {
    const ls = linescore();
    const wrap = UI.clear($('#linescore-wrap'));
    if (!ls || !ls.innings || !ls.innings.length) {
      wrap.appendChild(UI.el('div', 'empty small', 'No linescore yet.'));
      return;
    }
    const status = gd().status;
    const isFinal = status && status.abstractGameState === 'Final';
    const innings = ls.innings;
    const maxInn = innings.length;

    const table = UI.el('table', 'linescore-table');
    const thead = UI.el('thead');
    const hRow = UI.el('tr');
    hRow.appendChild(UI.el('th', '', ''));
    hRow.appendChild(UI.el('th', '', 'Team'));
    for (let i = 0; i < maxInn; i += 1) {
      hRow.appendChild(UI.el('th', 'inn-cell', String(innings[i].num)));
    }
    hRow.appendChild(UI.el('th', 'total-cell', 'R'));
    hRow.appendChild(UI.el('th', 'total-cell', 'H'));
    hRow.appendChild(UI.el('th', 'total-cell', 'E'));
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = UI.el('tbody');
    for (const side of ['away', 'home']) {
      const t = teamInfo(side);
      const row = UI.el('tr', `ls-row ls-${side}`);
      row.appendChild(UI.el('td', 'ls-abbrev', t.abbrev));
      row.appendChild(UI.el('td', 'ls-name', t.name));
      let scoredLast = false;
      for (let i = 0; i < maxInn; i += 1) {
        const inn = innings[i];
        const half = inn[side] || {};
        let cell = '–';
        if (half.runs != null) {
          cell = String(half.runs);
        } else if (isFinal && i === maxInn - 1 && side === 'home') {
          cell = 'X'; // home team didn't bat in the bottom of the final inning
        }
        const td = UI.el('td', 'inn-cell', cell);
        if (half.runs != null && half.runs > 0) {
          td.classList.add('inn-run');
          if (i === maxInn - 1) scoredLast = true;
        }
        row.appendChild(td);
      }
      const totals = ls.teams[side];
      row.appendChild(UI.el('td', 'total-cell strong', String(totals.runs)));
      row.appendChild(UI.el('td', 'total-cell', String(totals.hits)));
      row.appendChild(UI.el('td', 'total-cell', String(totals.errors)));
      if (scoredLast && isFinal) row.classList.add('walkoff');
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  /* --------------------------------------------------------------- boxscore */

  function renderBoxscore() {
    const wrap = UI.clear($('#boxscore-wrap'));
    const box = boxscore();
    if (!box || !box.teams) {
      wrap.appendChild(UI.el('div', 'empty small', 'No box score yet.'));
      return;
    }
    for (const side of ['away', 'home']) {
      const team = box.teams[side];
      const t = teamInfo(side);
      const sec = UI.el('section', 'box-section');
      const head = UI.el('h3', 'box-team', `${t.name}  (${teamRecord(side)})`);
      head.style.borderLeftColor = t.id ? UI.teamColor(t.id) : '#2f81f7';
      sec.appendChild(head);
      sec.appendChild(battingTable(side, team));
      sec.appendChild(pitchingTable(side, team));
      wrap.appendChild(sec);
    }
  }

  function battingTable(side, team) {
    const table = UI.el('table', 'box-table bat-table');
    table.appendChild(headerRow(['#', 'Batter', 'AB', 'R', 'H', 'RBI', 'BB', 'SO', 'AVG']));

    const rows = orderRows(side, team);
    const tbody = UI.el('tbody');
    rows.forEach(([id, entry]) => {
      const b = (entry.stats && entry.stats.batting) || {};
      if (b.atBats == null && b.hits == null && b.rbi == null) return;
      const tr = UI.el('tr');
      tr.appendChild(UI.el('td', '', orderSlot(entry)));
      const nameCell = UI.el('td', 'player-cell');
      nameCell.appendChild(UI.el('span', 'player-name', playerName(id)));
      const pos = entry.position && entry.position.abbreviation;
      if (pos) nameCell.appendChild(UI.el('span', 'player-pos', pos));
      tr.appendChild(nameCell);
      tr.appendChild(UI.el('td', '', fmtStat(b.atBats)));
      tr.appendChild(UI.el('td', '', fmtStat(b.runs)));
      tr.appendChild(UI.el('td', '', fmtStat(b.hits)));
      tr.appendChild(UI.el('td', '', fmtStat(b.rbi)));
      tr.appendChild(UI.el('td', '', fmtStat(b.baseOnBalls)));
      tr.appendChild(UI.el('td', '', fmtStat(b.strikeOuts)));
      tr.appendChild(UI.el('td', '', b.avg != null ? b.avg : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    /* team totals */
    const tot = (team.teamStats && team.teamStats.batting) || {};
    const foot = UI.el('tfoot');
    const tr = UI.el('tr', 'totals-row');
    tr.appendChild(UI.el('td', '', ''));
    tr.appendChild(UI.el('td', '', 'Totals'));
    tr.appendChild(UI.el('td', '', fmtStat(tot.atBats)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.runs)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.hits)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.rbi)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.baseOnBalls)));
    tr.appendChild(UI.el('td', '', fmtStat(tot.strikeOuts)));
    tr.appendChild(UI.el('td', '', tot.avg != null ? tot.avg : '—'));
    foot.appendChild(tr);
    table.appendChild(foot);
    return table;
  }

  function pitchingTable(side, team) {
    const table = UI.el('table', 'box-table pitch-table');
    table.appendChild(headerRow(['Pitcher', 'IP', 'H', 'R', 'ER', 'BB', 'SO', 'HR', 'PC-ST', 'ERA']));
    const tbody = UI.el('tbody');
    (team.pitchers || []).forEach((id) => {
      const entry = team.players[`ID${id}`];
      if (!entry) return;
      const p = (entry.stats && entry.stats.pitching) || {};
      if (p.inningsPitched == null && p.outs == null && p.hits == null && p.strikeOuts == null) return;
      const tr = UI.el('tr');
      tr.appendChild(UI.el('td', 'player-cell', playerName(id)));
      tr.appendChild(UI.el('td', '', UI.fmtInnings(p.inningsPitched)));
      tr.appendChild(UI.el('td', '', fmtStat(p.hits)));
      tr.appendChild(UI.el('td', '', fmtStat(p.runs)));
      tr.appendChild(UI.el('td', '', fmtStat(p.earnedRuns)));
      tr.appendChild(UI.el('td', '', fmtStat(p.baseOnBalls)));
      tr.appendChild(UI.el('td', '', fmtStat(p.strikeOuts)));
      tr.appendChild(UI.el('td', '', fmtStat(p.homeRuns)));
      tr.appendChild(UI.el('td', '',
        p.pitchesThrown != null ? `${p.pitchesThrown}-${p.strikes != null ? p.strikes : 0}` : '—'));
      tr.appendChild(UI.el('td', '', p.era != null ? p.era : '—'));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function headerRow(cols) {
    const thead = UI.el('thead');
    const tr = UI.el('tr');
    cols.forEach((c) => tr.appendChild(UI.el('th', '', c)));
    thead.appendChild(tr);
    return thead;
  }

  /** Batting rows ordered by the API's battingOrder, then batting order numbers. */
  function orderRows(side, team) {
    const orderList = team.battingOrder || [];
    const map = new Map();
    orderList.forEach((id) => { const e = team.players[`ID${id}`]; if (e) map.set(id, e); });
    (team.batters || []).forEach((id) => {
      const e = team.players[`ID${id}`];
      if (e && !map.has(id)) map.set(id, e);
    });
    return [...map.entries()].sort((a, b) => {
      const ao = parseInt(a[1].battingOrder || '999', 10);
      const bo = parseInt(b[1].battingOrder || '999', 10);
      return ao - bo;
    });
  }

  function orderSlot(entry) {
    if (!entry.battingOrder) return '';
    const n = parseInt(entry.battingOrder, 10);
    if (Number.isNaN(n) || n <= 0) return '';
    return String(Math.floor(n / 100));
  }

  function fmtStat(v) { return v == null ? '—' : String(v); }

  /* --------------------------------------------------------- play-by-play */

  function renderPlays(reviewData) {
    const wrap = UI.clear($('#plays-wrap'));
    const plays = playsData();
    if (!plays || !plays.allPlays || !plays.allPlays.length) {
      wrap.appendChild(UI.el('div', 'empty small', 'No plays yet — check back after first pitch.'));
      return;
    }

    const atBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    const list = UI.el('div', 'plays-list');
    const absByAtBat = new Map();
    ((reviewData && reviewData.reviews) || []).forEach((r) => {
      if (r && r.typeKey === 'abs' && r.atBatIndex != null && !absByAtBat.has(r.atBatIndex)) {
        absByAtBat.set(r.atBatIndex, r);
      }
    });

    // Collect finished at-bats that need a pre-at-bat hit-probability chip.
    const probItems = [];
    let curKey = null;
    plays.allPlays.forEach((play) => {
      const result = play.result;
      const about = play.about || {};
      if (!result || !result.description || !about || !about.inning) return;
      const key = `${about.halfInning}-${about.inning}`;
      if (key !== curKey) {
        curKey = key;
        list.appendChild(playSectionHeader(about));
      }
      list.appendChild(playRow(play, probItems, absByAtBat.get(about.atBatIndex) || null));
    });
    wrap.appendChild(list);
    if (atBottom) wrap.scrollTop = wrap.scrollHeight;

    // Fill in the hit-probability chips (needs the batters' statcast stats).
    enrichPlayHitProb(probItems);
  }

  /**
   * Whether a play is a *completed* plate appearance (an at-bat that finished).
   * Live/in-progress at-bats have about.isComplete === false and are excluded,
   * since the request was specifically the probability "before taking the at bat".
   */
  function isFinishedAtBat(play) {
    const about = play.about;
    if (!about) return true;             // final games: treat as finished
    return about.isComplete !== false;   // false => still in progress
  }

  /** Did this at-bat result in a hit? Prefer the feed flag, else infer from the event. */
  function atBatWasHit(play) {
    const r = play.result || {};
    if (typeof r.isHit === 'boolean') return r.isHit;
    const ev = r.event || '';
    return /\b(Single|Double|Triple|Home Run|Ground Rule Double|Inside[\s-]the[\s-]park Home Run)\b/i.test(ev);
  }

  /**
   * Compute and paint the pre-at-bat hit forecast for each completed plate
   * appearance. Both hitter and pitcher data are warmed once per game-season;
   * cache hits make later polling renders effectively free.
   */
  async function enrichPlayHitProb(items) {
    if (!items.length || !window.Props || !window.Props.fetchPlayerStats ||
        !window.Props.getCachedPlayerStats || !window.Props.modelHitProbability) return;

    const batterIds = [...new Set(
      items.map((it) => it.play.matchup && it.play.matchup.batter && it.play.matchup.batter.id)
        .filter(Boolean)
    )];
    const pitcherIds = [...new Set(
      items.map((it) => it.play.matchup && it.play.matchup.pitcher && it.play.matchup.pitcher.id)
        .filter(Boolean)
    )];
    const season = gameSeason();

    try {
      await Promise.all([
        ...batterIds.map((id) => window.Props.fetchPlayerStats(id, 'hitting', season)),
        ...pitcherIds.map((id) => window.Props.fetchPlayerStats(id, 'pitching', season)),
      ]);
    } catch (_) { /* individual fetch failures fall back to the league baseline */ }

    // Chronological pair counts give each chip the times-through-the-order
    // context of its own moment (items are collected in allPlays order).
    const pairSeen = new Map();
    const feedGameDate = gd().datetime && gd().datetime.dateTime;
    items.forEach(({ play, chip, bHand, pHand }) => {
      // A new poll may have rebuilt the play list while requests were pending.
      if (!chip.isConnected) return;

      const matchup = play.matchup || {};
      const batterId = matchup.batter && matchup.batter.id;
      const pitcherId = matchup.pitcher && matchup.pitcher.id;
      const batterData = batterId
        ? window.Props.getCachedPlayerStats(batterId, 'hitting', season)
        : null;
      const pitcherData = pitcherId
        ? window.Props.getCachedPlayerStats(pitcherId, 'pitching', season)
        : null;
      const batterStats = window.Props.parseBatterStats
        ? window.Props.parseBatterStats(batterData)
        : window.Props.parseStatcast(batterData);
      const pitcherStats = window.Props.parsePitcherStats
        ? window.Props.parsePitcherStats(pitcherData)
        : null;
      const playAbout = play.about || {};
      const playResult = play.result || {};
      const playCount = play.count || {};
      const playHalfInning = playAbout.halfInning ? playAbout.halfInning.toLowerCase() : 'top';
      const playIsHomeBatting = playHalfInning === 'bottom';
      const playBattingSide = playIsHomeBatting ? 'home' : 'away';
      const playOrderPos = battingOrderPosition(playBattingSide, batterId);
      const pairKey = `${batterId}:${pitcherId}`;
      const faced = pairSeen.get(pairKey) || 0;
      pairSeen.set(pairKey, faced + 1);

      const gameContext = {
        inning: playAbout.inning,
        halfInning: playHalfInning,
        battingOrderPos: playOrderPos,
        isHomeBatting: playIsHomeBatting,
        scoreAway: playResult.awayScore,
        scoreHome: playResult.homeScore,
        outs: playCount.outs,
        gameState: 'Live',
        gameDate: feedGameDate,
        timesFacedToday: faced,
      };

      const model = window.Props.modelHitProbability(batterStats, pitcherStats, bHand, pHand, gameContext);
      const gotHit = atBatWasHit(play);

      chip.replaceChildren();
      chip.classList.remove('loading');
      chip.classList.add(gotHit ? 'hit-yes' : 'hit-no', `model-${model.coverage}`);
      chip.appendChild(UI.el('span', 'hp-label', 'Hit'));
      chip.appendChild(UI.el('span', 'hp-val', `${model.prob}%`));
      chip.appendChild(UI.el('span', 'hp-mark', gotHit ? '✓' : '✗'));
      const modelDetail = window.Props.describeHitModel
        ? window.Props.describeHitModel(model)
        : model.coverageLabel;
      chip.title = `Pre-at-bat hit forecast: ${model.prob}% · ${modelDetail} · ` +
        (gotHit ? 'got the hit' : 'no hit');
    });
  }

  function playSectionHeader(about) {
    const head = UI.el('div', 'play-section-head');
    const tag = UI.el('span', `half-tag half-${about.halfInning}`,
      about.halfInning === 'top' ? '▲' : '▼');
    head.appendChild(tag);
    head.appendChild(UI.el('span', '', MLB.ordinal(about.inning)));
    return head;
  }

  function playRow(play, probItems, absReview) {
    const result = play.result;
    const about = play.about || {};
    const count = play.count || {};

    const row = UI.el('div', 'play-row');
    const main = UI.el('div', 'play-main');
    main.appendChild(UI.el('span', 'play-desc', result.description));
    row.appendChild(main);

    const chips = UI.el('div', 'play-chips');

    /* replay review / challenge chip if applicable */
    const playEvents = play.playEvents || [];
    const revDetails = play.reviewDetails || (playEvents.find((e) => e.reviewDetails) && playEvents.find((e) => e.reviewDetails).reviewDetails) || null;
    const hasReview = about.hasReview === true || !!revDetails ||
      /challenge|review|overturned|call stands|call confirmed/i.test(result.description || '');

    if (hasReview) {
      row.classList.add('play-has-review');
      // reviewDetails.reviewType is a short code ("MJ"=ABS, "MA"/"MF"=manager);
      // resolve it through the shared parser so chips never show raw codes.
      const typeMeta = window.MLBReviews
        ? window.MLBReviews.normalizeType(revDetails && revDetails.reviewType, result.description || '')
        : null;
      const revType = (typeMeta && typeMeta.label) ||
        (/abs\b/i.test(result.description || '') ? 'ABS Challenge' :
        /crew chief/i.test(result.description || '') ? 'Crew Chief' : 'Challenge');
      const isOverturned = (revDetails && revDetails.isOverturned === true) ||
        /overturned/i.test(result.description || '');
      const isStands = (revDetails && revDetails.isOverturned === false) ||
        /stands|confirmed/i.test(result.description || '');
      const outcomeCls = isOverturned ? 'chip-rev-overturned' : isStands ? 'chip-rev-stands' : 'chip-rev-review';
      const outcomeText = isOverturned ? 'Overturned' : isStands ? 'Stands' : 'Review';
      const revChip = UI.el('span', `chip-play-review ${outcomeCls}`, `🔍 ${revType}: ${outcomeText}`);
      revChip.title = `Replay Review: ${result.description}`;
      chips.appendChild(revChip);
    }

    /* score after play (only when it changed) */
    if (about.isScoringPlay || (result.rbi || 0) > 0) {
      const away = teamInfo('away');
      const home = teamInfo('home');
      chips.appendChild(UI.el('span', 'chip-score',
        `${away.abbrev} ${result.awayScore}, ${home.abbrev} ${result.homeScore}`));
    }

    /* count */
    chips.appendChild(UI.el('span', 'chip-count',
      `B ${count.balls} · S ${count.strikes} · O ${count.outs}`));

    /* pitch strip */
    const pitches = (play.playEvents || []).filter((e) => e.isPitch);
    if (pitches.length) {
      const strip = UI.el('span', 'pitch-strip');
      pitches.forEach((e) => {
        const call = e.details && e.details.call;
        const type = e.details && e.details.type;
        const velo = e.pitchData && e.pitchData.startSpeed;
        const dot = UI.el('span', `pitch-dot p-${(call && call.code || '?').toLowerCase()}`);
        dot.textContent = (type && type.code) || (call && call.code) || '?';
        dot.title = `${call ? call.description : ''} · ${type ? type.description : ''}` +
                    (velo ? ` · ${velo} mph` : '');
        strip.appendChild(dot);
      });
      chips.appendChild(strip);
    }

    /* two-sided pre-at-bat forecast (completed plate appearances only) */
    if (window.Props && window.Props.modelHitProbability && probItems &&
        isFinishedAtBat(play) && pitches.length &&
        play.matchup && play.matchup.batter && play.matchup.batSide) {
      const bHand = play.matchup.batSide.code || '';
      const pHand = play.matchup.pitchHand ? play.matchup.pitchHand.code : '';
      const chip = UI.el('span', 'chip-hitprob loading', 'Hit …');
      chip.title = 'Loading two-sided pre-at-bat hit forecast';
      chips.appendChild(chip);
      probItems.push({ play, chip, bHand, pHand });
    }

    row.appendChild(chips);
    return row;
  }

  /* ------------------------------------------------------------ live stats */

  /** Position in the batting order (1-9) for a batter id. */
  function battingOrderPosition(side, batterId) {
    const box = boxscore();
    if (!box || !box.teams || !box.teams[side]) return null;
    const order = box.teams[side].battingOrder || [];
    const idx = order.indexOf(batterId);
    return idx >= 0 ? idx + 1 : null;
  }

  /** Next batters (on deck, in the hole) given current batter id. */
  function nextBatters(side, batterId) {
    const box = boxscore();
    if (!box || !box.teams || !box.teams[side]) return [];
    const order = box.teams[side].battingOrder || [];
    const idx = order.indexOf(batterId);
    if (idx < 0 || order.length < 2) return [];
    // Batting orders wrap after the ninth hitter.
    return [order[(idx + 1) % order.length], order[(idx + 2) % order.length]]
      .filter((id) => id && id !== batterId).map(playerName);
  }

  /** Accurate occupied bases from linescore.offense, with PBP as a fallback. */
  function basesOnField(ls, currentPlay) {
    const offense = (ls && ls.offense) || {};
    const bases = {
      first: !!offense.first,
      second: !!offense.second,
      third: !!offense.third,
    };
    const labels = [];
    [['first', '1st'], ['second', '2nd'], ['third', '3rd']].forEach(([key, label]) => {
      if (bases[key]) labels.push(label);
    });
    if (ls && ls.offense) return { bases, labels };

    const runners = (currentPlay && currentPlay.runners || [])
      .filter((r) => r.movement && !r.movement.isOut && r.movement.end);
    return {
      bases: UI.basesFromRunners(runners),
      labels: runners.map((r) => shortBase(r.movement.end)),
    };
  }

  /** Total pitches / strikes thrown by a pitcher so far, from play events. */
  function countPitcherPitches(pid) {
    const plays = playsData();
    if (!plays || !plays.allPlays) return { total: 0, strikes: 0 };
    let total = 0; let strikes = 0;
    plays.allPlays.forEach((play) => {
      (play.playEvents || []).forEach((e) => {
        if (!e.isPitch) return;
        const p = e.matchup && e.matchup.pitcher;
        if (p && p.id === pid) {
          total += 1;
          if (e.details && e.details.isStrike) strikes += 1;
        }
      });
    });
    return { total, strikes };
  }

  function lastPitchVelo(pid) {
    const plays = playsData();
    if (!plays || !plays.allPlays) return null;
    for (let i = plays.allPlays.length - 1; i >= 0; i -= 1) {
      const events = plays.allPlays[i].playEvents || [];
      for (let j = events.length - 1; j >= 0; j -= 1) {
        const e = events[j];
        const p = e.matchup && e.matchup.pitcher;
        if (e.isPitch && p && p.id === pid && e.pitchData && e.pitchData.startSpeed) {
          return Math.round(e.pitchData.startSpeed);
        }
      }
    }
    return null;
  }

  function batSideDesc(bs) {
    if (!bs) return '';
    const map = { L: 'Bats L', R: 'Bats R', S: 'Bats S' };
    return map[bs.code] || bs.description || '';
  }

  function pitchHandDesc(ph) {
    if (!ph) return '';
    const map = { L: 'LHP', R: 'RHP', S: 'SHP' };
    return map[ph.code] || ph.description || '';
  }

  function shortBase(base) {
    return ({ '1B': '1st', '2B': '2nd', '3B': '3rd' })[base] || base;
  }

  /* ------------------------------------------------------------------- tabs */

  function wireTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
  }

  function setTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('tab-on', b.dataset.tab === tab);
    });
    $('#panel-plays').style.display = tab === 'plays' ? '' : 'none';
    $('#panel-boxscore').style.display = tab === 'boxscore' ? '' : 'none';
    $('#panel-props').style.display = tab === 'props' ? '' : 'none';
    $('#panel-reviews').style.display = tab === 'reviews' ? '' : 'none';
    if (tab === 'reviews') syncGameScoringChanges();
    // Lazy rendering keeps live updates fast on the default play-by-play view.
    const rawReviewData = window.MLBReviews ? window.MLBReviews.extractReviews(feed) : { reviews: [], activeReview: null, summary: {} };
    const allReviews = [...(rawReviewData.reviews || []), ...gameScoringChanges];
    const reviewData = {
      ...rawReviewData,
      reviews: allReviews,
      scoringChanges: gameScoringChanges,
    };
    if (feed && tab === 'boxscore') renderBoxscore();
    if (feed && tab === 'plays') renderPlays(reviewData);
    if (feed && tab === 'props' && window.Props) window.Props.render($('#props-wrap'), feed);
    if (feed && tab === 'reviews' && window.MLBReviews) window.MLBReviews.renderReviewsTab($('#reviews-wrap'), reviewData);
  }

  /* ------------------------------------------------------------ status line */

  function renderStatusLine() {
    const line = $('#status-line');
    const updated = new Date().toLocaleTimeString();
    const ls = linescore();
    const bits = [`Updated ${updated}`];
    if (isLive()) {
      const interval = currentInterval() / 1000;
      bits.push(`refreshing every ${interval}s`);
    }
    // While the official status says review but the feed has not caught up
    // (the status-lead grace), keep the 🚨 label on screen instead of letting
    // the ordinary "Updated …" line erase it.
    if (statusLeadGraceActive()) {
      bits.unshift(`🚨 ${statusLeadLabel} — loading details…`);
    }
    line.textContent = bits.join(' · ');
  }

  function $(sel) { return document.querySelector(sel); }
})();
