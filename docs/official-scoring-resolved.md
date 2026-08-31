# Official Scorer Pending Rulings - Resolved Description Implementation

**Date:** 2026-08-30  
**Status:** ✅ Fully Implemented and Tested  
**Requirement:** Track official scoring pending plays and display the actual ruling result when resolved.

## Summary

The MLB Live PBP system **already tracked official scoring pending rulings** (hit vs. error vs. fielder's choice undecided) from the MLB StatsAPI event types `os_ruling_pending_primary` and `os_ruling_pending_prior`. However, it only showed:
- "Official Scorer Ruling Pending" when active
- "Ruling Complete" when resolved

**What was missing:** The actual ruling result (e.g., "reaches on a fielder's choice") was not captured or displayed.

**What was implemented:** The system now captures and displays the official resolved description from the play's `result.description` field when the pending marker clears.

## User Requirement (Verbatim)

> Track any official scoring pending plays. The official scoring pending plays are recorded when the official scorer is unable to make a ruling on whether a ball hit is a error, single, fielders choice, etc those kinds of plays. I want to know immediately when that a play in every mlb game has an official scoring pending and add that to the section in replay feed all games and include it into the sound alert system. For example, it's a ground ball, but sometimes the play is too close to call and they need a second to review how to score it such as an error or hit. The official scorer ruling pending should also resolve to the result of the scoring decision once it has been finalized or ruled upon, it should say what the result is. For example harry ford reaches on a ground ball, it resolved as harry ford reaches on a fielder's choice. We should track both the official scorer pending result and also the result of the official scorer.

## Implementation Details

### Changes Made

#### 1. `assets/js/reviews.js`

**Added:** `playsByAtBatIndex` map to `extractReviews()` return value
- Builds a Map of all plays keyed by `atBatIndex`
- Allows lookup of resolved plays when pending markers clear
- Line: ~1160

**Modified:** `buildPendingScoringEntry()` 
- No changes needed (already creates entries with `officialScoringPending: true`)

#### 2. `assets/js/reviews-feed.js`

**Modified:** `completePendingScoringReview()` function
- Now accepts a second parameter: `resolvedPlay`
- Extracts the resolved description from `resolvedPlay.result.description` or `resolvedPlay.result.event`
- Stores it in a new field: `resolvedDescription`
- Preserves any existing `resolvedDescription` to avoid losing data
- Lines: ~205-230

**Modified:** `mergeFeedEvents()` function
- Now accepts a fourth parameter: `playsByAtBatIndex`
- When a pending scoring entry disappears (marker cleared), looks up the resolved play using `playsByAtBatIndex.get(String(atBatIndex))`
- Passes the resolved play to `completePendingScoringReview()`
- Lines: ~241-310

**Modified:** `reviewChanged()` function
- Now also checks for changes in `resolvedDescription`
- Line: ~218

**Modified:** `ingestGame()` function
- Passes `reviewData.playsByAtBatIndex` to `mergeFeedEvents()`
- Line: ~1488

**Modified:** `feedRow()` function
- Added display of `resolvedDescription` for pending_scoring entries
- Shows as: "Resolved as: [description]"
- Lines: ~1868-1873

#### 3. `assets/css/style.css`

**Added:** Styling for `.feed-resolved` and `.review-resolved-text`
- Green accent color (#a7f3d0)
- Italic font style
- Left border indicator
- Lines: ~1799-1806, ~1502-1509

#### 4. `assets/js/reviews.js` (UI)

**Modified:** `renderReviewCard()` function
- Added display of `resolvedDescription` for pending_scoring entries in the game page's Reviews tab
- Lines: ~870-874

### Data Flow

1. **Detection:** `extractReviews()` scans all plays and detects `os_ruling_pending_primary` or `os_ruling_pending_prior` event types
2. **Tracking:** Creates a pending entry with `officialScoringPending: true` and stores the pending description
3. **Resolution Detection:** When the pending marker disappears from the API payload:
   - `mergeFeedEvents()` detects the entry is missing from the current reviews
   - Looks up the play in `playsByAtBatIndex` using the `atBatIndex`
   - Extracts the resolved description from `play.result.description`
   - Updates the pending entry with `resolvedDescription` and marks it as resolved
4. **Display:** The feed row shows both:
   - Original pending description (e.g., "Official Scorer Ruling Pending")
   - Resolved description (e.g., "Anthony Seigler reaches on a fielder's choice")

### Example Output

**Before (Pending):**
```
⚖️ Official Scoring Pending
Batting: DET
▲ Top 3
⚡ Ruling Pending
Official scorer ruling pending (primary plate-appearance ruling)
```

**After (Resolved):**
```
⚖️ Official Scorer Ruling
Batting: DET
▲ Top 3
✓ Ruling Complete
Official scorer ruling pending (primary plate-appearance ruling)
Resolved as: Anthony Seigler reaches on a fielder's choice
```

### Verification

All existing tests pass:
- ✅ `tools/official-scoring-test.mjs` - Updated with new tests for resolved description
- ✅ `tools/reviews-feed-test.mjs` - All existing tests pass
- ✅ `tools/review-test.mjs` - All existing tests pass
- ✅ `tools/replay-feed-render-test.mjs` - All existing tests pass

New test coverage:
- Extracting `playsByAtBatIndex` from `extractReviews()`
- Passing `playsByAtBatIndex` to `mergeFeedEvents()`
- Capturing resolved description when pending marker clears
- Preserving resolved description across polls

### Source Verification

All implementation details verified against:
- **MLB StatsAPI Event Types Registry** (`GET /api/v1/eventTypes`):
  - `os_ruling_pending_primary` - plateAppearance: true
  - `os_ruling_pending_prior` - baseRunningEvent: true
  - Both have description: "Official Scorer Ruling Pending"

- **Live API Shapes** (verified 2026-08-19/2026-08-30):
  - `play.result.description` contains the official play description
  - `play.about.atBatIndex` uniquely identifies each plate appearance
  - `playEvents[].details.eventType` carries the pending marker

### No Manual Input

✅ **Fully automatic** - No manual input required
✅ **No hallucinations** - All data comes directly from official StatsAPI payloads
✅ **No guessing** - Resolved description is the exact text from `result.description`
✅ **Line-by-line verified** - Every field access is documented and tested

### Sound Alert System

✅ **Already integrated** - Pending scoring rulings trigger the existing sound alert:
- `shouldAlertForReview()` returns `true` for `typeKey === 'pending_scoring'`
- Alert fires immediately when a pending ruling is detected
- Only ABS challenges (`typeKey === 'abs'`) are excluded from alerts

### Flagged for Review

None. The implementation:
1. Uses only official StatsAPI fields
2. Never fabricates or predicts data
3. Preserves all existing functionality
4. Passes all existing tests
5. Adds new deterministic test coverage

## Files Modified

1. `assets/js/reviews.js` - Added `playsByAtBatIndex` to return value, added resolved description display in cards
2. `assets/js/reviews-feed.js` - Modified `completePendingScoringReview()`, `mergeFeedEvents()`, `reviewChanged()`, `ingestGame()`, `feedRow()`
3. `assets/css/style.css` - Added styling for resolved descriptions
4. `tools/official-scoring-test.mjs` - Added tests for resolved description functionality

## Backward Compatibility

✅ **Fully backward compatible:**
- `playsByAtBatIndex` is a new optional parameter to `mergeFeedEvents()`
- `resolvedPlay` is a new optional parameter to `completePendingScoringReview()`
- If not provided, the functions work as before (just without the resolved description)
- Existing code that doesn't pass these parameters continues to work
