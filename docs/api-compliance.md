# API use, the governing terms, and the request budget every latency change is measured against

This document is deliberately narrow: it quotes the rules that actually attach to the data this app
reads, states what the app does to stay inside them, and lists the exact request rate of every
polling surface **line by line**. It is not legal advice, and nothing here has been reviewed by
MLB.

**Why it exists:** the project's goal is "receive these updates as fast as possible". That goal is
bounded by the host's rules, so the ceiling and the enforcement must be written down rather than
assumed.

---

## 1. The three governing texts (quoted, with where each came from)

### A. The notice served *with* the API data itself

`GET https://statsapi.mlb.com/api/v1/...` responses are accompanied by the notice at
<http://gdx.mlb.com/components/copyright.txt> (fetched 2026-09-26, verbatim):

> The accounts, descriptions, data and presentation in the referring page (the "Materials") are
> proprietary content of MLB Advanced Media, L.P ("MLBAM"). Only individual, non-commercial,
> non-bulk use of the Materials is permitted and any other use of the Materials is prohibited
> without prior written authorization from MLBAM. Authorized users of the Materials are prohibited
> from using the Materials in any commercial manner other than as expressly authorized by MLBAM.

### B. MLB.com Terms of Use, §1 — INTRODUCTION; GENERAL; OWNERSHIP; PROHIBITIONS

<https://www.mlb.com/official-information/terms-of-use> (fetched 2026-09-26), §1, verbatim
excerpts:

> Except for downloading one copy of the MLB Digital Properties on any single device for your
> personal, non-commercial home use, you must not reproduce, prepare derivative works based upon,
> distribute, perform or display the MLB Digital Properties without first obtaining the written
> permission of MLB … The MLB Digital Properties must not be used in any unauthorized manner.

> You must not use the MLB Digital Properties … to: (ii) transmit, store or otherwise make
> available material which disrupts any of the MLB Digital Properties, imposes an unreasonable or
> disproportionately large load on any MLB Digital Property infrastructure or otherwise adversely
> affects, restricts or inhibits any other user from using any of the MLB Digital Properties; …
> (xi) use automated scripts to collect information from or otherwise interact with the MLB Digital
> Properties; and …

### C. The API's own operational signal

