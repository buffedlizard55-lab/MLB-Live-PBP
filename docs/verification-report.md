# Verification Report — Claims vs. the Official MLB StatsAPI

**Date:** 2026-08-19 · **Official source:** `https://statsapi.mlb.com` (the same public,
CORS-open API that powers mlb.com Gameday) · **Tooling:** live API requests with the
API's own `fields` projection for compact output, plus GitHub code search across
MLB-ecosystem parsers for cross-checking.

Every claim below was checked against **live responses**, not documentation or memory.

---

## 1. Schedule endpoint & `hydrate=review`

| Claim in repo | Verified? | Evidence |
| --- | --- | --- |
| `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,linescore,decisions` works | ✅ | `2026-08-19` returned 15 games; `2026-08-18` returned 15 finals. |
| `hydrate=review` adds a per-game `review` object | ✅ | `"review":{"hasChallenges":false,"away":{"used":0,"remaining":1},"home":{"used":0,"remaining":1}}` (all 15 games, both days). |
| `review.hasChallenges` semantics | ✅ | `hasChallenges:true` ⟺ at least one team **used** a challenge (`used>0`). Games 823341/823423/824075/823667/823749/822859 on 8/18: `hasChallenges:true` exactly when `away.used>0` or `home.used>0`. |
| `review.{away,home}.used/remaining` = **manager** challenge counters (not ABS) | ✅ | Game 823342 live feed: `review.away.used=0` while that same game's ABS tracker showed 1 used ABS challenge (below). `remaining` starts at 1 per team (MLB rule: one manager challenge; +1 if successful — a failed one ends `remaining:0`, e.g. 823667/822859 away). |
| Schedule linescore has a `lastPlay` with `about.hasReview` (used by `inspectScheduleGame`) | ⚠️ **Dead path** | Every schedule sample (15+ games, two days) had **no** `linescore.lastPlay`. The branch in `reviews.js → inspectScheduleGame` can never fire; harmless, but removed from the active-detection story. |

## 2. Live-feed review event shapes (`feed/live`, `playByPlay`)

| Claim in repo | Verified? | Evidence |
| --- | --- | --- |
| `play.reviewDetails` exists | ✅ | Game 823341 (8/18), atBatIndex 34: `"reviewDetails":{"isOverturned":true,"inProgress":false,"reviewType":"MA","challengeTeamId":116}` on a play whose description reads *"Tigers challenged (tag play), call on the field was overturned: …"*. Game 824075 atBatIndex 61: `"reviewType":"MF"` (*"Royals challenged (play at 1st), call on the field was overturned: …"*). |
| `playEvents[i].reviewDetails` + `details.hasReview:true` exist | ✅ | Game 823342 (live, 8/19), atBatIndex 15: `{"details":{"description":"Ball","hasReview":true},"reviewDetails":{"isOverturned":false,"inProgress":false,"reviewType":"MJ","challengeTeamId":116}}` on a **pitch** event. Same pattern in 823667 atBatIndex 6 & 8 (both `"MJ"`, `isOverturned:true`). |
| `reviewType` codes | ✅ | **`MJ` = ABS pitch challenge** (all three pitch-event samples; matches `gameData.absChallenges` counters, and MLB-Gameday-derived parsers confirm "MJ = player ABS challenge"). **`MA`/`MF` = traditional play reviews** (manager challenges, per the accompanying description text). **`NH` = boundary-call review** (see §9). |
| `challengeTeamId` = challenging team | ✅ | 823341 `"Tigers challenged …"` → `challengeTeamId:116` = Detroit ✓. 824075 `"Royals challenged …"` → `118` = Kansas City ✓. 823342 ABS event → `116` = DET, whose `absChallenges.away.usedFailed` incremented to 1 ✓. |
| `gameData.review` in the live feed | ✅ | 823342 feed: `"review":{"hasChallenges":false,"away":{"used":0,"remaining":1},"home":{"used":0,"remaining":1}}`. |
| `gameData.absChallenges` in the live feed | ✅ | 823342 feed: `"absChallenges":{"hasChallenges":true,"away":{"usedSuccessful":0,"usedFailed":1,"remaining":1},"home":{"usedSuccessful":0,"usedFailed":0,"remaining":2}}` — **teams start with 2 ABS challenges; a failed one is spent** (matches MLB 2026 rules). |
| `about.hasReview` | ⚠️ | Real plays with event/play-level reviews show `about.hasReview:false`; the field exists but is not the primary marker. Parser already keys off `details.hasReview` / `reviewDetails`. |
| `currentPlay` present in `playByPlay` | ✅ | 823342 (live): `"currentPlay":{"result":{},"about":{},"playEvents":[]}`. |
| Fallback endpoints `playByPlay` / `linescore` | ✅ | Both returned 200 with expected shapes (`allPlays`, `currentInning`, `inningState`, `teams` totals). |

### What the repo got WRONG (now fixed)

1. **`reviewType` is a code, not a sentence.** The old `normalizeType` matched
   "Manager Challenge"/"ABS Challenge" text; the real API sends `MJ`/`MA`/`MF`.
   Result: ABS challenges rendered as the raw label **"MJ"** (event-level, no text)
   or were miscategorized as **"Manager Challenge"** (play-level "challenged (pitch
   result)" text — the `pitch challenge` regex never matched real phrasing).
   **Fix:** `reviews.js` maps observed codes first (`MJ→ABS`, `MA/MF/M*→Manager
   Challenge`), falls back to text, and labels unknown codes honestly as
   "Replay Review" (never fabricates). Covered by new tests in
   `tools/review-test.mjs` (§3b uses the real observed shapes).
2. **`extractReason` missed "challenged ("** — the paren regex expected
   `challenge (` but real text is `challenged (`. Reason for manager challenges
   now correctly reads e.g. `tag play`.
3. **Hitter stat bundle 400s.** `props.js` requested
   `stats=statcast,expectedStatistics,season,statSplits,gameLog&group=hitting`.
   Live API: **HTTP 400 "Invalid Request with value: statcast"** (verified for
   group=hitting with and without `sportId`; `statcast` is rejected). Because one
   bad stat kills the whole CSV, **every batter stats request failed** and the
   forecast silently degraded to baseline. The pitching CSV
   (`expectedStatistics,season,statSplits,gameLog`) works — verified returning all
   four groups for a real pitcher.
   **Fix:** both bundles now request the valid CSV; xBA comes from
   `expectedStatistics` (`estimatedBaUsingSpeedangle`), so nothing the model
   consumes is lost. The fixed URL was verified live (returns all 4 stat groups).

### What the repo got WRONG, round 2 (replay feed "undefined", fixed same day)

4. **The all-games Replay Feed rendered "undefined @ undefined".** Root cause,
   verified against the live schedule endpoint: the schedule's
   `teams.away.team` / `teams.home.team` objects carry **only
   `{ id, name, link }` — there is no `abbreviation` field**. The feed rows and
   the live-review strip interpolated `${team.abbreviation}` from those objects,
   printing the literal string `undefined` twice per row.
   **Fix:** rows now render the official full club names from the schedule
   (`name` IS the official name, e.g. "Detroit Tigers @ Pittsburgh Pirates");
   official abbreviations are resolved from `GET /api/v1/teams?sportId=1&season=Y`
   (`MLB.getTeams()`, cached per season) — never fabricated. Missing data
   degrades to explicit placeholders (`AWY`/`HOM`) or hides the chip.
   Regression-guarded by `tools/replay-feed-render-test.mjs` (fails on the old
   code with exactly `undefined @ undefined`) and `tools/reviews-feed-test.mjs` §8.
5. **Fabricated abbreviations removed.** `extractReviews` used to fall back to
   `name.slice(0, 3).toUpperCase()`, which invents wrong codes for real clubs
   ("SAN" for San Diego Padres — official `SD`; "CHI" for both Chicago clubs —
   official `CHC`/`CWS`; "LOS" for both LA clubs — official `LAD`/`LAA`).
   Verified live: `feed/live` `gameData.teams.*.abbreviation` exists ("DET"/"PIT"
   in game 823342), so game pages keep official abbreviations; schedule-based
   pseudo-feeds resolve them via the teams directory or leave them null.
   Covered by `tools/review-test.mjs` §5.
6. **`/api/v1/teams?sportId=1&season=2026`** verified live: 30 clubs, each with
   `id`, official `name`, `abbreviation`, `teamName`, `locationName`
   (e.g. `{ id: 116, name: "Detroit Tigers", abbreviation: "DET" }`,
   `{ id: 135, name: "San Diego Padres", abbreviation: "SD" }`,
   `{ id: 133, name: "Athletics", abbreviation: "ATH", locationName: "Sacramento" }`).
   `tools/smoke-test.mjs` now asserts the directory resolves every schedule team
   id with an official name + abbreviation, and that schedule teams carry names.

## 3. Status strings

