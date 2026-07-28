# Transcript Hardening Spec

Date: 2026-03-13

This spec defines the next phase after the Defuddle experiment and the March 13, 2026 transcript probe findings.

## Problem statement

The current product question is no longer "is Defuddle wired correctly?" The stronger question is "what path gives the most accurate transcript-class result without lying about provenance?"

Current evidence from `release/YOUTUBE_TRANSCRIPT_DEBUG_FINDINGS.md`:

- transcript discovery on public YouTube watch pages is often strong
- local transcript retrieval in headless Chromium is weak
- `api/timedtext` returns `200` with empty bodies in the checked cases
- bootstrap `youtubei` transcript POSTs return `400 FAILED_PRECONDITION`
- YouTube's own internal transcript continuation also returns `400 FAILED_PRECONDITION` in the checked headless environment
- Defuddle is behaving as an honest direct-content fallback, not a transcript improvement path

This means the next phase should optimize for:

- transcript accuracy first
- honest source labeling
- release confidence based on corpus evidence, not isolated manual checks

## Goals

- Restore or clearly bound transcript-class recovery for transcript-rich YouTube videos.
- Separate transcript recovery work from direct-content fallback work.
- Measure the difference between real-user Chrome behavior and headless QA behavior.
- Use the existing backend resolver as the reliability path when local transcript recovery is weak.
- Keep Defuddle as honest direct content only.

## Non-goals

- Do not turn Defuddle output into a transcript.
- Do not widen the backend transcript contract to accept page-content extraction.
- Do not expand product scope beyond YouTube in this phase.
- Do not spend more time on speculative `timedtext` parsing changes until runtime evidence justifies it.

## Product position

There are now three distinct source classes:

1. Transcript-class
   - local transcript/caption recovery
   - backend transcript recovery
2. Direct-content class
   - Defuddle page extraction
   - visible page extraction
3. Weak fallback class
   - title + description only

The system should prefer them in that order and preserve that distinction in every report and surface.

## Phase 1: Prove the environment boundary

### Objective

Determine whether the current YouTube transcript failures are:

- headless-only
- Chromium-only
- general local-browser failures

### Work

1. Run the new probe script in headed Chromium on the existing canary corpus.
2. Run it on at least:
   - the TED talk corpus case
   - the 3Blue1Brown corpus case
   - one likely auto-caption vlog case
   - one livestream archive case
3. Save probe artifacts under `release/` with stable names.
4. Record the result pattern for each environment:
   - `headless chromium`
   - `headed chromium`
   - optional manual Chrome extension run if needed

### Commands

```bash
PW_HEADLESS=0 npm run debug:youtube-transcript -- \
  --url https://www.youtube.com/watch?v=Ks-_Mh1QhMc \
  --out release/ted-transcript-debug-headed.json

PW_HEADLESS=0 npm run debug:youtube-transcript -- \
  --url https://www.youtube.com/watch?v=aircAruvnKk \
  --out release/3b1b-transcript-debug-headed.json
```

### Success criteria

- We can say with evidence whether transcript failure is tied to headless execution.
- We have at least four headed probe artifacts.

### Decision

- If headed/manual Chrome succeeds where headless fails:
  - treat this as an environment-specific QA limitation
  - stop trying to "fix" local transcript recovery using only headless evidence
  - keep the corpus runner, but evaluate transcript accuracy with headed validation and backend canary evidence
- If headed/manual Chrome fails too:
  - treat local transcript recovery as a real product problem
  - continue to Phase 2 and Phase 3 aggressively

## Phase 2: Make backend recovery the accuracy path

### Objective

Use the existing transcript-only backend as the best-accuracy recovery path after local transcript failure.

### Why

The backend is already designed for transcript-class recovery and can operate with authenticated session state and stronger recovery methods. Defuddle cannot replace that role honestly.

### Work

1. Run the video QA corpus with backend transcript fallback enabled.
2. Add a compare mode to the corpus runner if needed:
   - local-only
   - local + backend
   - local + backend + Defuddle
3. For each corpus entry, classify the actual winner as:
   - `local transcript`
   - `backend transcript`
   - `defuddle direct`
   - `title-description fallback`
4. Extend the report summary to count:
   - local transcript wins
   - backend transcript wins
   - direct-content wins
   - weak fallbacks
5. Treat backend transcript wins as desirable when local transcript recovery is unavailable.

### Required code/workflow changes

