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
| `reviewType` codes | ✅ | **`MJ` = ABS pitch challenge** (all three pitch-event samples; matches `gameData.absChallenges` counters, and MLB-Gameday-derived parsers confirm "MJ = player ABS challenge"). **`MA`/`MF` = traditional play reviews** (manager challenges, per the accompanying description text). |
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