The StatsAPI is **keyless and publishes no rate limit** (community-maintained documentation:
"Rate Limiting: No official limits published — implement caching and backoff in your
applications", <https://github.com/pseudo-r/Public-MLB-API>, fetched 2026-09-26). It has **no
`robots.txt`** (`https://statsapi.mlb.com/robots.txt` → `404`, 2026-09-26). The only signal the
host gives at request time is an HTTP **429**, optionally with `Retry-After` — which this client
honours (`assets/js/api.js`: `rateLimitedForMs`, `parseRetryAfter`,
`RATE_LIMIT_BACKOFF_MS`/`RATE_LIMIT_MAX_BACKOFF_MS`, armed in `getJSON`).

---

## 2. What those texts mean for this app — stated plainly, including the tension

**Inside the rules:**

- **Individual, non-commercial use of the data** (A). This app is an unofficial fan project: no
  ads, no paid tier, no data resale, no API keys.
- **Non-bulk, bounded request volume** (A, B(ii)). Every surface is interval-bounded, hidden tabs
  stop entirely, idle slates back off, and post-Final re-scanning is capped by a 30-minute grace
  window (§3).
- **Immediate compliance with the host's own throttle** (C). A 429 parks every endpoint in the
  client for the server's `Retry-After` (clamped 1s–5min) or 60s if none is sent.

**The tension, not glossed over:**

- B(xi) — "use automated scripts to collect information from or otherwise interact with the MLB
  Digital Properties" — read literally covers *any* polling client, including this one, while A
  expressly permits "individual, non-commercial, non-bulk use" of the data. The two clauses point
  in different directions; there is no written authorization either way.
- B §1's "personal, non-commercial **home** use" carve-out, and A's restriction on
  reproducing/displaying the Materials beyond it, sit uncomfortably with **hosting a public
  deployment**. This repository is **public** on GitHub (`buffedlizard55-lab/MLB-Live-PBP`,
  confirmed `visibility: public` via the GitHub API on 2026-09-26) and the README documents a
  GitHub Pages deployment path. That is a decision for the owner, not something the code can
  enforce — see §5.

**Therefore the rule this project enforces is:** stay small, stay bounded, back off instantly, and
never fetch more than one page needs. Everything in §3 exists to hold that line; every latency
change is measured against it.

---

## 3. The budget, line by line (worst case: every game on the slate Live at once)

Sources are the constants named; rates are arithmetic on those constants, not measurements — this
sandbox has no outbound network to time against.

### Replay Feed — `assets/js/reviews-feed.js`

| Request | Constant | Worst-case rate |
|---|---|---|
| Play-by-play wave, one request per Live/Final game (the detection scan) | `LIVE_POLL_MS = 250`, `FETCH_CONCURRENCY = 30` | 15 games ÷ 0.25s = **60/s** |
| Whole-slate official status sweep (the earliest signal that exists) | `REVIEW_STATUS_POLL_MS = 125` | **8/s** (~2.4 KB each ≈ 19 KB/s) |
| Hydrated schedule (teams, scores, challenge counters) | `SCHEDULE_TTL_MS = 3000` | ≤0.33/s |
| Challenge counters (`getChallengeCounts`) | only when a game has feed entries **and** its events changed or counters were never captured | ≤ wave rate, in practice a handful around each event |
| Post-Final re-scan (per finished game, inside the 30-min grace) | 1s for 2 min, 2.5s to 5 min, then 15s | ≈1.6/s while in window; **0** after the grace |
| Team directory | `TEAMS_RETRY_MS = 5min`, one per season | negligible |

**Feed page total: ≈68 req/s** while a full 15-game slate is Live (was ≈64/s before the 125ms
sweep), dominated by the projection-lean play-by-play wave.
Hidden tab: **0 req/s** (`stopPolling` on `visibilitychange`). Idle slate: ≈0.4/s.

### Game page — `assets/js/game.js`

| Request | Constant | Worst-case rate |
|---|---|---|
| Full `feed/live` (1–2 MB — the repo's own estimate in the source comments; not measured here) | `LIVE_POLL_MS = 500` | 2/s |
| Per-game status sweep — **only** while Live and not already known to be in review | `STATUS_WATCH_POLL_MS = 125`, `STATUS_WATCH_RECHECK_MS = 1000` (no fetch while in review), `STATUS_WATCH_IDLE_MS = 5000` | 8/s live-and-unreviewed; 0 while in review; 0.2/s preview/final |
| Lean in-review probe (projected play-by-play) | `REVIEW_POLL_MS = 250`, `PROBE_RETRIES = 0` | 4/s while a review is in flight |
| Shared-log pull | 3s, or 15s while the push stream is up | ≤0.33/s |

**Game page total: ≤14/s**, dominated in *volume* by the full feed — the heaviest payload in the
app is on the fastest-latency page, which is why the 2026-09-26 probe-first banner (paint from the
lean probe while the full feed is still in flight) exists.

### Scoreboard — `assets/js/scoreboard.js`

| Request | Constant | Worst-case rate |
|---|---|---|
| Hydrated schedule | `LIVE_POLL_MS = 500` | 2/s |
| Whole-slate status sweep | `REVIEW_STATUS_POLL_MS = 125`, parked at `REVIEW_STATUS_IDLE_MS = 5000` | 8/s while live; 0.2/s idle |
| Shared-log pull | ≤1 per poll, or 1 per 15s while the push stream is up | ≤2/s → 0.07/s |

**Scoreboard total: ≈10/s.**

### Our own server (not MLB)

`server.mjs` serves the pages and the feed log; `POST /api/feed-log` is throttled client-side to
**≤1 write/s** by `scheduleFeedLogSave`. The SSE tail is one long-lived same-origin connection per
open page. A push (`broadcastFeedLog`) costs **no** MLB request — it only redistributes what some
page already observed.

### Aggregate

| Scenario | MLB requests/s |
|---|---|
| Replay Feed alone, full live slate | ≈68 |
| Scoreboard alone, full live slate | ≈10 |
| Game page alone, live | ≤14 |
| All three open, full live slate | ≈92 |
| Any hidden tab | 0 |

For scale: the repo's own documented comparison is "far below thousands of requests per second",
and the sweeps — the requests that were made faster — are ~2.4 KB each (~19 KB/s), i.e. rounding
error next to one 1–2 MB full-feed download every 500 ms.

---

## 4. Mechanisms that enforce the line (each one is a real code path)

- **Overlap guards** so a slow response can never stack requests: `reviewStatusInFlight`
  (feed/scoreboard), `statusWatchInFlight` (game page), `scheduleInFlight`, `priorityScanInFlight`,
  `probeRenderInFlight`, `syncInFlight`.
- **Fail-fast fetches**: `PBP_RETRIES = 0`, `PROBE_RETRIES = 0` — a retry inside the same tick only
  delays the next one; the next tick retries anyway.
- **Hidden-tab pause**: `stopPolling()` / watcher parks on `visibilitychange` on all three pages.
- **Idle backoff**: 5s parks when nothing is Live (`REVIEW_STATUS_IDLE_MS`,
  `STATUS_WATCH_IDLE_MS`, `IDLE_POLL_MS`), 60s preview / 180s final on the game page.
- **Bounded post-Final polling**: `SCORING_CHANGE_GRACE_MS = 30min`, tiered 1s/2.5s/15s, then the
  game is never re-scanned again.
- **Small-payload projections everywhere**: `fields=`-projected play-by-play (`PBP_FIELDS`), the
  hydration-free whole-slate status sweep (~2.4 KB), the ~150-byte per-game status projection —
  each was chosen over the fuller endpoint it replaces.
- **Bounded cosmetic work**: the team directory waits at most `TEAMS_WAIT_MS = 600` and is not
  retried for `TEAMS_RETRY_MS = 5min`.
- **Host-signalled backoff**: HTTP 429 → quiet period (server's `Retry-After`, clamped, else 60s)
  across every endpoint in the client.

---

## 5. Flagged for review — decisions, not code (the owner's call)

1. **Public deployment vs "personal, non-commercial home use." — OWNER DECISION RECORDED
   (2026-09-26):** *"this is for personal use, even though it exists in a public github page."*
   The project is used personally by its owner; the public repository and the GitHub Pages site are
   simply where it lives, not a service offered to others, and there is no commercial use, no
   advertising, no analytics and no data resale (verified: no ad/analytics code anywhere in the
   repo, 2026-09-26). Recorded facts for transparency: the repository is public
   (`visibility: public`) and GitHub Pages is **enabled and built** from `main` at
   <https://buffedlizard55-lab.github.io/MLB-Live-PBP/> (GitHub API, 2026-09-26) — so merging to
   `main` publishes the app. If that posture ever changes (or MLBAM asks), this is the paragraph to
   revisit first: the conservative reading remains "local/private only, absent written
   authorization". Hiding the site without changing the code is a one-click GitHub setting, and
   §6 lists the dials that reduce load.
2. **Derived data committed to git.** `data/feed-log-*.json` (and `data/feed-log-index.json`) are
   tracked snapshots of observed data. The runtime path (server disk store + `localStorage`) does
   not need them in git; ignoring them is a cleaner posture. Left as-is deliberately (owner
   decision 2026-09-26, personal use): they are the static fallback the GitHub Pages deployment
   reads when `server.mjs` is not running, so removing them would strip the deployed site's
   restored feed. Revisit if the project ever moves off public Pages.
3. **Multi-tab multiplier.** N open tabs = N × the rates in §3. The push architecture already
   solves this in principle — one session observes and everyone else receives over SSE — but no
   single always-on observer exists. A server-side poller (one process, fanning out over the
   existing `/api/feed-log/stream`) would cut a many-tab household from N × 68/s to ≈68/s total.
   Not implemented: it assumes a persistent host, which is a deployment decision.
4. **The 125 ms sweep is the most aggressive single setting in the app.** It is defensible (small
   payload, overlap-guarded, live-only) but it is also the first dial to turn back:
   `REVIEW_STATUS_POLL_MS` (feed) → 250, `STATUS_WATCH_POLL_MS` (game page) → 250,
   `REVIEW_STATUS_POLL_MS` (scoreboard) → 250, which returns the footprint to the pre-2026-09-26
   ≈64/s and moves the ceiling from ~125ms to ~250ms.

## 6. Dial reference

| Goal | Constant |
|---|---|
| Fastest detection of a new challenge/review/boundary/under-review | `REVIEW_STATUS_POLL_MS` (feed, scoreboard), `STATUS_WATCH_POLL_MS` (game page) |
| Fastest row/outcome detail once a review exists | `REVIEW_POLL_MS` (feed + game page probe) |
| Post-Final scorer rulings | `SCORING_HOT_RESCAN_MS` / `SCORING_HOT_WINDOW_MS`, `SCORING_RECENT_RESCAN_MS`, `SCORING_FINAL_RESCAN_MS` |
| Cross-browser delivery | `RUN_RISK_NOTIFY_COALESCE_MS`, `/api/feed-log/stream` (server) |
| Politeness floor | `PBP_TIMEOUT_MS`/`PBP_RETRIES`, `*_IDLE_MS`, `SCORING_CHANGE_GRACE_MS`, 429 backoff in `api.js` |
