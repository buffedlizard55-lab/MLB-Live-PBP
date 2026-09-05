# Latency Audit & Implementation — Review / Challenge / Boundary / Scoring-Pending / Scoring-Change updates

**Scope:** this document first traces — **line by line, no guessed field names, no invented
numbers** — how each requested update category reaches the UI and what its latency ceiling is.
It then records the latency **reductions that were implemented** (see the dated addenda below)
after re-reviewing the same code paths. Every figure below is tied to a real code line/constant
or to a live-verification already documented in this repo; wall-clock timings were not
re-measured here (this sandbox's shell has no outbound network — some endpoints were
re-verified live on 2026-09-05 through the sandbox's page-fetch tool; see the 2026-09-05
addendum and `docs/verification-report.md` §18).

**Baseline:** all deterministic suites green before this audit and green again after every change
(`node tools/{api-fields,api-rate-limit,feed-log-persistence,hit-model,official-scoring,page-status-watcher,replay-feed-render,review-probe,review-status,review-test,review-watcher,reviews-feed,scoring-change}-test.mjs`).

---

## >> CHANGE IMPLEMENTED — 2026-09-05: every remaining multi-250ms gap closed (politely)

The 2026-09-04 pass left the Replay Feed at the pull floor but listed three deliberately
unimplemented options (old §8) plus one cadence tier. All are implemented now, verified
line by line, with tests. **No API keys exist** (the MLB StatsAPI is keyless); politeness is
therefore enforced by design — bounded request rates, hidden-tab pause, idle backoff, a
30-minute post-Final grace, and a **new HTTP-429 self-throttle** that backs the whole client
off for 60s if the API ever says "slow down". Worst case on a full ~15-game slate is ~64
requests/s from one browser (~60 lean playByPlay + ~4 tiny status sweeps) — two orders of
magnitude below "thousands of requests per second".

