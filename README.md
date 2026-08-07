# ⚾ MLB Live PBP — Live MLB Scoreboard & Play-by-Play

> ### 🛑 **CHECKPOINT NOTICE: `v1.0.0-stable-checkpoint`** 🛑
> **This tag marks a safe, working baseline of the code. If any experimental changes break the app, you can instantly revert back to this stable state by running:**
> ```bash
> git reset --hard v1.0.0-stable-checkpoint
> ```

A zero-dependency, static web app that pulls **live MLB game data** straight from the
public MLB StatsAPI and renders it in a **Gameday-style scoreboard** — exactly the data
mlb.com uses, re-implemented from scratch in vanilla HTML/CSS/JS.

- **Scoreboard** (like [MLB.com](https://www.mlb.com/scoreboard)) — every game for any
  date, with live scores, inning, count, probable pitchers, and W/L/S decisions.
- **Game view** (like [MLB.com Gameday](https://www.mlb.com/gameday)) — **who's at bat,
  who's pitching, the count, outs, runners on base**, on-deck / in-the-hole hitters,
  pitch counts, last play, inning-by-inning linescore, full box score, and the complete
  play-by-play timeline with pitch-by-pitch details.
- **Two-sided hit forecast** — a transparent per-plate-appearance hit probability that
  compounds the batter's and pitcher's season rates (log5), real platoon splits,
  recent form, head-to-head history, same-game familiarity, and the live count into a
  single number with a matchup tier (Elite → Pitcher's edge) and per-driver point
  adjustments. It appears in the live at-bat card, the Props & Matchup tab, and
  completed PBP rows.
- Auto-refreshes every **5 seconds** during live games; works on desktop and mobile.
- No build step, no frameworks, no API keys — it runs on **GitHub Pages** (or any static
  host, or even `file://`).

> **Live demo:** [buffedlizard55-lab.github.io/MLB-Live-PBP](https://buffedlizard55-lab.github.io/MLB-Live-PBP/)

---

## How it works — reverse-engineering MLB.com Gameday

MLB.com's Gameday is a JavaScript app. It reads JSON from a public, undocumented API at
**`https://statsapi.mlb.com/api/v1/`** (plus `v1.1` for live game feeds) and pulls
images (logos, headshots) from **`mlbstatic.com`**. No login, no API key, and the API
sends CORS headers, so any static page can call it directly from the browser.

This project does the same thing with its own front end. The API calls we make:

| What we need | Endpoint |
| --- | --- |
| Games for a date (scoreboard cards, probables, live count) | `GET /api/v1/schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher,linescore,decisions` |
| Full game state — play-by-play, current at-bat, linescore, box score, decisions, rosters | `GET /api/v1.1/game/{gamePk}/feed/live` |
| Fallback feed (older games) | `GET /api/v1/game/{gamePk}/feed/live` |
| Fallback bundle (if the feed 404s) | `GET /api/v1/game/{gamePk}/playByPlay` + `/boxscore` + `/linescore` |
| Team logos | `https://www.mlbstatic.com/team-logos/team-cap-on-dark/{teamId}.svg` |
| Player headshots | `https://img.mlbstatic.com/mlb-photos/image/upload/.../v1/people/{playerId}/headshot/67/current` |
| Batter / pitcher season inputs for the forecast | `GET /api/v1/people/{playerId}/stats?stats=statcast,expectedStatistics,season,statSplits,gameLog&group=hitting&sitCodes=vl,vr&season=YYYY`; pitchers request `expectedStatistics,season,statSplits,gameLog` with `group=pitching` |
| Career head-to-head for the live forecast | `GET /api/v1/people/{batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId={pitcherId}` |

The live feed is the heart of it — one response contains everything Gameday shows:

```
liveData.plays.allPlays[]      → every at-bat: result, description, count, outs,
                                 batter/pitcher matchup, runner movement, pitch events
liveData.plays.currentPlay     → the at-bat happening RIGHT NOW (batter, pitcher, count)
liveData.linescore             → inning state, inning-by-inning runs/hits/errors
liveData.boxscore              → per-player batting & pitching lines, batting order
liveData.decisions             → winning/losing/saving pitcher
gameData.players / teams       → names, positions, records, venue, weather, status
```

The app polls `feed/live` every 5s while a game is in progress and only rebuilds the
DOM when the baseball state changes (count, pitch event, score, inning, or play). The
heavy box-score table is lazy-rendered only when its tab is open. Preview and final
games use slower cadences, and polling pauses automatically while the tab is hidden.

## Two-sided hit forecast

The hit percentage is a **transparent, per-plate-appearance estimate** — not an MLB
projection or a betting line. It is built to *discriminate*: great spots and terrible
spots land far apart instead of clustering around the league average. The model:

1. **Season level (both sides):** the batter's xBA/AVG hit-production signal and the
   pitcher's xBA-allowed/opponent-AVG signal are each regressed toward a `.245` league
   baseline (sample-based reliability), then compounded in log-odds space — a
   generalized **log5** (Bill James's odds-ratio method), so extreme signals push the
   estimate toward the extremes rather than canceling toward the mean.
2. **Platoon splits:** each player's real `vs LHP` / `vs RHP` (pitchers: `vs LHB` /
   `vs RHB`) split enters as a shrunken *differential* against their own season rate.
   Without split data, a small flat handedness adjustment is used instead.
3. **Recent form:** the player's game-log window (last ~8 games, never using games
   after the modeled game's date) nudges the estimate with a capped weight.
4. **Head-to-head:** the career batter/pitcher line is a strictly capped, small nudge.
5. **Same-game familiarity:** each repeat plate appearance against the same pitcher
   adds a small times-through-the-order bump (~+0.75 pts/pass, capped at the third look).
6. **Live count:** mid-at-bat, the fresh-count estimate is multiplied in odds space by
   an empirically anchored count factor (3-1 » 0-0 » 0-2); walks are *not* hits, so
   3-ball factors deliberately exclude the walk's value (see
   `tools/count-model-derivation.mjs` for the derivation and anchors).

The headline number is the **hit probability for this plate appearance**; the chance
of at least one more hit across the remaining expected plate appearances is shown as a
secondary projection. A **matchup tier** (Elite matchup / Favorable / Neutral / Tough /
Pitcher's edge) and per-driver **adjustment chips** (season, platoon, form, history,
familiarity, count — in percentage points) make every forecast explainable.

If one player has no usable season data, the forecast remains available but labels the
fallback (for example, “Batter input; pitcher baseline fallback”). If neither side has
data, it shows the league baseline instead of pretending the estimate is personalized.
The same cached model powers the live at-bat card, Props & Matchup tab, and PBP chips;
for archived games the request is scoped to the feed's game season.

## Project structure

```
.
├── index.html                 # Scoreboard page (all games for a date)
├── game.html                  # Game page (?gamePk=<id>)
├── 404.html
├── assets/
│   ├── css/style.css          # Dark Gameday-style theme (responsive)
│   └── js/
│       ├── api.js             # MLB StatsAPI client (fetch, retry, fallbacks, formatters)
│       ├── ui.js              # Shared UI: team logos, colors, count dots, runners diamond
│       ├── scoreboard.js      # Scoreboard page logic
│       ├── props.js           # Two-sided hit model, stat cache, Props & Matchup tab
│       └── game.js            # Game page logic (live "at bat" module, linescore, box, PBP)
└── docs/workflows/            # Optional GitHub Actions files (see deployment section)
```

## Run it locally

Any static file server works — no installs required:

```bash
# Python
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>. You can also open `index.html` directly in a browser
(`file://` works — the app uses plain scripts, no modules).

To run the deterministic, network-free model checks:

```bash
node tools/hit-model-test.mjs
```

## Deploy to GitHub Pages

The site is 100% static (repo root = site root), so GitHub Pages serves it directly
with no build step and no workflow permissions:

1. **Push this project to GitHub** (any repo — e.g. `yourname/MLB-Live-PBP`).
2. In the repo: **Settings → Pages → Source → "Deploy from a branch"** → branch
   `main` → folder `/ (root)` → **Save**.
3. Your site is live at **`https://<your-username>.github.io/<repo-name>/`** —
   e.g. `https://buffedlizard55-lab.github.io/MLB-Live-PBP/`. Every push to `main`
   republishes it automatically (takes ~1 minute).

### Optional: Actions-based deployment & CI smoke test

The repo's Pages setup doesn't require Actions. If you'd rather deploy via GitHub
Actions (and/or run the nightly API smoke test), ready-to-use workflow files are in
[`docs/workflows/`](docs/workflows/):

- `pages.yml` — deploys to Pages on every push to `main` (requires the repo setting
  **Pages → Source → "GitHub Actions"** instead of branch deployment).
- `smoke.yml` — runs the deterministic two-sided model checks and a nightly
  check that the upstream MLB StatsAPI still matches our parsers; run it anytime
  from **Actions** with "Run workflow".

To use them, copy the file contents into `.github/workflows/` in the repo (the GitHub
web UI's *Add file* is the easiest way), then go to **Settings → Pages → Source →
GitHub Actions**.

### Customizing

- **Season / league:** `SPORT_ID` in `assets/js/api.js` (1 = MLB). Minor-league IDs
  (11–14) also work.
- **Refresh rate:** `LIVE_POLL_MS`, `PREVIEW_POLL_MS`, and `FINAL_POLL_MS` in
  `assets/js/game.js`; `LIVE_POLL_MS` / `IDLE_POLL_MS` in `assets/js/scoreboard.js`.
- **Team colors:** `TEAM_COLORS` in `assets/js/ui.js`.

## Notes & etiquette

- The MLB StatsAPI is **unofficial and may change without notice**. The client is
  written defensively (fallbacks for every endpoint and missing fields) and the app
  degrades gracefully if a field disappears.
- Be a good citizen: polling every 10s for a handful of live games is well within
  normal usage, but avoid hammering — the code pauses when the tab is hidden and
  uses a quiet 30s cadence on the scoreboard.
- Team logos, headshots, and the underlying data are © MLB Advanced Media / MLB and
  their respective owners. This is an unofficial fan project — not affiliated with
  or endorsed by MLB.

## License

[MIT](LICENSE)