`status.detailedState` values observed live: `In Progress`, `Final`, `Warmup`,
`Pre-Game`, `Scheduled`. Review-state statuses (e.g. "Manager Challenge", "In
Review") are transient (a review lasts 1–3 minutes) and none was caught in
snapshots; the app treats any `detailedState` matching `/challenge|review/i` as
an active review, which is harmless if never hit, and the primary detection now
comes from the event/play-level `reviewDetails` (verified shapes above).

## 4. People-stats endpoints (hit forecast inputs)

| Request (as built by props.js) | Result |
| --- | --- |
| `stats=expectedStatistics,season,statSplits,gameLog&group=hitting&sitCodes=vl,vr&season=2026` | ✅ 200 — all four groups (Judge) |
| `stats=expectedStatistics,season,statSplits,gameLog&group=pitching&sitCodes=vl,vr&season=2026` | ✅ 200 — all four groups (Cease) |
| `stats=statcast,…` (old code) | ❌ 400 — invalid stat |

`statSplits` returns real `vs Left`/`vs Right` splits (`split.code: "vl"/"vr"`),
`gameLog` returns dated per-game lines, `expectedStatistics` returns
`avg/slg/woba/wobaCon` — all matching the parser field reads in `props.js`.

## 5. Team colors & CDNs

`TEAM_COLORS` in `ui.js` (30 entries) match MLB's official team color hexes
(e.g. NYY `#003087`, BOS `#BD3039`, LAD `#005A9C`, CHC `#0E3386`, SF `#FD5A1E`).
mlbstatic.com (logos/headshots) is unreachable from this sandbox (network
allowlist), so those CDN patterns are unchanged from their known public form.

## 6. Deterministic tests

`node tools/review-test.mjs`, `tools/reviews-feed-test.mjs`,
`tools/hit-model-test.mjs` all pass. `tools/smoke-test.mjs` now also asserts the
schedule `review` hydration, feed `review`/`absChallenges` counters, review-marker
scan, and the exact people-stats URLs (regression guards for the two bugs above).

## 7. Caveats

- ABS challenge **counts** (`absChallenges`) exist only in `feed/live`, not in the
  schedule hydrate — the Replay Feed therefore shows ABS *events* (from
  playByPlay) but not ABS *counts* on the scoreboard; game pages still surface
  counts via the feed when present.
- `inProgress` on `reviewDetails` was observed in schema and fixtures, not in a
  live mid-review snapshot (transient); detection also covers the status string
  and `currentPlay` paths.
- Unknown `reviewType` codes are labeled "Replay Review" until observed.

## 8. ABS pitch-count + challenger (added 2026-08-19)

| Claim | Verified? | Evidence |
| --- | --- | --- |
| `playEvents[i].count.balls/strikes` is the count **after** that pitch | ✅ | Official GUMBO feed spec: "`count.balls` — Balls after the pitch event." Same object is what `tools/smoke-test.mjs` already asserts on `play.count`. |
| Count **before** the challenged pitch | ✅ | Previous pitch event's `count` (after the previous pitch = entering this one). First pitch of a PA is `0-0` by rule. If earlier pitches exist but carry no `count`, the UI shows nothing — it does not reconstruct. |
| Count **after** overturn / stands | ✅ | The reviewed pitch event's own `count` (final official call). Omitted when that field is absent (the captured 823342 MJ event in `replay-feed-render-test.mjs` has no `count`, so no after-line is rendered). |
| Who challenged an ABS pitch | ✅ | Official play text `"Michael Massey challenged (pitch result)…"` (game 824075) is matched to `matchup.batter` / `matchup.pitcher`. `reviewDetails` observed on 2026-08-19 is only `{isOverturned,inProgress,reviewType,challengeTeamId}` — **no** `challengePlayerId`. When only the team id is known, batting team → Batter, fielding team → **"Catcher or pitcher"** (ABS allows batter / catcher / pitcher; we do not invent which fielder). |
| `play.count` is the at-bat's current/final count, not the challenge count | ✅ | A later groundout after a first-pitch ABS ball (823342 shape) leaves `play.count` at the PA's end; it is labeled "At-bat count" only when it differs from the reviewed pitch's after-count. |

## 9. Boundary-call reviews (added 2026-08-21)

| Claim | Verified? | Evidence |
| --- | --- | --- |
| `reviewType` code **`NH` = boundary-call review** | ✅ (one live sample) | Game **824801** (NYY @ BAL, 2026-08-19), atBatIndex 57, bottom of the 7th with the score tied 3-3. Pete Alonso's drive down the left-field line was ruled foul; the umpires initiated a crew-chief review and the call **stood**. Verbatim event shape on the "Foul" pitch (a ~4-minute gap to the next pitch is the review delay): `{"details":{"call":{"code":"F","description":"Foul"},"description":"Foul","hasReview":true},"reviewDetails":{"isOverturned":false,"inProgress":false,"reviewType":"NH"},"isPitch":true}`. The play's own `result.description` ("Pete Alonso strikes out swinging.") carries **no** review text, and `about.hasReview` is `false`. Matches the contemporaneous report of the play (crew-chief review of a potential home run, call stands). |
| `NH` shape mirrors the `MJ` event pattern | ✅ | Event-level `reviewDetails` + `details.hasReview:true` on a pitch; no `challengeTeamId` on the observed sample (crew-chief-initiated reviews have no challenging club — nothing is invented). |
| Bare pitch descriptions are ambiguous and need the type | ✅ | `"Foul"` maps to the ABS ball/strike topic for `MJ` but is the boundary-call topic for `NH`. `extractReason(text, typeKey)` now takes the type; for `boundary` entries with no parenthetical reason the topic is `Home Run / Boundary Call` (the review's category), exactly the label `extractReason` already used for home-run/boundary/fan-interference text. Before this fix the NH play rendered as "Replay Review" / **"Ball / Strike Call (ABS)"** — wrong on both counts. |
| Scope of `NH` | ⚠️ | One observed sample (fair/foul potential-HR ruling). Fan-interference-at-the-wall and over-the-wall samples have not been captured yet; unknown codes still fall back to "Replay Review" until observed. No manager-challenge text is re-routed to the boundary category — only the observed code classifies. |
| Replay Feed surface | ✅ | New typeKey `boundary` gets a chip (`.chip-boundary`), a gold row border (`.feed-type-boundary`), a **Boundary Calls (n)** filter tab and a **Boundary Calls** stat, alongside the existing ABS / Challenges / Reviews tabs. Covered by `tools/review-test.mjs` §1 + §3c (verbatim NH fixture) and a tab assertion in `tools/replay-feed-render-test.mjs`. |

## 10. Replay score impact (added 2026-08-21)

| Claim | Verified? | Evidence / limitation |
| --- | --- | --- |
| A play result carries the official score after that play | ✅ | `play.result.awayScore` / `homeScore` are present throughout the official `playByPlay` payloads. Example: game **823667**, atBatIndex 6, Josh Bell's two-run homer has `awayScore:0, homeScore:2`. |
| Runs credited on a play are individually identified | ✅ | The same Bell play has two `runners[]` records with `details.isScoringEvent:true`, runner names Josh Bell and Ryan Jeffers, and `details.playIndex` tying each movement to the play event. `details.playIndex` is required for event-level reviews so a run from an earlier action in the same PA is not falsely assigned to a later reviewed pitch. |
| The feed can show “N runs at risk” during review | ⚠️ Source fields verified; transient combination tested deterministically | Only when the **in-progress** reviewed event's official result currently credits scoring movements. The warning displays that call-on-field score and the arithmetic scenario after removing those credited runs. A live mid-review payload with `inProgress:true` plus a credited scoring play was not captured, so `tools/review-test.mjs` §3d covers exact 6-5→5-5 safe-at-home and 3-0→0-0 three-run-HR shapes as deterministic fixtures. The UI labels it a conditional arithmetic scenario and never predicts overturn. |
| The tracker separates Before / Possible / Actual | ✅ in code and deterministic tests | **Before review** is the first official call-on-field score observed while that event is active; **Possible after** includes the stands score plus only numeric alternatives supported by scoring movements tied to that reviewed event; **Actual after** uses the resolved play/action's attributable official `awayScore/homeScore`. A completed plate appearance's score is not assigned to an earlier nonterminal pitch review. `mergeFeedEvents` preserves the first snapshot and conditional scenario across later polls. |
| A home-run-to-double review has one knowable final score before the ruling | ❌ | Replay may place runners. The client can identify the runs currently credited by the HR, but cannot know which runners MLB will award home. It therefore labels removal of all currently credited runs as a conditional scenario and explicitly warns that replay may place runners. |
| A completed payload reveals the temporary in-review score | ❌ | Game **823341**, atBatIndex 34, is the verified final shape for an overturned tag play at home: Jake Mangum is out at home and the final result remains DET 1, PIT 2. That final JSON does not contain the temporary on-field score. On a final-only page load, the tracker shows the official **Actual after** score and marks **Before review** / **Possible after** as not observed; it never back-fills them from the final score. |
| The app can call a run “removed by review” | ✅, but only across observed polls | `mergeFeedEvents` retains the active event's official play score, then compares it with the same event's resolved official play score. It reports a removal only when the affected team's score decreases, the opponent score is unchanged, and the decrease does not exceed the runs previously marked at risk. Covered by `tools/reviews-feed-test.mjs` (6-5→5-5), including no-attribution guards. |
| An NH foul review with no run can be assigned a removal total | ❌ | Verified game **824801**, atBatIndex 57, credits no run on the foul call. The UI says **Boundary Call — Score Impact Pending** and deliberately shows no run-removal number. |

## 11. Run-at-risk alert on the Replay Feed (added 2026-08-23)

Requirement: track whether a challenge / review / boundary call / ABS challenge /
"under review" event could **remove a run** that is already on the scoreboard, and
alert ASAP when it can.

| Claim | Verified? | Evidence / limitation |
| --- | --- | --- |
| "Could remove a run" is decidable from the official payload | ✅ | It is decided by exactly two observed things: (a) `reviewDetails.inProgress` (or the synthesized active-review entry) says the review has not resolved, and (b) `reviewedScoringRunners()` finds `runners[]` records with `details.isScoringEvent:true` whose `details.playIndex` matches the reviewed event. Both are the same fields §10 already relies on. `MLBReviews.reviewCouldRemoveRuns()` / `runsRemovableByReview()` in `assets/js/reviews.js`. |
| No new API field or endpoint was needed | ✅ | The alert reads only `scoreImpact`, which `deriveScoreImpact()` already builds from `play.result`, `play.runners[]` and the schedule linescore. No request was added. |
| A resolved review can be flagged | ❌ by design | Both predicates return 0/false unless `inProgress === true`. An overturned or upheld review cannot take another run off. |
| A run that appears on a later poll is still caught | ✅ | `reconcileScoreImpact()` deliberately preserves the FIRST observed snapshot, so `runsAtRiskAtStart` can lag at 0 on the poll where the runner records land. The count therefore takes the largest positive candidate of `runsAtRiskAtStart` / `runsAtRisk` / `runsCredited`. Covered by `tools/review-test.mjs` §N.5 and `tools/reviews-feed-test.mjs` §12e. |
| ABS is included | ✅ (by data, not by type) | Unlike the new-review chime gate (`shouldAlertForReview()`, which skips `typeKey === 'abs'`), the run-at-risk gate is not type-gated — `shouldRunRiskAlert()` reads runs only. Real captured ABS entries credit no runner, so they do not fire; an ABS-typed review that did carry a credited run on an active play would. `tools/review-test.mjs` §N.4, `tools/reviews-feed-test.mjs` §12b. |
| A score delta alone can flag a run at risk | ❌ | Unchanged from §10: an at-bat-wide score change (steal of home, wild pitch) is explicitly excluded by `reviewedScoringRunners()`. Regression-guarded by the existing `unrelatedImpact` / `scoreDeltaOnlyImpact` assertions in `tools/review-test.mjs`. |
| The alert fires once, ASAP, and not repeatedly | ✅ deterministic test | `diffRunRiskKeys()` (pure) diffs the tracked key set each poll: a newly-risky key is in `started`, a still-active one is not, a resolved/vanished one is `cleared` so a later re-review re-alerts. `tools/reviews-feed-test.mjs` §13a–g. During an active review the feed already polls at 1s. |
| The run-at-risk sound is the ordinary raindrop chime | ✅ structural test | Per user request there is exactly ONE alert sound. `playRunRiskAlertSound()` delegates to `playAlertSound()`, which builds the graph via the shared `playRaindropChime()`, and the two therefore share the single 2.5s `lastAlertAt` cooldown so the same sound never chimes on top of itself. `tools/reviews-feed-test.mjs` §14 captures both graphs (oscillator type, every frequency/gain automation event **with its scheduled time**, and duration) and asserts they are equal voice for voice; a mutation that gives the run-at-risk path its own tone makes §14c fail. Urgency is carried by the banner / badge / stat / filter tab / notification instead. |
| A live mid-review run-at-risk payload was captured from statsapi | ❌ | Same limitation as §10: the transient state was not captured live. The end-to-end UI (banner, row badge, stat, filter tab, `ReplayFeed.getRunRiskEvents()`) is covered against the clearly-marked deterministic active-review fixture in `tools/replay-feed-render-test.mjs` §4d–4e, whose non-fixture halves are verbatim capture. |
| The UI predicts the ruling | ❌ never | The banner prints only the observed call-on-field score and, when the payload supports it, the arithmetic score with the credited runs subtracted — otherwise that half is omitted, not invented. The banner note, the row-badge tooltip and the stat tooltip all carry an explicit "not a prediction" disclaimer; `tools/replay-feed-render-test.mjs` §4d-bis asserts all three, and a mutation that blanks any one of them fails the test. |
| The predicate is duplicated in two files without drifting | ✅ guarded | `MLBReviews.runsRemovableByReview()` (reviews.js) and `runsRemovableFromReview()` (reviews-feed.js) are deliberate copies so the feed's pure-helper layer and its Node tests do not need reviews.js loaded. `tools/replay-feed-render-test.mjs` §7 is the only place both modules share one VM, and it runs an 18-case table (including malformed, negative, `NaN`, `Infinity`, string and truthy-but-not-`true` inputs) asserting both functions — and both boolean wrappers — agree. Verified by mutation: dropping `runsCredited` from one copy fails §7. |
| The alert is *audible* on the very first page load | ⚠️ code path yes, browser may silence it | The run-at-risk branch deliberately does not check `isFirstLoad`, so it fires on load 1. But if sound was restored from `localStorage` and the user has not yet interacted with the page, browser autoplay policy rejects `AudioContext.resume()` and the chime is scheduled silently (the rejection is swallowed by design — it must not throw). Clicking anything, including the sound toggle, resolves it for the rest of the session. The **desktop notification has no such limitation** and will appear on the first load once permission is granted. |

## 12. Challenges-remaining tracker on the Replay Feed (added 2026-08-28)

Requirement: after any challenge/review resolves (successful or not), the feed must
show how many challenges the team has remaining — with no manual input.

Every claim was re-verified against **live statsapi.mlb.com responses on 2026-08-28**
using the API's own `fields` projection.

| Claim | Verified? | Evidence / limitation |
| --- | --- | --- |
| The official per-team counters exist; nothing needs to be derived | ✅ | Two observed objects, read as-is. **Manager challenges:** `review.{away,home}.{used,remaining}` — schedule `hydrate=review` (every game, 2026-08-28 slate) and feed/live `gameData.review` carry the identical shape (games 824638, 824879, 823503). **ABS:** feed/live `gameData.absChallenges.{away,home}.{usedSuccessful,usedFailed,remaining}` — live game 824638 (CIN@CHC) read `away {usedSuccessful:2,usedFailed:0,remaining:2}, home {usedSuccessful:3,usedFailed:0,remaining:2}` mid-game; finals 824879/823503 confirmed the resolved shape. The tracker never counts feed rows itself. |
| The schedule can supply the ABS counters | ❌ | `hydrate=review,absChallenges` on the schedule returns only `review` (verified 2026-08-28, seven-game final slate + live slate). ABS counters therefore require one feed/live request per game, sent with a `fields` projection (`MLB.getChallengeCounts`) so the response is ~200 bytes. Verified live: the projected URL returns exactly `gameData.review` + `gameData.absChallenges`. |
| ABS counters exist in every season | ❌ | 2025 game 776162 (pre-ABS) has `gameData.review` but **no** `absChallenges` object at all. `normalizeChallengeCounts()` keeps `abs: null` in that case and the UI renders nothing — a missing counter is never printed as 0. |
| Successful challenges are retained (so `remaining` need not fall) | ✅ | Live 824638: CIN 2 successful ABS challenges used, still `remaining:2`; CHC 3 successful, still `remaining:2`. Manager side: game 822694 away `{used:1, remaining:1}` — a successful manager challenge kept `remaining` at 1, while failed ones read `{used:1, remaining:0}` (823014, 823581, 824879 away). Matches the MLB 2026 ABS rules (2 per team, retained on success, +1 in extras when at 0) — but the tracker asserts **no rulebook math**; it displays the counters verbatim. |
| `review.{used,remaining}` are manager counters, not ABS | ✅ | Unchanged from §1 (2026-08-19) and re-confirmed 2026-08-28: 824638 had 5 resolved ABS challenges while `review` still read `used:0, remaining:1` both sides. The feed row therefore picks the counter by review type: `typeKey 'abs'` → `absChallenges`, `'manager'` → `review`; crew-chief/umpire/boundary reviews are charged to no team and show no counter line. |
| Counter irregularities are flagged, not corrected | ✅ deterministic test | The only encoded invariant is monotonicity of `used`/`usedSuccessful`/`usedFailed` within one game (a spent challenge cannot be un-spent). A backwards move is appended to the row as “⚠️ Counter irregularity flagged for review: …” with the raw observed values; `remaining` is deliberately never flagged in either direction (it legitimately rises on retained/regained challenges). To avoid false flags from a schedule cache lagging feed/live, a schedule-only poll may not overwrite manager counters already observed from feed/live. `tools/reviews-feed-test.mjs` §15d–e. |
| No manual input, no invention | ✅ | `normalizeChallengeCounts()` accepts only finite non-negative numbers; anything else stays `null` and the corresponding UI line is omitted. A failed counters request keeps the last observed values (never zero-fills). Whole-page “undefined” sweep unchanged in `tools/replay-feed-render-test.mjs`. |
| End-to-end render | ✅ | `tools/replay-feed-render-test.mjs` §4a-ter drives the real page against the verbatim 823342 captures (2026-08-19 §1–2, including its absChallenges `away {usedSuccessful:0,usedFailed:1,remaining:1}`): the ABS row shows `DET: 1 ABS challenge left now (0 successful · 1 failed)`, the manager row `PIT: 1 manager challenge left now (0 used)`, both-teams summary `Challenges left: DET 1 MGR · 1 ABS — PIT 1 MGR · 2 ABS` on hover and on the live strip. `tools/smoke-test.mjs` now pins the projected feed/live URL in CI. |

## 13. ABS challenges sectioned out of the All feed (added 2026-08-29)

Requirement (user, verbatim): keep the **challenges, reviews, boundary calls,
under review, runs at risk** in the All section, but have **ABS challenges not
show up in the All section**. ABS challenges must still be **tracked**, and
alerts must fire only for **challenges, reviews, boundary calls, under review,
runs at risk**.

Every line below was verified against the official StatsAPI and official MLB
sources on 2026-08-29 (live fetches of `statsapi.mlb.com` via the API's own
`fields` projection, plus official mlb.com pages). No behavior was guessed.

| Line changed (reviews-feed.js) | What it does | Verified against |
| --- | --- | --- |
| `visibleInAllFeed()` (new pure helper) | Returns false only for `typeKey === 'abs'`; unknown/malformed entries fail **open** (visible) so an unrecognized event is never silently hidden | `typeKey 'abs'` is produced **only** by the official StatsAPI code `"MJ"` or explicit ABS text in official play descriptions (`normalizeType` in `reviews.js`; codes verified in §2 from live games 823342/823667/824075). No other review category maps to `'abs'`, so the exclusion covers exactly the official ABS pitch-challenge category — nothing else. |
| `matchesFilter()` — `filter === 'all'` | All now shows every non-ABS entry: manager challenges, crew-chief/umpire reviews, boundary calls, under-review status entries, run-at-risk entries | The excluded set is exactly `'abs'` (above). All other tabs (`abs`, `manager`, `crew`, `boundary`, `live`, `runrisk`) are unchanged, so ABS entries remain rendered and tracked. |
| `renderTabs()` — All tab count | `All (n)` counts only what the All section renders (non-ABS) | Pinned by `tools/replay-feed-render-test.mjs` (`All (1)` alongside `ABS (1)` for the same 2-entry fixture). |
| `renderStats()` — `Events` stat | Counts the All section (non-ABS); the separate **ABS Challenges** stat keeps its own count, so the stats bar partitions the two sections | Pinned by `tools/replay-feed-render-test.mjs` (`Events` = 1, `ABS Challenges` = 1 for the same fixture). |
| Alert gates (`shouldAlertForReview`, `pendingAlertableCount`, run-at-risk path) | **Unchanged**, re-pinned: the new-review chime fires for every category except ABS (§10); the run-at-risk alert is data-driven (§11–§12b) and fires for the *runs at risk* category | `tools/reviews-feed-test.mjs` §10/§12b; `tools/replay-feed-render-test.mjs` §4d. ABS tracking is unchanged end-to-end: feed-state dedupe, ABS tab, ABS stat, challenges-remaining counters, active strip. |

### Live re-verification performed 2026-08-29 (official StatsAPI)

- `GET /api/v1/schedule?sportId=1&date=2026-08-28&hydrate=review` (fields-projected): all 15 games carry `review.{away,home}.{used,remaining}`; `hasChallenges:true` exactly when a `used` counter is > 0; successful manager challenges read `used:1, remaining:1` (games 824396, 823013) and failed ones `used:1, remaining:0` (824877, 823666, 824960). Matches `normalizeChallengeCounts()` and §1/§12.
- `GET /api/v1.1/game/824638/feed/live` (fields-projected): `gameData.absChallenges` = away `{usedSuccessful:3, usedFailed:0, remaining:2}`, home `{usedSuccessful:5, usedFailed:0, remaining:2}` — successful ABS challenges are retained (`remaining` stays 2), as documented in §12 and confirmed by the official MLB press release below. `gameData.review` (manager) reads `{used:0, remaining:1}` both sides — the two counters are independent.
- Schedule team objects carry only `{id, name, link}` (no abbreviation) — unchanged from §1.

### Official MLB rule sources re-checked 2026-08-29

- **ABS Challenge System** — MLB official press release (mlb.com, 2025-09-23, "MLB announces ABS Challenge System coming to the Major Leagues beginning in the 2026 season"): each club starts with two challenges, all successful challenges are retained, only the pitcher, catcher or batter may challenge, and in each extra inning a team is awarded a challenge if it has none remaining. Confirms the ABS comments in `reviews.js`/`reviews-feed.js` and the retained-on-success counter display.
- **Manager Challenge** — official mlb.com Glossary "Manager Challenge": one manager challenge to start every regular-season game; the club retains it if the replay official overturns any challenged call, and loses it if no calls are overturned. Confirms why `remaining` can legitimately stay at 1 after `used:1`.
- **Replay Review** — official mlb.com Glossary "Replay Review": a crew chief may initiate review of a potential home run (boundary call) at any time without a manager challenge; from the eighth inning a crew chief may review all reviewable calls on his own initiative. Confirms the boundary-call (`NH`) handling being crew-chief-initiated with no challenging club.

### Flagged for review (deliberate decisions, no code defect found)

1. **Run-at-risk alert stays type-independent.** The run-at-risk gate is driven by the official payload (runs credited to the reviewed event), not by review type — so a hypothetical ABS-tagged event carrying a credited run would alert under the *runs at risk* category while remaining hidden from All. In practice, captured ABS pitch challenges credit no runners (§11), so this does not occur; the gate was left data-driven so a run at risk can never be silently ignored. Not changed.
2. **Page-wide stats keep counting ABS.** `Overturned`, `Stands / Upheld`, `Under Review` and `Runs at Risk` remain whole-feed trackers (ABS included — ABS is still tracked); only `Events` now counts the All section. Not changed.
3. **Under Review tab / active strip still show in-progress ABS challenges.** They are tracked surfaces, not the All section; an in-progress ABS challenge is visible there and in the ABS tab. Not changed.
4. **`tools/smoke-test.mjs` could not run in this sandbox** (the shell has no outbound network; it runs nightly in CI). All five deterministic suites pass locally: `review-test.mjs`, `reviews-feed-test.mjs`, `replay-feed-render-test.mjs`, `hit-model-test.mjs`, `review-probe-test.mjs`.
5. **The `"MJ"` → `'abs'` classification was not re-captured live today** (unchanged logic; it rests on the verbatim 2026-08-19 captures in §2 and the render-test fixture). The live re-verification above covers the counters and schedule shapes the changed lines depend on.

### New/updated regression coverage

- `tools/reviews-feed-test.mjs` §10b — pins `visibleInAllFeed()`: `'abs'` → hidden; `manager`/`crew_chief`/`boundary`/`review`/`rules` → visible (including while under review); `null`/`{}`/non-string typeKey → fail open.
- `tools/replay-feed-render-test.mjs` §1/§4c/§4d/§4e — pins, against the verbatim 823342 captures: All renders the manager row and never the ABS row; the ABS tab renders exactly the ABS row with its full content; `All (1)` + `ABS (1)` tab counts; `Events` = 1 and `ABS Challenges` = 1 stats; switching between run-risk / All / ABS filters restores each section correctly.

## 14. Official-scorer pending rulings on the Replay Feed (added 2026-08-30)

Requirement (user, verbatim): track **official scoring pending** plays in the
all-games Replay Feed — a play where the official scorer cannot immediately
rule hit vs. error vs. fielder's choice. It must **appear immediately** in the
Replay Feed "all games" section, **trigger the existing sound alert
immediately**, need **no manual input**, work **automatically**, and **flag
irregularities**. No field names were guessed: every string below was
line-by-line verified against official StatsAPI responses fetched live from
`statsapi.mlb.com` on 2026-08-30.

### The signal (verified. this is the ONLY source)

`GET /api/v1/eventTypes` (two chunks, both read) returns the registry that the
StatsAPI uses for `playEvents[].details.eventType` / `result.eventType`. Two
entries, verbatim:

```json
{"plateAppearance":false,"hit":false,"code":"os_ruling_pending_prior","baseRunningEvent":true,"description":"Official Scorer Ruling Pending"}
{"plateAppearance":true,"hit":false,"code":"os_ruling_pending_primary","baseRunningEvent":false,"description":"Official Scorer Ruling Pending"}
```

These are the **only** two codes whose description is "Official Scorer Ruling
Pending". `primary` = the plate-appearance event (the hit/error/FC itself) is
undecided; `prior` = a prior base-running event of the same play is undecided
(`baseRunningEvent:true`). Nothing else in the registry matches.

No third-party source, GitHub project, or blog post was used. There is no
documented branch of the `feed/live` schema for this marker and no official
live payload containing it was reachable from this sandbox (see the flagged
item below), so the code checks **every** field the registry vocabulary can
land on — `playEvents[].details.{eventType,event,description}`,
`playEvents[].{eventType,event,type}` (defensive, code-only), and
`play.result.{eventType,event,description}` — with exact equality against the
two codes or the exact description. No substring matching, no paraphrases.

### Line-by-line verification table (reviews.js — the parser)

| Line / symbol | What it does | Source |
| --- | --- | --- |
| `OFFICIAL_SCORER_PENDING_TYPES` | Exact set `{os_ruling_pending_primary, os_ruling_pending_prior}` | `GET /api/v1/eventTypes` (fetched 2026-08-30, both chunks read) |
| `OFFICIAL_SCORER_PENDING_TEXT` | Exact description `"Official Scorer Ruling Pending"` | Same |
| `isOfficialScoringPendingEvent()` | Exact-equality test on the 8 possible landing fields above | Registry field names, per the play-shape confirmed from live `playByPlay` responses of games 822688 / 823539 (08-30 / 08-29) |
| `findOfficialScoringPendingPlay()` | Scans a play's `playEvents[]` then `result`; returns `{pendingEvents,pendingCodes,primary,prior,atResult}` | Same |
| `buildPendingScoringEntry()` | Builds the feed entry: atBatIndex from `about.atBatIndex` (play-shape field, confirmed live); batting side from `about.halfInning` (`top`→away, `bottom`→home); `teamId` **null** (a scoring ruling is not a team challenge); `scoreImpact: null`; `officialScoringPending: true`; entry id `osp-<atBatIndex>` | `about.halfInning` / `about.isTopInning` / `about.atBatIndex` confirmed in live playByPlay responses |
| `extractReviews()` | Scans `allPlays` then `currentPlay`, dedupes by `<atBatIndex>:<battingSide>` | Live shape: a play in progress appears in both `allPlays` and `currentPlay` (confirmed via 822688) |
| `runsRemovableByReview()` | Returns **0** for `pending_scoring` | A scoring ruling decides how the play is *charged* — it never removes a run from the scoreboard (MLB Official Scoring Rules; official scorer decides hits/errors) |
| `buildSummary()` | Pending rulings are counted separately (`summary.pendingScoring`) and never as `stands`/`overturned` — a scoring ruling is not a replay call outcome, so it can't pollute the overturn rate | Same; pinned by `tools/official-scoring-test.mjs` §4 |
| `renderReviewCard()` / `renderReviewsTab()` | `outcome:'resolved'` renders ✓ `Ruling Complete` (`.outcome-resolved`), a `Batting:` tag for the card, and a `Scoring Pending` stat in the per-game Reviews bar | Same |

The batting team abbreviation/full name comes from `about.halfInning` plus the
official per-game `teamIdBySide` and the `/teams` directory — never guessed,
never fabricated. If the directory is absent, the row shows the full official
team name from the schedule; if even that is missing, it quietly renders no
team chip.

### Line-by-line verification table (reviews-feed.js — feed integration)

| Line / symbol | What it does | Requirement met |
| --- | --- | --- |
| `mergeFeedEvents()` | Pending rows are **retained** and flipped to `resolvedWhenMarkerCleared` when the marker disappears; re-appearance flips them back to in-progress | "no manual input" + track the ruling |
| `completePendingScoringReview()` | `inProgress:false`, `outcome:'resolved'`, label `Ruling Complete` — the row is never deleted | Track forever, never guess final hit/error |
| `shouldAlertForReview()` | `pending_scoring` qualifies (only `abs` excluded) | "trigger the existing sound alert immediately" |
| `visibleInAllFeed()` | `pending_scoring` is not `abs`, so it shows in All | "appear immediately in the Replay Feed all games section" |
| `renderActiveStrip()` | Dedicated `⚖️ SCORING PENDING` strip with game link, ruling type, batting team; pending rulings are EXCLUDED from the generic `🚨 LIVE REVIEW` strip (a scoring decision is never labeled a replay review) | Live visibility + no mislabeling |
| `renderStats()` | `Scoring Pending` stat (active count; tooltip: tracked today + no-run-removal + source) — and the replay `Under Review` counter explicitly EXCLUDES pending rulings | Transparency |
| `renderTabs()` / `matchesFilter()` | `⚖️ Scoring Pending (n)` tab + `setFilter('pending_scoring')`; `Under Review` tab keeps counting replay reviews only | Dedicated filter + no double counting |
| `buildSummary()` / per-game reviews tab | `pendingScoring`/`pendingScoringActive` counts; pending never enters replay `inProgress`/`stands`/`overturned`/overturn rate | Same |
| `feedRow()` | `.feed-batting` chip from `battingTeamAbbrev`/`battingTeamName` | Context, never a "challenging team" |
| `outcomePill()` | `outcome:'resolved'` → `✓ Ruling Complete` (`.outcome-resolved`) | Resolution state, observed not invented |
| `runsRemovableFromReview()` | Returns **0** for `pending_scoring` | A pending scoring ruling never puts a run "at risk" (no false run-risk alert) |

### Flagged for review (deliberate decisions / limitations)

1. **The marker was NOT captured on a live pending play from this sandbox.**
   The sandbox can reach `statsapi.mlb.com` via the API fetcher but not via
   shell `curl`/node fetch, and no live game on 2026-08-29/30 produced an
   `os_ruling_pending_*` event during probing (822688 MIA@WSH live —
   currentPlay, allPlays; 823539 BOS@NYY final — allPlays). The detection code
   therefore checks all 8 possible landing fields, and the deterministic tests
   (below) pin extraction from a play-shaped fixture that mirrors the live
   shape field-for-field with the exact registry values. **Flagged**: the exact
   landing field remains unverified live — the first real pending play should
   be re-checked against this report.
2. **Ruling content is never shown.** When the marker clears, the feed marks
   the observed row "Ruling Complete" and deliberately does NOT read the new
   payload's hit/error text into the old row (the play now appears under its
   own normal event row anyway). No final ruling is guessed.
3. **`isOfficialScoringPendingEvent()` accepts the exact description string in
   addition to the two codes**, because the API's registry exposes the
   description as the human-readable value and a play event's `details.event`
   may carry it. Exact equality only — a value like "official scorer ruling"
   (substring) is rejected. This is deliberately strict, not loose.
4. **StatsAPI v1 `feed/live` returns 404**; only v1.1 works. The feed uses
   `playByPlay` (v1), which was verified live for 822688/823539 and carries
   `allPlays` + `currentPlay` with the fields the parser reads. The parser does
   not depend on `feed/live`.
5. **`Under Review` counts replay reviews only.** An active pending ruling is
   in-progress, but it is excluded from the `Under Review` tab/counter and the
   generic `🚨 LIVE REVIEW` strip, because a scoring decision is not a replay
   under review; it has its own `⚖️ Scoring Pending` surfaces (tab, stat,
   strip, game-page panel heading). The poll cadence still treats it as
   in-progress (`hasActiveReviewSignal`), so the ruling's resolution is picked
   up at the fast cadence.

### New/updated regression coverage

- `tools/official-scoring-test.mjs` (new) — deterministic: registry constants,
  exactness (substring/near-miss rejection), extraction from a live-shaped
  play fixture, dedupe, merge/resolution/retention across three polls, alert
  qualification, All-feed visibility, run-risk = 0, summary separation
  (`pendingScoring`, never `stands`/`overturned`), game-page integration
  surface.
- `tools/replay-feed-render-test.mjs` — fixture extended with a deterministic
  pending row (marker fields verbatim from the registry): All renders manager
  review + pending row (`All (2)`), NOT the ABS row; `⚖️ Scoring Pending (1)`
  tab + `setFilter` wiring; `Scoring Pending` stat = 1; `Events` = 2; pending
  row never flagged run-at-risk, has `Batting: DET` chip and `Ruling Pending`
  pill; the OS strip + exclusion from the generic LIVE REVIEW strip; the
  Under Review tab counts only replay reviews (`(1)`); status line reports
  3 tracked events on the
  250 ms in-review cadence (`REVIEW_POLL_MS`, verified in reviews-feed.js).
- Existing suites re-run clean: `review-test.mjs`, `reviews-feed-test.mjs`,
  `replay-feed-render-test.mjs`, `official-scoring-test.mjs`, `hit-model-test.mjs`,
  `review-probe-test.mjs`. (`smoke-test.mjs` remains network-only; it cannot
  run in this sandbox, unchanged from §13.)

## 15. Update latency on the Replay Feed (added 2026-08-30)

Goal: challenges, reviews, boundary calls, under-review, runs at risk and
official-scorer-pending updates reach the all-games Replay Feed as fast as
possible — structurally (fewer round-trips, smaller payload, no serialized
wait), with every change line-by-line verified and no field names guessed.

### What changed

| File / location | Change | Effect |
|---|---|---|
| `assets/js/api.js` PBP_FIELDS (≈L195-241) + getPlayByPlay (≈L243) | playByPlay now defaults to a `fields=` projection; on a 4xx the SAME endpoint is retried WITHOUT `fields`, then feed/live as last resort | one request carries every parser field; payload ≈3× smaller (verified: 26 vs 76 API chunks for game 823342); a projection quirk can never mask a review |
| `assets/js/reviews-feed.js` L745-750 | `SCHEDULE_TTL_MS = 3000`, `PBP_TIMEOUT_MS = 3000`, `PBP_RETRIES = 0` | schedule reused for 3s; per-game playByPlay fails fast, next poll retries |
| `assets/js/reviews-feed.js` scheduleFor (L1181-1216), load() (L1233+) | schedule refresh kicked off IN PARALLEL with the scan of already-known games (previously serialized in front of EVERY poll) | the schedule RTT is no longer on the critical path; a fresh cache resolves instantly |
| `assets/js/reviews-feed.js` maybeAlertNow (L1398-1432) + ingestGame | chime fires from ingestGame the moment the FIRST game response reports a new/at-risk event (render already painted), instead of after the slowest game | sound is no longer delayed by unrelated games; `pollAlertFired` keeps at most one chime per poll |
| `assets/js/reviews-feed.js` load() end | run-risk desktop notifications deferred to end-of-poll, accumulated per key | one notification per poll; a poll where two games go at-risk at once still names BOTH |
| `assets/js/game.js` L22-23, L121 | review probe passes `PROBE_TIMEOUT_MS=3000, PROBE_RETRIES=0` | the 250 ms in-review probe stops chaining a retry + backoff inside one probe; the projected payload it already uses is 3× smaller |
| unchanged | `REVIEW_POLL_MS=250`, `LIVE_POLL_MS=500`, `IDLE_POLL_MS=5000`, `FETCH_CONCURRENCY=30`, reviewFetchPriority, at-most-one chime per poll | cadence/policy unchanged — the speed-up is from removing serialized waits and shrinking payloads |

### Line-by-line verification (no guesses)

- **Field list** — `PBP_FIELDS` is split into REQUIRED (every name the
  projected payload is read by, cited to `reviews.js`/`game.js` line numbers
  in `tools/api-fields-test.mjs`) and GUARD (extra leaves `isTopInning`,
  `rbi`, `isOut`, `batSide`, `pitchHand`, `call`, `start`, `end` kept
  deliberately: `fields` is a whitelist applied at any depth, so a named
  container could theoretically be pruned of children). The test fails on
  any whitelisted name that is neither REQUIRED nor GUARD.
- **scheduleFor** — cache hit (`scheduleDate` + TTL) returns the current
  `games` array; a refresh in flight is shared, never duplicated; a failure
  resolves `null` (NOT cached — `lastScheduleAt` only updates on success) so
  the next poll retries; the playByPlay scan of known games proceeds
  regardless.
- **scanGames / ingestGame** — `ingestGame` returns `true` on success
  (including a settled Final no-op) and `false` on fetch failure, so
  `knownSuccess`/`freshSuccess` count real successes (verified by the
  backoff branch test).
- **maybeAlertNow** — called per ingested game AFTER `renderFeedUpdates`
  (sound never precedes paint); `pollAlertFired` guarantees ≤1 chime per
  poll; run-risk entries accumulate into `pendingRunRiskNotify` (deduped by
  event key) for the single end-of-poll desktop notification.
- **resetFeed** — clears the schedule cache + slate on date change so the
  parallel flow can never scan the previous date's games.

### Live verification performed 2026-08-30 (official StatsAPI)

- `statsapi.mlb.com/api/v1/game/823342/playByPlay?fields=<PBP_FIELDS>`:
  **26 chunks** (vs **76 chunks** unprojected, ≈2.9× smaller). Chunk 5,
  atBatIndex 15, playEvents[4] carries `reviewDetails` VERBATIM:
  `{isOverturned:false, inProgress:false, reviewType:"MJ", challengeTeamId:116}`,
  plus `details.hasReview:true`, `pitchData.startSpeed:98.1`, count 2-2;
  `result/about/count/matchup/runners` all intact. This is the exact
  ABS-ball/manager challenge the parser must surface.
- `statsapi.mlb.com/api/v1/game/823342/playByPlay` (no fields): 76 chunks —
  the extra bulk is pitch coordinates/breaks etc., explaining the saving.
- `statsapi.mlb.com/api/v1/game/822688/playByPlay?fields=<projection>`
  (live, 2026-08-30): all container/leaf fields the feed reads present; no
  pending-ruling event observed at that moment (not a negative proof — see
  §14 limitations; the parser checks both `playEvents[].details` and
  `play.result`).

### New regression coverage

- `tools/api-fields-test.mjs` (new) — deterministic, no network: pins the
  exact projected URL; REQUIRED ⊆ projection; no unaccounted whitelisted
  name (anti-hallucination check); projected 400 → unprojected → feed/live
  fallback chain (`retries:0`); `getSchedule`/`getChallengeCounts` shapes
  unchanged; timeout abort signal wired.
- `tools/replay-feed-render-test.mjs` — new latency-path section: poll 1 =
  one schedule + one playByPlay scan; poll 2 within the 3s TTL refetches NO
  schedule (count stays 1) but still scans playByPlay (count 2); no duplicate
  rows (`All (2)`) and the status line still reports exactly `3 review
  events` — the loop is idempotent.

### Test results (all passed)

`api-fields-test.mjs`, `official-scoring-test.mjs`, `review-test.mjs`,
`reviews-feed-test.mjs`, `replay-feed-render-test.mjs`, `hit-model-test.mjs`,
`review-probe-test.mjs`. (`smoke-test.mjs` is network-only; it cannot run in
this sandbox, unchanged.)

### Flagged for review (deliberate decisions / limitations)

1. **Chime priority when two different games report in one poll window** —
   arrival order now wins the single chime (previously run-risk always beat
   the generic chime because the decision was made once after all games
   resolved). Every event still renders; the run-risk desktop notification
   covers ALL at-risk games of the poll (accumulated). Sound remains ≤1 per
   poll. This is the trade-off for an immediate chime.
2. **Run-risk desktop notification is end-of-poll** (the chime is immediate)
   so one notification can name simultaneous at-risk games; worst-case
   deferral is one scan wave (~one RTT), same as before.
3. **Schedule TTL 3 s** — a game that goes Live is revealed ≤3 s + one poll
   interval later; always fresh on first poll and on date change. Deliberate:
   the schedule's only moving parts (status/counters) are also carried by
   per-game playByPlay, which is polled every cycle.
4. **PBP timeout 3 s / 0 retries** — a genuinely stalled game can hold its
   own slot up to 3 s; other games still fetch concurrently (30-way); next
   poll retries. Worst-case update latency on a pathological network ≈
   timeout + next poll interval + one scan — bounded and strictly better
   than the previous default (5 s timeout + retry ≈ 10.5 s stall).
5. **Projection fallback costs one extra round-trip** in the rare 4xx case
   (a game that rejects a field name), and feed/live is the heavier last
   resort — chosen so a review can never be masked by the projection.
6. **No wall-clock latency measurement in this sandbox** — the tools have no
   outbound network and `smoke-test.mjs` is CI-only. The improvements are
   structural (serialized schedule RTT removed, per-game immediate chime,
   3× smaller payload, fail-fast fetches) and chunk-verified; absolute
   browser timings should be confirmed via DevTools Network against a live
   slate.

## 16. Review-detection latency: the official game-status registry + a 250 ms status watcher (added 2026-09-02)

Requirement (verbatim from the user): *"I am receiving notifications, updates,
and alerts after the play has been completed and not as soon as the play is
under review… I need to know when a play is under review, being challenged,
boundary calls, runs at risk, official scoring pending reviews, etc as fast as
possible."*

That complaint is **not** only a polling-cadence problem. Two things were
actually wrong, and both are now fixed and pinned by tests.

### 16.1 The root cause: review detection read the wrong field

The app decided "is a game under review?" with
`/challenge|review/i.test(status.detailedState)` — an English word match on a
label. It was duplicated in **six** places
(`reviews.js` ×2, `reviews-feed.js` ×3, `scoreboard.js` ×2, `ui.js` ×1).

The official registry — **`GET https://statsapi.mlb.com/api/v1/gameStatus`**,
read in full (4 pages) on **2026-09-02** — contains a live review state whose
`detailedState` is **`"Instant Replay"`** (`statusCode: "IH"`,
`codedGameState: "I"`, `reason: "Review"`). That string contains neither
"challenge" nor "review":

```js
/challenge|review/i.test('Instant Replay')   // → false
```

**So every crew-chief instant-replay review was invisible to the whole app**:
no alert, no chime, no "Under Review" strip, no Challenges-tab count, no drop
to the 250 ms cadence, and no synthesized "under review" feed row. It only
became visible if the play's own `reviewDetails` happened to expose
`inProgress:true` — and §7 of this report already records that `inProgress:true`
was **never captured live** in this project.

| Claim | Verified? | Evidence |
| --- | --- | --- |
| `GET /api/v1/gameStatus` is the official list of every `status` value | ✅ live 2026-09-02 | 4-page response read end to end; 200+ states |
| The registry's review subset is exactly 47 states, all `abstractGameState:"Live"` | ✅ | `IH` (1) + `M*` (23) + `N*` (23). Enumerated in `REVIEW_STATUS_BY_CODE` (`assets/js/reviews.js`) and counted by `tools/review-status-test.mjs` §1 |
| `codedGameState "M"` and `"N"` belong to challenge/review states and nothing else | ✅ | Every `"M"` row is "Manager challenge: …" or "Player challenge: Pitch Result"; every `"N"` row is "Umpire review: …" or "Umpire Challenge: Pitch Result". No delay/suspension/forfeit row uses M or N |
| `statusCode "IH"` = `"Instant Replay"`, `reason "Review"` | ✅ | verbatim registry row |
| `statusCode` is the SAME vocabulary as `reviewDetails.reviewType` | ✅ cross-check | `MA` = registry "Tag play" ↔ game 823341 *"Tigers challenged (tag play)"*; `MF` = "Close play at 1st" ↔ game 824075 *"Royals challenged (play at 1st)"*; `MJ` = "Pitch Result" (Player challenge) ↔ games 823342/823667/824075 ABS; `NH` = "Umpire review: Home run" ↔ game 824801 foul/potential-HR review |
| The registry's `reason` is available at review start, before any play text exists | ✅ by construction | `status` is a game-level field that flips when the review is **called**; the play description this parser also reads ("…call on the field was overturned: …") is written when the review **resolves** |
| `MJ` was already classified as ABS; `NJ` was **not** | ✅ fixed | `normalizeType('NJ', …)` fell through to the generic `"Replay Review"` label. Now `MJ`/`NJ` → ABS Challenge |

**Fix.** `REVIEW_STATUS_BY_CODE` in `assets/js/reviews.js` holds all 47 rows
verbatim (`detailedState` + `reason` + `codedGameState`). Detection is now
`isReviewGameStatus(status)`: registry `statusCode` → `codedGameState M/N` →
text fallback (which now includes `instant replay`). Every one of the six call
sites was converted. `normalizeType()` resolves short codes through
`reviewTypeForStatusCode()`, so a row built from the status and a row built
later from `reviewDetails.reviewType` can never disagree.

**Not changed, deliberately:** the review *categories* are untouched. `MH`
("Manager challenge: Home run") and `MS`/`NS` ("Stadium boundary call") stay
`manager`/`crew_chief`, not `boundary` — only the observed `NH` code classifies
as a Boundary Call, exactly as §9 already decided. Reclassifying them would
change the Boundary Calls stat and the challenges-remaining attribution, which
is a semantics change, not a latency one. The boundary *topic* is now visible
on every row anyway, because the official `reason` ("Home run", "Stadium
boundary call", "Fair/foul in outfield") is carried through.

### 16.2 The second cause: the fastest signal was gated behind a 3 s cache

`ingestGame()` builds its pseudo-feed's `gameData.status` from the cached
schedule (`SCHEDULE_TTL_MS = 3000`). On the 500 ms live cadence that means
**5 polls in 6 reuse a stale status** — so even for the review states the regex
did match, the "under review" row could sit unpublished for up to ~3 s.

| Claim | Verified? | Evidence |
| --- | --- | --- |
| A `fields`-projected, hydration-free schedule returns gamePk + full status for the whole slate | ✅ live 2026-09-02 | `GET /api/v1/schedule?sportId=1&date=2026-09-02&fields=dates,games,gamePk,season,status,abstractGameState,codedGameState,detailedState,statusCode,reason,startTimeTBD,abstractGameCode` → all 15 games, **1 chunk** vs **8 chunks** for the hydrated schedule `getSchedule()` uses |
| The projection preserves `reason` | ✅ live | the same response showed game 822686 as `{statusCode:"II", detailedState:"Delayed", reason:"Inclement Weather"}` — a real rain delay, and proof `reason` survives the projection |
| A delay is not mistaken for a review | ✅ | `isReviewGameStatus({statusCode:'II', codedGameState:'I', detailedState:'Delayed'})` → false; asserted for 16 real non-review registry rows in `tools/review-status-test.mjs` §2 |
| Per-game status is a ~150-byte projection | ✅ live | `GET /api/v1.1/game/824470/feed/live?fields=gameData,status,…` → `{"gameData":{"status":{…6 fields…}}}` and nothing else — no `players`, no `liveData` |

**Fix.** `MLB.getReviewStatus(date)` + `MLB.getGameStatus(gamePk)` in
`assets/js/api.js`, and a **review-status watcher** in `reviews-feed.js`:
its own 250 ms timer (`REVIEW_STATUS_POLL_MS = 250`, backing off to 5 s when
nothing is Live), which diffs the sweep (`reviewStatusFlips`), merges the fresh
status into `games` field-by-field (`mergeReviewStatusIntoGames`, so a
projection can never delete a field the hydrated schedule supplied), paints the
LIVE REVIEW strip immediately, and kicks an **out-of-band** `load()` instead of
waiting for the next tick. If a flip lands while a scan is already running,
`reviewStatusFlipPending` makes that scan re-run on exit — costing at most one
extra scan, because `load()` clears the flag on entry.

```
worst case before : ~3000 ms schedule cache  + up to 500 ms poll
worst case after  : ~250 ms watcher          + one round trip
```

`game.js` gets the same treatment per game: while live and not already known to
be in review, a ~150-byte `getGameStatus` probe is **raced** against the 1–2 MB
full feed. When the small one wins it flips the page straight to the 250 ms
review cadence and says so on the status line; `renderAll()` still decides
everything from the authoritative feed, and a `loadCycle` guard makes a late
probe a no-op.

### 16.3 Tests added

| Tool | What it pins |
| --- | --- |
| `tools/review-status-test.mjs` (new, 11 sections) | registry integrity (47 rows, verbatim `detailedState`/`reason`, M↔N reason agreement); `isReviewGameStatus` true for all 47 and false for 16 real non-review states; **all four self-contained copies** (reviews-feed / game / scoreboard / ui) agree with `MLBReviews` over the whole registry; `normalizeType` codes; `reviewStatusInfo`; `extractReviews` synthesizing an in-progress row from status alone for MA/IH/NA/NH/MJ with the official reason; `reviewStatusFlips`; `reviewFetchPriority`; and §10, which asserts the old word match really does miss `"Instant Replay"` |
| `tools/review-watcher-test.mjs` (new) | drives the **real boot path** with fake timers: boot sweep, status-only window (banner + strip up before any play text exists), out-of-band scan on a flip, run-at-risk from a status-only review, code-change = new event, no extra scan when nothing changed, silent failure, hidden-tab pause, and §4b (a slow game elsewhere in the slate does not hold back another game's banner) |
| `tools/smoke-test.mjs` (+3 sections, CI/live) | re-reads `/api/v1/gameStatus` and **diffs it against the hardcoded table** (missing, stale, or drifted rows all fail); asserts the projection is ≥5× smaller than the hydrated schedule; asserts the per-game projection returns status only |
| `docs/workflows/smoke.yml` | both new tools added to the nightly run |

**Mutation-verified** (each mutation was applied, the suite run, and the file
restored): reverting `isReviewGameStatus` to the word match fails §2 on `IH`;
dropping `instant replay` from the reviews-feed copy fails §3; raising
`REVIEW_STATUS_POLL_MS` above `SCHEDULE_TTL_MS` fails §11; removing the boot
sweep, the status merge, or the out-of-band `load()` each fail
`review-watcher-test.mjs`; removing `renderFeedUpdates()` from `ingestGame`
fails §4b.

### 16.4 Limitations (stated, not glossed)

1. **No live mid-review capture yet.** The registry proves the state machine
   (`"Manager challenge: Tag play"` is by definition an in-flight state), and
   the two projections were verified live on 2026-09-02 — but no game happened
   to be under review during this session, so a real `statusCode:"MA"` payload
   was not captured. `smoke-test.mjs` will exercise the full path against a live
   slate in CI, and §16.1's cross-check ties four registry codes to payloads
   this repo *did* capture.
2. **Absolute browser timings were not measured.** This sandbox has no outbound
   network for the tools; the numbers above are structural (cache 3 s → watcher
   250 ms) and chunk-count based, exactly as §15's caveat 6 already said.
3. **A brand-new game is still bounded by the schedule cache.** The watcher can
   only merge status into games the hydrated schedule has already revealed, so
   a game that goes Live *and* straight into review before the first schedule
   refresh is picked up ≤3 s later — unchanged from before, and unavoidable
   because the playByPlay scan is driven off the same slate.
4. **The watcher adds requests.** One ~2.4 KB sweep every 250 ms while any game
   is Live (≈10 KB/s), plus one ~150 B per-game probe per cycle on `game.html`.
   Both are ~30× smaller per byte of information than re-polling the hydrated
   schedule they replace, and both stop when the tab is hidden.
5. **`MJ`/`NJ` ABS challenges do trigger the watcher flip** (they are registry
   review states, and the old regex matched `"Player challenge: Pitch Result"`
   too, so this is not a regression). The chime still skips routine ABS via
   `shouldAlertForReview()`; only the run-at-risk case sounds, as before.

## 17. Post-Final scoring-change latency: recency-tiered re-scan (added 2026-09-04)

Goal: lower the worst-case wait for an **official scoring change that lands AFTER a game is
Final** (hit ↔ error / single ↔ double / out ↔ hit reclassifications). Those are the only review
updates this repo delivers on a multi-second cadence — the rest (challenges/reviews/boundary/
under-review via the 250 ms status watcher in §16; runs-at-risk and official-scorer-pending via
the playByPlay scan) are already at the pull-API floor.

### Before

`finalScanDecision()` returned `'scan'` at most once per a flat `SCORING_FINAL_RESCAN_MS = 30 s`
within a 30-minute `SCORING_CHANGE_GRACE_MS`. A scorer ruling published after Final could therefore
sit unseen for up to ~30 s regardless of when it landed.

### Change (assets/js/reviews-feed.js)

`finalScanDecision` now takes two optional params (`fastRescanMs`, `fastWindowMs`). When both are
finite, a Final whose age (`now - grace.firstFinalObservedAt`) is within `fastWindowMs` is re-scanned
at the fast gap; beyond that (still inside `graceMs`) the base `rescanMs` applies. The last branch —
a Final older than `graceMs` → `'skip'` forever — is unchanged, so polling stays bounded.

Production constants (the IIFE owns them):

| Constant | Value | Meaning |
|---|---|---|
| `SCORING_CHANGE_GRACE_MS` | `30 * 60 * 1000` | unchanged — 30 min cap; never polled beyond |
| `SCORING_RECENT_RESCAN_MS` | `5 * 1000` | fast gap while the game is recently Final |
| `SCORING_RECENT_FINAL_WINDOW_MS` | `5 * 60 * 1000` | "recently Final" = first 5 minutes after Final |
| `SCORING_FINAL_RESCAN_MS` | `15 * 1000` | base gap once the fast window passes |

### Verification (line by line, no guesses)

- Semantics unchanged for uniform-gap callers: both new params are optional and `Number.isFinite`
  defaults to "no fast phase", so a 5-argument call behaves exactly as before. The pre-existing
  uniform-gap assertions in `tools/scoring-change-test.mjs` §10 pass unmodified.
- New deterministic cases pin: recently-Final → scanned ~6× sooner (5 s gap); past the fast window →
  base 15 s gap; and the tiers **never** extend polling beyond the 30-minute grace (a game older
  than grace is `'skip'` even at the fast gap).
- The feed's only post-Final polling gate is this one decision; the 30-minute grace still caps total
  per-game post-Final request volume (~a handful per game), so no unbounded API load is introduced
  — consistent with the repo's "good citizen" guidance in the README.
- Full deterministic suite green after the change: `review,reviews-feed,replay-feed-render,
  review-probe,review-status,review-watcher,official-scoring,scoring-change,api-fields,hit-model`.
- Net effect: worst-case post-Final scoring-change wait drops from ~30 s to **~5 s in the first
  5 minutes** after Final and **~15 s** thereafter. Cross-referenced in `docs/latency-audit.md`.

## 18. Latency pass 2026-09-05: feed scan 250ms, page/scoreboard status watchers, 429 self-throttle

Scope: close every remaining >250ms gap in the delivery of challenges, reviews, boundary
calls, under-review, runs-at-risk, official-scoring-pending, all review updates and the
scoring-change tracker — without spamming the API. Full change list, line references and the
category-by-category before/after table live in `docs/latency-audit.md` (2026-09-05 addendum).
This section records what was **verified live this session** and what the new tests caught.

### 18.1 Live verifications made this session (2026-09-05, via this sandbox's page-fetch tool — the shell itself has no outbound network)

| Claim | Result |
|---|---|
| Whole-slate `fields`-projected schedule (the watcher sweep) returns the full slate in ONE small chunk | ✅ live — `GET /api/v1/schedule?sportId=1&date=2026-09-04&fields=dates,games,gamePk,status,…` → 16 games (13 Final, 3 Live) in a single response chunk; the 2026-09-05 sweep returned all 15 games (all Preview) likewise |
| Per-game status projection is exactly the documented ~150-byte shape | ✅ live — `GET /api/v1.1/game/823256/feed/live?fields=gameData,status,…` → exactly `{"gameData":{"status":{"abstractGameState":"Live","codedGameState":"I","detailedState":"In Progress","statusCode":"I","startTimeTBD":false,"abstractGameCode":"L"}}}` — no players, no liveData |
| The projected playByPlay the 250ms scan uses is lean on a real live game | ✅ live — the exact `PBP_FIELDS` URL for live game 823256 (NYY@SD, early innings) returned 20 tool-chunks mid-game (repo-documented full-game comparison: 26 projected vs 76 unprojected chunks, §15) |

### 18.2 New deterministic coverage (all network-free, all run in CI via the README list)

| Suite | Pins |
|---|---|
| `tools/page-status-watcher-test.mjs` (new) | Boots the REAL `scoreboard.js` (Part A) and the REAL `game.js` + REAL `reviews.js` (Part B) through their DOMContentLoaded paths with fake timers and a recording DOM. A: pure `scheduleStatusFlips` diff policy (adopt/identical/review-flip/delay-reason/slate-size); boot arming; **no-change sweeps never re-render** (isolated with a parked schedule fetch); 250ms sweep cadence while live; review flip → ticker up ≤250ms + main poll drops to 250ms; resolution clears the ticker; hidden-tab park/resume; idle 5s backoff. B: 250ms watcher cadence while live; status flip → "🚨 \<registry detailedState\>" status line + OUT-OF-BAND full feed; banner renders from the authoritative feed; lean probe owns in-review ticks while the watcher parks at 1s check-ins; resolution + grace expiry re-arms the watcher; hidden-tab park/resume. |
| `tools/api-rate-limit-test.mjs` (new) | Boots the real `api.js` with a recording setTimeout: 2xx paths never sleep; a 429 arms a ~60s quiet period and still propagates; the next request on ANY endpoint first sleeps exactly the remaining window (one deliberate sleep, one request); the window expires with time; one shared budget across endpoints; 404/500/503 never arm it. |
| `tools/review-watcher-test.mjs` §8 (extended) | Source-pins the tightened constants: `LIVE_POLL_MS = 250`, `REVIEW_POLL_MS = 250`, `SCORING_RECENT_RESCAN_MS = 2.5s` (plus the pre-existing `REVIEW_STATUS_POLL_MS = 250 < SCHEDULE_TTL_MS`). |

### 18.3 Real bugs the new tests caught in the new code (and their fixes)

1. **Phase-reset degradation:** re-arming a watcher from every poll cycle (`scheduleNext`) clears
   and re-sets its timer, stretching a nominal 250ms sweep to ~2/s whenever ordinary polls
   complete in between — observed as exactly 2 sweeps/1000ms in §A3. Fix: the watchers are
   self-perpetuating (every path re-arms), started only at boot and on tab-show.
2. **Stuck review flag:** the game page recomputed `lastActiveReview` only inside `renderAll`,
   which runs only when the feed token changes — after a review resolved with no further play,
   the token was stable and the flag stayed `true` forever, keeping the page on the probe path
   and the watcher parked. Fix: recompute on unchanged-token cycles too (game.js `load()`).
3. **Writer flapping:** the watcher (status says review) and `renderAll` (feed does not yet)
   could overwrite each other at 250ms, each flap re-downloading the 1–2MB full feed. Fix: the
   3s `STATUS_LEAD_GRACE_MS` trusts the official status over the lagging feed, and
   `renderStatusLine` keeps the 🚨 label during the window.
4. **Back-to-back reviews:** parking the game-page watcher at the 5s idle cadence while a
   review was known would delay a *status-only* re-challenge after a resolution by up to 5s
   (the retired in-cycle race caught it in 500ms). Fix: 1s timer-only check-ins
   (`STATUS_WATCH_RECHECK_MS`) — zero requests, ≤1s resume.

### 18.4 Politeness budget (why this honors the API)

- **No API keys exist** for the MLB StatsAPI — there is no key-holder ToS to violate; the
  constraint is the host's tolerance. Worst case with a full ~15-game live slate and the
  Replay Feed open: ~60 projected-playByPlay requests/s + ~4 whole-slate status sweeps/s
  (~10 KB/s) ≈ **64 req/s from one browser** — the same cadence the feed already used
  whenever any review was in flight, two-plus orders of magnitude under "thousands per
  second". Game page: full feed every 500ms + a ~150-byte probe 4×/s while live and not in
  review. Scoreboard: hydrated schedule every 500ms + the 2.4KB sweep 4×/s.
- Hidden tabs pause everything; idle slates back off to 5s; finals settle after the bounded
  30-minute grace; and **any HTTP 429 now throttles the entire client for 60s** (§18.2),
  so if MLB ever pushes back, the app slows itself down automatically.