| # | Change | File:line (2026-09-05) | Effect on the categories you listed |
|---|---|---|---|
| 1 | Replay Feed live playByPlay scan **500ms → 250ms** | `reviews-feed.js:1698` (`LIVE_POLL_MS = 250`) | First detection of **official-scoring-pending markers**, **live scoring-change diffs**, **ABS challenge rows**, **runs-at-risk detail** and **review outcome rows** drops from ≤500ms to ≤250ms + one round trip — the same floor the status watcher already gave review flips. This is the cadence the page already used whenever any review was in flight; it is now the ordinary live cadence (inside the README's documented 0.25–0.5s etiquette band). |
| 2 | Post-Final fast rescan **5s → 2.5s** | `reviews-feed.js:1766` (`SCORING_RECENT_RESCAN_MS = 2.5 * 1000`) | A **scoring change published right after a game goes Final** is caught in ≤2.5s during the first 5 minutes (was ≤5s), ≤15s afterwards, grace still capped at 30min — ≤~220 requests per finished game total. |
| 3 | Game page: dedicated **250ms review-status watcher** | `game.js:33-44` (constants), `:356-423` (`statusWatchIntervalMs`/`scheduleStatusWatch`/`pollGameStatus`) | A **brand-new challenge/review/boundary call** on the game page is detected in ≤250ms (was ≤500ms + full-feed cycle): the ~150-byte per-game status projection is swept on its own timer; on a review-code flip it paints "🚨 \<official detailedState\> — loading details…" and kicks an out-of-band full feed that renders the banner. It replaces the old in-cycle raced probe (same projection, faster clock, same request budget). A 3s *status-lead grace* (`STATUS_LEAD_GRACE_MS`, game.js:44) keeps the official status trusted over the lagging feed so the two writers cannot flap. |
| 4 | Scoreboard: dedicated **250ms slate status watcher** | `scoreboard.js:26-30` (constants), `:154` (`scheduleStatusFlips`, pure + tested), `:190-225` (`scheduleReviewStatus`), `:227-270` (`pollReviewStatus`) | The 🚨 **review ticker / card badges / Challenges tab** appear ≤250ms after MLB flips any game to a review code (was: next 500ms hydrated-schedule poll), via the same ~2.4KB whole-slate projection the Replay Feed uses. Re-renders only on a real status flip; the main schedule poll keeps its own 500ms cadence (scores don't need 250ms; review status does). |
| 5 | **HTTP-429 self-throttle** in the shared client | `api.js:42` (`RATE_LIMIT_BACKOFF_MS = 60s`), `:46` (`rateLimitedForMs`), `:60-63,72` (arm on 429, wait before every request) | Honors the API's own "slow down" signal: after ANY 429, every endpoint funneled through `getJSON()` waits out the remainder of a 60s quiet period before its next request. Normal 2xx/404/500 traffic never trips it (`tools/api-rate-limit-test.mjs` pins all six behaviors). |

**Bugs the new integration tests caught during implementation** (fixed before landing —
this is why the boot-path tests exist):
- Re-arming a watcher from every poll cycle *resets its 250ms phase* and silently degrades it
  to ~2 sweeps/s (`tools/page-status-watcher-test.mjs` §A3/§B1). The watchers are now
  **self-perpetuating** — armed exactly once per shown-tab lifetime.
- After a review resolves with no further play, the game page's feed token is stable, so
  `lastActiveReview` was only recomputed inside `renderAll` and could stay stuck `true`
  forever (§B4). It is now recomputed on every unchanged-token cycle too.
- The game-page watcher parks at a **1s timer-only check-in** (no requests) while a review is
  known (`STATUS_WATCH_RECHECK_MS`, game.js:34) so a back-to-back status-only challenge after
  a resolution is caught in ≤1s, not ≤5s.

**Updated category table (all surfaces, 2026-09-05):**

| Category | Ceiling before | Ceiling now |
|---|---|---|
| New challenge / review / boundary / under-review (Replay Feed) | 250ms watcher | 250ms watcher (unchanged — already at floor) |
| Same, on the **game page** | ~500ms + feed RTT | **≤250ms + feed RTT** (watcher, #3) |
| Same, on the **scoreboard ticker** | ~500ms schedule poll | **≤250ms** (watcher, #4) |
| All review updates / outcomes (feed + game page) | 250ms (probe/watcher) | 250ms (unchanged) |
| Runs at risk | ~1 pbp RTT after flip | unchanged, plus scan-side detail now ≤250ms (#1) |
| Official scoring pending — first marker | ≤500ms | **≤250ms** (#1) |
| Official scoring pending — resolution (live) | ≤250ms while pending (`inProgress:true` rows keep the feed fast — verified `reviews.js:419`) | unchanged |
| Scoring change tracker — live | ≤500ms | **≤250ms** (#1) |
| Scoring change tracker — post-Final | ≤5s (first 5min) / ≤15s | **≤2.5s** / ≤15s (#2) |

**Not done, deliberately:** no cadence below 250ms (the API is pull-only; sub-250ms polling
would multiply requests for at most ~125ms of average gain), no per-game cadence splitting on
the feed (the whole-slate wave is one request deep; splitting adds complexity without changing
the floor), and the game page's full-feed poll stays at 500ms (review-relevant paths are all
at 250ms; doubling full-feed bytes for scores was judged impolite). The §16.4 caveat that a
live mid-review `statusCode:"MA"` payload has never been captured still stands — the watcher
is driven by the same registry that §16.1 cross-checked, and the deterministic tests drive it
with verbatim registry rows.

---

## > CHANGE IMPLEMENTED — 2026-09-04: post-Final scoring-change detection tightened

The audit (sections 2/6 below) isolated **one genuine multi-second latency tail**: official
scoring changes published *after a game goes Final* were re-scanned only every **30 s**
(`SCORING_FINAL_RESCAN_MS`). Everything else was already at the pull-API floor (~250–500 ms).

That flat 30 s gap is now a **recency-tiered** rescan inside the same bounded 30-minute grace
(`assets/js/reviews-feed.js`):

- `SCORING_RECENT_RESCAN_MS = 5 * 1000` — while a game is **recently Final** (first 5 minutes,
  `SCORING_RECENT_FINAL_WINDOW_MS = 5 * 60 * 1000`), a scorer ruling is picked up every ~5 s
  instead of ~30 s (~6× faster exactly when a change is most likely to land).
- `SCORING_FINAL_RESCAN_MS = 15 * 1000` — the base gap once that window passes (still 2× tighter
  than the old 30 s).
- `SCORING_CHANGE_GRACE_MS = 30 * 60 * 1000` — unchanged; a Final is **never** polled beyond
  30 minutes, so total request volume stays bounded.

`finalScanDecision()` now accepts two optional params (`fastRescanMs`, `fastWindowMs`); callers
that pass only a uniform gap (and the pre-existing uniform-gap tests) keep identical semantics.
New deterministic cases in `tools/scoring-change-test.mjs` §10 pin the fast window, the taper back
to the base gap, and that the tiers never extend polling past the grace window. All nine suites
pass. Net effect: **the worst-case wait for a post-Final scoring change drops from ~30 s to ~5 s
in the early, most-likely window, and ~15 s afterward — with no additional request volume beyond
the previously-bounded 30-minute grace.**

Why this was the right (and only clearly-safe) lever to pull under "keep it polite": the other
asymmetries (game page / scoreboard detecting a brand-new review at ~500 ms, and any sub-250 ms
push) are below this, but each costs **additional** requests per second that the README's
"good citizen" guidance and the earlier "keep it polite" instruction argue against. Those remain
listed as options in section 8.

---

## 1. Method (anti-hallucination)

- Every category below is traced to its **detection signal** (which API field flips first)
  and its **poll cadence** (which constant, which file/line).
- The cadence constants were read from the files with `grep -n`, not recalled.
- The repo's own live-verification history (`docs/verification-report.md` §15 "Update latency",
  §16 "review-status registry + 250 ms watcher", §13 ABS sectioning, §14 pending rulings,
  §11 runs-at-risk, §10 score impact) is cited for signal semantics (e.g. "status flips when a
  review is *called*, play text is written when it *resolves*"). Those payload-size numbers are
  **repo-documented live results, not re-measured in this session** — labelled as such.

### Why "poll interval + one round trip" is the floor

The MLB StatsAPI is **pull-only** (no push/streaming). A client learns about a change only on
its next request. So for any event:

```
time-to-user ≈ time until the next poll STARTS (cadence) + one HTTP round trip (RTT)
               + (in JS, negligible parse/render, already incremental)
```

You cannot beat "one cadence + one RTT" without a push endpoint. The question for each category
is therefore: *what is the cadence of the poll that carries that category's signal, and is that
signal the earliest one MLB publishes?*

---

## 2. One-page answer (what reaches you when)

*(2026-09-05: the 500ms ceilings in this table were halved to 250ms and the §8 options 1–2
were implemented — see the addendum at the top. The table below is preserved unchanged as
the 2026-09-04 baseline it verified.)*

| Category you listed | Earliest official signal MLB publishes | Detected by (surface) | Cadence of that poll | New-event latency ≈ |
|---|---|---|---|---|
| **Under review / reviews / challenges / boundary calls** (play is being reviewed *right now*) | game `status.statusCode` → registry review code (`M*`/`N*`/`IH`) — flips when review is **called** | **Replay Feed watcher** `pollReviewStatus()` | **250 ms** (`REVIEW_STATUS_POLL_MS`) while any game is Live | ≤ 250 ms + one sweep RTT to paint the LIVE-REVIEW strip; full row after one out-of-band playByPlay scan |
| **Boundary calls** (NH subtype) | same status registry (`statusCode` `NH`) **and** event `reviewDetails.reviewType:"NH"` in playByPlay | Replay Feed watcher + scan | 250 ms (watcher) | same as above |
| **Runs at risk** | the reviewed play's `runners[]` (`details.isScoringEvent`) credited to the reviewed event, read from playByPlay | Replay Feed scan of the reviewed game, then `shouldRunRiskAlert` / chime | out-of-band scan triggered by the watcher flip (then 250 ms) | ~1 playByPlay RTT after the flip is seen |
| **Official scoring pending** (`⚖️`) | playByPlay event/result marker `os_ruling_pending_primary` / `os_ruling_pending_prior` (**no game-status field exists**) | Replay Feed playByPlay scan (`findOfficialScoringPendingPlay`) | 500 ms live / 250 ms if that game is under review | ≤ 500 ms + one scan RTT (rides the playByPlay scan; no status watcher can speed it up — MLB publishes no status for it) |
| **Scoring change tracker** (`✏️`, live game) | play-by-play classification diff (hit↔error↔out) between polls | Replay Feed `mergeScoringChanges` | 500 ms live / 250 ms in review | ≤ 500 ms + one scan RTT |
| **Scoring change tracker** (`✏️`, after a game is Final) | same playByPlay diff, published by the scorer after the game ends | Replay Feed re-scan of that Final | **recency-tiered**: ~5 s while recently Final (`SCORING_RECENT_RESCAN_MS`), then ~15 s (`SCORING_FINAL_RESCAN_MS`), all inside the 30 min post-Final grace | **~5 s → ~15 s** (was a flat ~30 s; see addendum) |
| Any new feed row / all review updates | whichever source above fires first | Replay Feed `mergeFeedEvents` → incremental render + ≤1 chime/poll | 250–500 ms | same as its category above |

**Bottom line:** the *Replay Feed* (`reviews.html`) is already the fastest surface and sits at the
pull-API floor (~250 ms) for review-state detection. The one remaining asymmetry of note is the
**game page / scoreboard**, which detect a *brand-new* review at their ~500 ms live cadence rather
than the feed's 250 ms watcher; both drop to 250 ms once the review is known. The former slow tail
— **post-Final scoring changes** at a flat ~30 s — has been cut to a recency-tiered ~5 s → ~15 s
(see the addendum). Details and the exact code below.

---

## 3. Line-by-line: the Replay Feed (`assets/js/reviews-feed.js`)

### 3a. The "earliest signal" watcher (fastest path in the repo)

- `REVIEW_STATUS_POLL_MS = 250` — **L1379**
- `REVIEW_STATUS_IDLE_MS = 5000` — **L1380** (nothing Live → backs off; a review cannot start on a not-yet-started game)
- `REVIEW_STATUS_TIMEOUT_MS = 2500` — **L1381** (stalled sweep fails fast, next tick retries)
- `reviewStatusIntervalMs()` — **L3112–3115**: sweeps at 250 ms only while ≥1 game is Live **or** already in a review state.
- `scheduleReviewStatus()` — **L3118+**: `document.hidden` → parks at 5 s (polite; no background hammering).
- `pollReviewStatus()` — **L3141+**: guarded so a sweep never overlaps itself (`reviewStatusInFlight`); calls `MLB.getReviewStatus` (the ~2.4 KB fields-projected schedule — repo-documented live, §16.2).
- On a flip (`reviewStatusFlips` at L439 detects enter/leave/code-change): `mergeReviewStatusIntoGames` (L3183) copies the fresh official status into `games` field-by-field, `renderActiveStrip()` (L2461) paints the **🚨 LIVE REVIEW** strip *immediately from status alone* (before any play text exists), then an **out-of-band `load()`** is kicked instead of waiting for the next tick.
- First sweep runs at boot (`pollReviewStatus()` in the DOMContentLoaded handler), so a page opened mid-review shows it on first paint.
- Hidden-tab handling: `visibilitychange` → re-sweep on show, `stopPolling()` on hide (L3257–3264).

> **Why status, not play text:** the official game `status` flips the instant a review is **called**,
> while the play description the parser also reads ("…challenged (tag play), call on the field was
> overturned…") is written when the review **resolves**. This is the repo's documented, live-verified
> finding (verification-report §16). Reading status is therefore strictly earlier than reading text.

### 3b. The poll cadences that carry each category's content

- `LIVE_POLL_MS = 500` — **L1329**
- `REVIEW_POLL_MS = 250` — **L1330** (used whenever `hasActiveReviewSignal()` is true, L3032)
- `IDLE_POLL_MS = 5000` — **L1331**
- `currentInterval()` — **L3043–3051**: picks reviewMs(250) if any active review signal, else liveMs(500), else idleMs.
- `pollIntervalMs()` — **L359–363** (pure helper; same policy, unit-tested).
- `scheduleNext()` — **L3085+**: `waitAfterScan` subtracts the time the just-finished scan took, so the *cycle* is `interval`, not `scan + interval` (a slow request does not stretch detection).

### 3c. Where the per-game detail comes from (rows, runs-at-risk, pending, scoring changes)

`ingestGame()` (**L2175+**) fetches each candidate game's **fields-projected playByPlay** and runs the
parsers. This is the step that turns a status-only "under review" into a full row.

- `PBP_FIELDS` (api.js L295+) — the `fields=` projection; repo-documented live as ~3× smaller than the raw playByPlay (§15).
- `PBP_TIMEOUT_MS = 3000`, `PBP_RETRIES = 0` — **L1343 / L1344**; per-game fail-fast; the next poll retries (a stalled game occupies its own slot ≤3 s but the 30-way pool keeps other games moving).
- `FETCH_CONCURRENCY = 30` — **L1350**; whole slate ≈ one parallel wave (~15 games), so a review outcome is not serialized behind 14 others.
- **Fetch order:** `reviewFetchPriority()` — in-review games first, then other live, then finals — so an outcome flip on a 15-game slate is not last in line.
- `mergeFeedEvents()` — new/updated/ended rows; `reconcileScoreImpact()` keeps the first-observed score snapshot.
- Alert timing: `maybeAlertNow()` (**L2071**) fires the chime from `ingestGame` the **moment the FIRST** game response carries a new/at-risk event (render has already painted via `renderFeedUpdates`), not after the slowest game. `pollAlertFired` keeps ≤1 chime/poll.
- Runs-at-risk: `syncRunRiskTracking()` (**L2376**) reconciles keys once per poll so a long review alerts once, not once per second, while a genuinely new risky review always alerts.

### 3d. Official-scoring pending & scoring-change tail

- `SCORING_CHANGE_GRACE_MS = 30 * 60 * 1000` (30 min after Final)
- `SCORING_RECENT_RESCAN_MS = 5 * 1000` (fast gap while recently Final) and `SCORING_RECENT_FINAL_WINDOW_MS = 5 * 60 * 1000` ("recently Final" = first 5 minutes) — see the addendum at the top.
- `SCORING_FINAL_RESCAN_MS = 15 * 1000` (base gap once the fast window passes)
- `finalScanDecision()` bounds it: a Final is re-scanned only within the 30 min grace, at the fast ~5 s gap while recently Final, then the ~15 s base gap.
- Official-scorer pending (`⚖️`): detected by `findOfficialScoringPendingPlay()` (reviews.js) from the official event-type registry codes `os_ruling_pending_primary`/`os_ruling_pending_prior`, which are **playByPlay-only** — there is no game-status code for them, so this category rides the playByPlay scan cadence (500 ms live / 250 ms in-review). It is **not** on the scoreboard (the scoreboard only reads the schedule, which never carries these markers).

---

## 4. Line-by-line: the Game page (`assets/js/game.js`)

- `LIVE_POLL_MS = 500` — **L15**; `REVIEW_POLL_MS = 250` — **L16**; `PREVIEW_POLL_MS = 60000` — **L17**; `FINAL_POLL_MS = 180000` — **L18**.
- `PROBE_TIMEOUT_MS = 3000`, `PROBE_RETRIES = 0` — **L22–23**.
- `statusSaysReview()` — **L57** (registry-first; identical to the feed/scoreboard/ui copies, cross-pinned by `tools/review-status-test.mjs`).
- `currentInterval()` — **L277–282**: in review → 250 ms (`REVIEW_POLL_MS`), else 500 ms live.
- In-review fast path: when `lastActiveReview` is true, `load()` probes the **lean playByPlay** (`MLB.getPlayByPlay`) at the 250 ms cadence and only pulls the full 1–2 MB feed when the review signature flips (`reviewProbeState`, L113). So while a game is under review, outcome changes are seen every ~250 ms with a small payload.
- New-review detection while live but not yet in review: each 500 ms `load()` **races** a ~150-byte per-game status projection (`MLB.getGameStatus`, L182; api.js L147) against the full feed. If the small probe reports a review state first it flips `lastActiveReview` (→ 250 ms cadence) and posts "🚨 … — loading details…" on the status line. But the review *banner* itself is rendered only from the authoritative full feed (`renderAll` → `extractReviews.activeReview`), so the **first** banner on this page still waits for a full-feed cycle at the 500 ms cadence.

**Asymmetry, stated plainly:** the game page detects a *brand-new* review at up to its 500 ms live
cadence (feed-1 RTT for the banner), then drops to 250 ms for the duration. That is why the UI links
out to `reviews.html`, where the 250 ms status watcher catches the review-state flip earliest.

---

## 5. Line-by-line: the Scoreboard (`assets/js/scoreboard.js`)

- `LIVE_POLL_MS = 500` — **L12**; `REVIEW_POLL_MS = 250` — **L13**; `IDLE_POLL_MS = 5000` — **L14**.
- `gameIsUnderReview()` — **L93** (registry-first status check).
- `scheduleNext()` — **L106–111**: 250 ms while any game is under review, 500 ms while any game is Live, 5 s idle; subtracts scan time so a slow response does not stretch the cycle.
- Detection source: the scoreboard reads only the **hydrated schedule** (`MLB.getSchedule` in `load()`). It has **no separate lightweight status watcher**. A *brand-new* review is therefore seen on the next schedule poll — i.e. up to the ~500 ms live cadence — after which the page drops to 250 ms.
- Scope limits (accurate, not a defect): the scoreboard ticker/banner reflects review **status** only. It cannot show **official-scoring-pending** or **scoring changes**, because those live in playByPlay and never appear on the schedule.

---

## 6. Verified conclusions

1. **Review-state detection on the Replay Feed is at the practical floor.** For a pull-only API the
   floor is *one cadence + one RTT*. `reviews.html` already polls the earliest signal (game status)
   at 250 ms via a watcher and kicks an out-of-band scan on a flip. The documented worst case is
   ~250 ms + one round trip (verification-report §16.2). No further reduction is possible without a
   shorter interval (more requests) or a push API.

2. **Everything the user listed is covered, and each has a concrete ceiling:**
   - challenges / reviews / boundary / under-review → 250 ms watcher (Replay Feed).
   - runs-at-risk → ~one playByPlay RTT after the flip is seen, chime on the first game response.
   - official scoring pending → ≤ 500 ms (rides the playByPlay scan; no status signal exists).
   - scoring changes → ≤ 500 ms live; **~5 s while a game is recently Final, ~15 s after** (the recency-tiered post-Final rescan implemented in the addendum).

3. **The remaining asymmetry to know about** (a cadence trade-off, not a miss): **game.html /
   scoreboard detect a brand-new review at their ~500 ms live cadence**, not the feed's 250 ms
   watcher. Both drop to 250 ms once the review is known. The former post-Final ~30 s scoring-change
   gap is gone — now a recency-tiered ~5 s → ~15 s rescan inside the fixed 30-min grace (addendum),
   applied and pinned by `tools/scoring-change-test.mjs` §10.

4. **Polite-by-design and effective:** hidden-tab pause + idle backoff on all three pages
   (reviews-feed.js L3123/L3257, game.js L82, scoreboard.js L119/L394). Polls subtract scan time so
   latency does not accumulate. Nothing here exceeds the "good citizen" usage the README documents.

---

## 7. What I did NOT claim (guard against hallucination)

- I did **not** claim wall-clock milliseconds — this sandbox's test tools have no outbound network;
  the payload sizes / "flips when called vs. when resolved" facts are the repo's own live-verified
  results (§15/§16), cited as such.
- I did **not** claim a live mid-review payload was captured here (none was; verification-report §16.4
  records the same).
- The single production change in this pass is the **recency-tiered post-Final rescan** documented
  in the addendum at the top (`assets/js/reviews-feed.js` `finalScanDecision` + constants; new cases
  in `tools/scoring-change-test.mjs` §10). Everything else remains an audit; no other cadence
  constant or logic was altered.

## 8. Remaining options to push further (not implemented — each costs extra API requests)

> **[2026-09-05 update: options 1 and 2 below — the game.html and scoreboard status
> watchers — ARE implemented now (see the addendum at the top, changes #3 and #4).
> Option 3 remains not implemented by design: official-scoring-pending and scoring
> changes cannot be surfaced from the schedule, and per-game playByPlay polling on
> the scoreboard would add per-game requests every cycle for categories the Replay
> Feed already delivers at 250ms.]**

- **game.html new-review detection:** add a standalone ~150-byte status watcher (mirroring the feed) so a brand-new review drops the page to 250 ms without waiting for the next 500 ms feed cycle.
- **Scoreboard new-review detection:** add the same lightweight watcher so the ticker appears at ~250 ms instead of the next ~500 ms schedule poll.
- **game.html / scoreboard official-scoring-pending & scoring-changes:** neither can be surfaced there from the schedule; they would require these pages to also poll each game's playByPlay (adding per-game requests every cycle).
- Any of these trades **more API requests for fewer milliseconds** — deliberately left out under the "keep it polite" instruction. The post-Final rescan (the one multi-second gap) was implemented because it stays within the pre-existing bounded grace and therefore adds **no** unbounded request volume.
