# Official Scoring Change Tracking (initial call → final ruling)

**Date:** 2026-09-04
**Status:** ✅ Fully Implemented and Tested
**Requirement:** Track plays whose official-scoring ruling CHANGES after the initial call (error↔hit, single↔double, double→single+error, triple+error↔homerun, …) — both the initial call and the final ruling — in the replay feed (reviews.html), as a dedicated ✏️ Scoring Changes tab AND in the All feed.

## User Requirement (Verbatim)

> Add tracking of plays whose official-scoring ruling CHANGES after the initial call — examples: error↔hit, single↔double, double→single(+error), triple+error↔homerun, etc. Track BOTH the initial call and the final ruling (what the official scorer changed it to). Lives in the existing "replay feed all games" (reviews.html). Must be a separate tab in the feed AND also show up in the All feed.

Standing constraints: **no manual input** (everything is detected automatically from API scans), **no hallucinations** (verified line-by-line against live StatsAPI payloads / official registries), **irregularities flagged for review** (same pattern as the challenge-counter regression flags).

## How detection works (no hallucination basis)

- The StatsAPI playByPlay payload stores ONLY the final ruling — there is **no scorer-change flag** anywhere in the API (verified live 2026-09-04 against games 823337, 822853, 823095, 824388, 824796, 824144, 822766, 822769; and against the MLB.com scoring-changes log entries #230 and #232). Detection is therefore **poll-diff**: the tracker snapshots every completed play's official classification on each scan and diffs it against what previous polls observed. The initial call comes from our own earlier snapshot — never invented.
- Classification is diffed **by registry event type, not text**: `result.eventType` is classified with the live-verified registry (https://statsapi.mlb.com/api/v1/eventTypes, 75 codes):
  - hits = `single`, `double`, `triple`, `home_run` only;
  - plate-appearance errors = `field_error`; base-running errors = `error`;
  - pending = `os_ruling_pending_primary` / `os_ruling_pending_prior` (never baselined — the first real classification is the baseline).
- Runner-level error advances (`runners[].details.eventType === 'error'` on a non-error PA, e.g. change #232 "fielder's choice + error") participate in the diff through `runners[].movement` (`originBase → end / outBase / isOut`), which requires the `movement` parent key in the `fields` projection (gotcha verified twice live).
- A classification diff mints/updates a permanent row; annotation-only edits (description wording, `result.rbi`, score-after without reclassification) and plays vanishing from the payload are **irregularities** — flagged to the on-page "Scoring irregularities" list and `console.warn`, deduped per game (cap 30).

## Row anatomy

Each row (key `<gamePk>:scoring-<atBatIndex>`, one row per play however many rulings):

- Headline: `Initial call → Final ruling` (e.g. `Double → Field Error`) with category-classed chips (hit / error / out / other) and a per-key tooltip explaining the mechanism.
- `N rulings observed` badge when a play changed more than once (also flagged), plus the intermediate headline (`previousHeadline`) and a full observed chain in row history.
- **Initial call** line with the observed time (our snapshot), **Final ruling** line, official **score after** (printed only when the payload carried it — never invented), mechanism line, and the batter/pitcher footer + official matchup label.
- Attribution: `scorer` (default), `pending_ruling` (resolved `os_ruling_pending_*` marker on the play), or `replay_review` — review-attributed rows are surfaced ONLY when no replay-review feed row exists for that exact at-bat (otherwise the change is the review's outcome and lives on that row, no double-count).

## Scan windows

- Live games: every poll (default cadence).
- Final games: MLB's own scoring-changes log states changes can be made "following the conclusion of the listed games" (by the Official Scorer, Elias Sports Bureau, or after a club-initiated review — https://www.mlb.com/official-information/scoring-changes). A Final is therefore re-scanned **once per 30 s within a 30-minute grace window** from the first observed Final (`finalScanDecision`), then settled for good — bounded, never unbounded.

## Where the code lives

- `assets/js/reviews-feed.js` — pure helpers (`buildScoringSnapshot`, `scoringSnapshotSignature`, `scoringChangeSummary`, `scoringEventLabel`, `scoringMechanism`, `mergeScoringChanges`, `finalScanDecision`, `runsRemovableFromReview`, `visibleInAllFeed`, `shouldAlertForReview`) + IIFE wiring (`scoringContextFor`, `admitScoringEntries`, `ingestGame` gate, `mergeFeedEvents` cleanup protecting `scoring_change` rows, rendering via `scoringChangeBlock` in `feedRow`, stats/tabs/filter/empty-state, scoring-irregularities list).
- `assets/js/api.js` — `PBP_FIELDS` carries every scoring-read field (pinned by `tools/api-fields-test.mjs`, including `originBase`, `isOut`, `rbi`, `end`).
- `assets/js/reviews.js` — unchanged; supplies pending-scoring rows and `extractReviews`.
- `reviews.html` — footer documents the method; sound-toggle title covers the scoring chime.
- `style.css` — chips/outcome/stat/tab/irregularity styles.

## Tests (all deterministic, live-verbatim fixtures)

- `tools/scoring-change-test.mjs` — 13 sections: registry classification, baseline rules (pending/blank never baselined), single/double/multi-ruling chains with history, hit↔error/out/FC matrices, attribution (review-covered skip vs orphan review surface vs other-index non-capture vs pending_ruling), irregularities (RBI/score-after/description-only/vanished play) with dedupe, empty-payload blip, `mergeFeedEvents` cleanup protection, alert/All-feed visibility predicates, `finalScanDecision` truth table, malformed-input degradation.
- `tools/replay-feed-render-test.mjs` §9 — end-to-end through the real boot path: baseline poll mints no row; the rescored poll renders the row in All with every line item; stats (`Scoring Changes 1`, `Events 3`), tabs (`✏️ Scoring Changes (1)`, `All (3)`), filter isolation (Under Review stays replay-only), idempotent re-poll. This section caught the `scoring.entries` no-op wiring defect the unit tests could not see.
- `tools/api-fields-test.mjs` — projection completeness for the third consumer.
- `tools/official-scoring-test.mjs`, `tools/reviews-feed-test.mjs`, `tools/review-*.mjs` — regression (all green).

## Irregularity policy

Anything that does not fit the verified vocabulary is flagged, never guessed: description-only rewrites, RBI changes, score-after corrections without reclassification, plays disappearing from the payload, multiple rulings on one play. An empty play list is treated as a payload blip (state preserved). Every flag is visible on-page (⚠️ list at the bottom of the feed) and in `console.warn` for review.

## Feed log — every tracked entry survives a refresh or a later visit

**Date:** 2026-09-05
**Status:** ✅ Fully Implemented and Tested
**Requirement:** Keep detection exactly as-is, but log every entry so a refresh or a fresh visit shows everything tracked.

**Problem it fixes:** all tracker state (`feedState`, `scoringSnapshots`, `scoringIrregularities`, `scoringGraceFinals`, `settledGames`) lived in memory only, so a refresh wiped every feed row *and* the baselines the next poll-diff needed — tracked entries, including scoring changes, were silently lost.

**How it works (detection untouched):** after any poll that adds, updates, ends, or flags an entry (or advances a Final's grace window), the page writes its whole observed state to `localStorage` under `mlbReplayFeedLog.v1.<YYYY-MM-DD>`; on boot and on date change it restores that log *before* the first scan and paints it immediately, so the first poll diffs against the previously observed baselines. Restored rows merge idempotently by stable key (`<gamePk>:<id>`); a change that landed while the page was closed still diffs honestly against what was last observed. Writes are throttled (≤1/s) plus flushed on tab-hide/`pagehide`.

**What is stored:** feed rows of every `typeKey` (reviews, ABS, pending-scoring, scoring-change) with `firstSeen`/`lastSeen`/`matchupLabel`; per-game scoring baselines (`snapshot`, `signature`, `firstObservedAt`, `lastObservedAt`, `history`, `rowCreated`); per-game irregularity notes; post-Final grace windows + settled finals (a revisit *continues* the bounded grace instead of restarting it). Every stored field is produced by `mergeFeedEvents` / `mergeScoringChanges` from official playByPlay fields — nothing invented for storage. Deliberately **not** stored: challenge counters (re-fetched live; a stale "now" value must never be shown) and run-risk alert keys (a revisit behaves exactly like a first visit).

**Bounds:** 500 most-recent rows, 400 baselines/game, 30 notes/game, 7 date-logs (the viewed date always kept); trims are counted in the payload (`trimmed`), malformed stored records are dropped with a `console.warn` — flagged, never hidden. No `localStorage` (private mode, tests) degrades to the old in-memory behavior.

**Tests:** `tools/feed-log-persistence-test.mjs` — 7 sections: key/date validation; serialize caps with trim counts; round-trip through the real merge helpers (no phantom row after refresh; a post-refresh ruling updates with the *original* initial call and the multi-ruling flag); idempotent re-admit + cleanup protection; malformed-log handling (version/date mismatch, 10+ malformed records dropped and counted); index pruning; and a full refresh simulation through the real boot path (baseline → rescore → flush → fresh VM, row painted before the first scan settles, no duplicate after it, tabs intact).

## Verification limits (flagged for review)

- **No live re-verification was possible in this session:** the sandbox has no external network (`curl https://statsapi.mlb.com/api/v1/eventTypes` → exit 35; `fetch` fails), so the registry/payload shapes above could not be re-fetched. All checks rest on the repo's live-verbatim fixtures (eventTypes + playByPlay captures of 2026-09-04, scoring log entries #230/#232) and the deterministic suites, which are all green (11/11). If the upstream registry or the scoring-changes log vocabulary drifts, the nightly API smoke test (`docs/workflows/smoke.yml`) is the tripwire — treat any smoke failure as an irregularity for review before trusting new rows.