- Add a corpus-run option to enable backend settings at runtime.
- Preserve transcript-only labeling for backend wins.
- Preserve direct-content labeling for Defuddle wins.
- Add explicit report counters so backend improvements are visible without manual diffing.

### Success criteria

- Transcript-rich videos no longer collapse mostly to title-description fallback when backend recovery is available.
- Backend transcript wins are correctly labeled and surfaced as transcript-class.
- No Defuddle direct-content result is mislabeled as a recovered transcript.

## Phase 3: Harden local transcript diagnostics, not guesswork

### Objective

Make local transcript failures explainable at a per-strategy level.

### Work

1. Keep the new corpus diagnostics in `scripts/defuddle-video-qa.mjs`.
2. Add normalized failure codes for the observed classes:
   - `timedtext_empty_200`
   - `youtubei_failed_precondition`
   - `youtubei_http_403`
   - `dom_transcript_panel_opened_no_segments`
   - `dom_transcript_panel_hidden_after_show`
3. Preserve attempt-level resolver data in QA outputs.
4. Promote those failure codes into the service-worker report only where they help debugging and do not bloat user-facing UI.

### Acceptance criteria

- Every transcript miss in the QA corpus is attributable to a specific failure family.
- We can separate:
  - transport failures
  - request-shape failures
  - UI materialization failures
  - genuine transcript-unavailable pages

## Phase 4: Improve the corpus and gates

### Objective

Make release decisions corpus-based.

### Work

1. Keep `release/defuddle-video-matrix.json` as the canonical public corpus.
2. Add expected fields for release gating:
   - `expectedWinnerClass`
   - `expectedLocalBehavior`
   - `expectedBackendBehavior`
   - `expectedDefuddleBehavior`
3. Split the matrix into release-significant buckets:
   - stable transcript-rich
   - backend-needed
   - Defuddle direct-content candidates
   - known weak-fallback cases
4. Update reports so the top-line questions are visible immediately:
   - How many transcript-rich pages stayed transcript-class?
   - How many pages required backend rescue?
   - How many honest Defuddle wins occurred?
   - How many weak fallbacks remain?
5. Add a minimum release corpus size:
   - `30+` public URLs
   - at least `10` stable transcript-rich pages
   - at least `5` likely backend-needed pages
   - at least `5` direct-content candidates

### Release gate thresholds

For a canary promotion:

- `0` labeling regressions
- `0` transcript-to-direct regressions on stable transcript-rich pages
- strong transcript-class recovery on the stable transcript-rich subset
- no unexplained spike in weak fallback results

For public release:

- multiple consecutive healthy canary runs
- stable transcript-rich pages consistently transcript-class
- backend-needed pages mostly rescued by backend when backend is enabled
- Defuddle wins remain honest direct-content wins only

## Phase 5: Defuddle polish

### Objective

Keep Defuddle useful without paying unnecessary cost on the common path.

### Work

1. Lazy-load Defuddle instead of injecting the full runtime on every YouTube page.
2. Keep the feature flag off by default until transcript recovery gates are healthy.
3. Preserve extractor metadata in reports and QA artifacts.
4. Keep Defuddle fallback constrained to:
   - transcript failure
   - fallback text allowed
   - experiment enabled

### Acceptance criteria

- Common-path YouTube page load is cleaner when the experiment is off.
- Defuddle still improves the designated fallback cases.
- No transcript taxonomy fields are assigned to direct-content results.

## Phase 6: Release policy

### Internal / canary

Allowed once:

- the corpus tooling is stable
- the headed-vs-headless question is answered
- backend-vs-local behavior is measurable
- Defuddle labeling remains correct

### Public

Allowed only once:

- the transcript-rich corpus is consistently transcript-class
- the remaining misses are explainable and acceptable
- Defuddle no longer adds avoidable overhead to the common path
- the backend path is operationally healthy if it is part of the release promise

## Immediate implementation order

This is the recommended next execution sequence:

1. Run headed probe artifacts for the core canary set.
2. Extend the corpus runner to compare local-only vs local+backend.
3. Add normalized failure-family codes to QA output.
4. Update the matrix schema with expected winner classes.
5. Re-run canary and full corpus.
6. Only then decide whether local transcript resolver changes are still justified.
7. After transcript confidence is back, lazy-load Defuddle.

## Practical definition of "best"

In this phase, "best" should mean:

- the most accurate transcript source wins when transcript material exists
- weaker sources are still usable but honestly labeled
- the system falls back gracefully without pretending page extraction is speech transcription
- release decisions come from repeatable corpus evidence, not one-off anecdotes
