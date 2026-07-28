# Backend Recovery Plan Eng Review

Date: 2026-03-13

This document continues the transcript hardening work in the style of `gstack`'s
`plan-eng-review` workflow: challenge scope first, then lock architecture, code
quality, tests, failure modes, and rollout order.

## Step 0: Scope challenge

### What already exists

Existing code already covers most of the recovery pipeline:

- Local extension resolver:
  - caption-track
  - youtubei-transcript
  - dom-transcript
  - honest Defuddle direct-content fallback
- Backend resolver:
  - static watch-page caption extraction
  - backend youtubei command
  - `yt-dlp` caption fallback
  - headless transcript-panel fallback
  - bounded audio ASR fallback
- QA and debug tooling:
  - `scripts/debug-youtube-transcript.mjs`
  - `scripts/defuddle-video-qa.mjs`
  - checked-in public corpus and canary artifacts
- Deployment docs:
  - `release/CLOUD_RUN.md`
  - `release/STAGING_QA.md`
  - `release/TRANSCRIPT_HARDENING_SPEC.md`

The system does not need a new transcript subsystem. It needs the existing backend
paths to become materially stronger than the local fallback path.

### Minimum change that achieves the core goal

The minimum valuable change is:

1. Make backend `yt-dlp` discovery and capability reporting automatic.
2. Make backend-local QA use the strongest safe capability set available on the host.
3. Re-run the corpus and prove whether backend transcript wins become non-zero.

That is enough to answer the current product question:

"Can the backend rescue transcript-class results when the local YouTube path fails?"

### Complexity check

If this next phase touches more than these surfaces, it is probably overbuilt:

- `backend/resolve.js`
- `backend/server.js`
- `scripts/defuddle-video-qa.mjs`
- targeted backend tests
- backend docs

Recommendation: choose **scope reduction** first.

Do not start with cookie rotation UX, broader resolver rewrites, or new backend services.
First make the current backend capable, measurable, and comparable.

## Recommended execution mode

Recommendation: **small-change-first inside a bigger roadmap**.

Use four sequential slices:

1. Capability and observability
2. Hosted transcript recovery
3. Authenticated recovery
4. Bounded ASR

Each slice should be independently testable and should change corpus results in a way
the QA runner can measure.

## Architecture review

### Current pipeline

```text
popup:analyze
    |
    v
service worker
    |
    +--> local transcript resolver
    |      |
    |      +--> caption-track
    |      +--> youtubei-transcript
    |      +--> dom-transcript
    |      `--> fallback text
    |
    `--> optional backend transcript resolver
           |
           +--> static watch-page captions
           +--> backend youtubei
           +--> yt-dlp captions
           +--> headless transcript panel
           `--> audio ASR
```

### Desired pipeline

```text
local transcript miss
    |
    v
backend capability gate
    |
    +--> hosted transcript path available?
    |      |
    |      +--> yes -> run transcript stages in trust order
    |      `--> no  -> record explicit capability gap
    |
    +--> authenticated mode available?
    |      |
    |      +--> yes -> allow cookie-backed yt-dlp / browser session
    |      `--> no  -> stay anonymous and record that choice
    |
    `--> ASR allowed and supported?
           |
           +--> yes -> bounded final fallback
           `--> no  -> stop cleanly with transcript-class unavailable
```

### Proposed architecture slices

#### Slice A: Capability and observability

Goal: make the backend report what it can actually do before we judge outcomes.

Changes:

- auto-detect `yt-dlp` from:
  - explicit env/config
  - `PATH`
  - `python -m yt_dlp`
- expose capability metadata in backend health/version responses
- expose local-backend capability metadata in the QA report
- classify backend misses that are capability-driven vs YouTube-driven

Opinionated recommendation:

- Do this first.
- Keep it as a minimal diff inside the existing backend modules.
- Do not introduce a new "capabilities service".

#### Slice B: Hosted transcript recovery

Goal: make anonymous backend transcript recovery measurably stronger than local fallback.

Changes:

- ensure backend `yt-dlp` is actually exercised when present
- prefer transcript-class winners from:
  - static captions
  - backend youtubei
  - backend `yt-dlp`
  - headless transcript panel
- keep transcript contract unchanged

Opinionated recommendation:

- This is the make-or-break slice.
- If backend transcript wins stay at zero after Slice A and Slice B, do not move on to ASR.

#### Slice C: Authenticated recovery

Goal: improve the hard public-video set that anonymous retrieval cannot pass.

Changes:

- stage cookie-file mode for:
  - `yt-dlp`
  - browser-session headless fallback
- measure:
  - authenticated acquisition used
  - transcript-class wins added by auth
  - bot-gate failures reduced by auth

Opinionated recommendation:

- Stage-only first.
- Do not enable authenticated mode by default in local QA or public deployment.

#### Slice D: Bounded ASR

Goal: recover more content when transcript-class recovery is impossible, without lying
about trust.

Changes:

- enable ASR only when:
  - helper/runtime support exists
  - duration caps pass
  - circuit breaker is closed
- keep ASR visually reduced-trust in all reports and UI

Opinionated recommendation:

- This is a later slice, not the first answer to transcript failure.
- ASR should improve availability, not mask hosted transcript regressions.

## Code quality review

### Recommendation 1: reuse existing config points, do not add parallel ones

The repo already has the right integration seams:

- `resolveYtDlpCommandConfig(...)`
- `resolveAsrCommandConfig(...)`
- `resolveBackendRuntimeConfig(...)`
- `scripts/defuddle-video-qa.mjs` backend-local startup path

Do:

- strengthen these seams
- add capability detection near them
- thread results into existing reports

Do not:

- add a second backend-local implementation
- add special-case transcript logic only for the QA runner
- fork the backend pipeline for "local compare" vs "real backend"

### Recommendation 2: keep capability logic explicit

Use explicit capability states like:

- `ytDlpConfigured`
- `ytDlpAutoDetected`
- `asrHelperConfigured`
- `asrRuntimeSupported`
- `authenticatedModeConfigured`

Avoid implicit inference from error strings in five places.

### Recommendation 3: keep failure families stable

Local and backend diagnostics should roll up into a small number of stable codes:

- `youtubei_failed_precondition`
- `caption_fetch_failed`
- `yt_dlp_not_configured`
- `yt_dlp_failed`
- `backend_headless_transcript_failed_precondition`
- `asr_disabled`
- `asr_not_configured`
- `transport_error`

This keeps the QA runner readable and prevents report drift.

## Test review

### Test diagram

```text
                    +-----------------------------+
                    | transcript expected videos  |
                    +-----------------------------+
                      | local transcript win?
                      | backend transcript win?
                      | fallback only?
                      v
               release-significant transcript gate

                    +-----------------------------+
                    | direct-content candidates   |
                    +-----------------------------+
                      | control fallback only?
                      | defuddle direct win?
                      | backend changes outcome?
                      v
               honest fallback labeling gate

                    +-----------------------------+
                    | capability / config paths   |
                    +-----------------------------+
                      | yt-dlp explicit config
                      | yt-dlp auto-detected
                      | auth disabled / enabled
                      | ASR disabled / supported
                      v
               backend capability gate
```

### Tests required for the next slice

1. Backend resolver tests
   - auto-detect `yt-dlp` on `PATH`
   - auto-detect `python -m yt_dlp`
   - prefer explicit config over auto-detection
   - preserve transcript-class labeling on backend `yt-dlp` success

2. Backend server tests
   - `/healthz` and `/version` expose capability metadata
   - ASR-enabled metadata reflects both policy and runtime support

3. QA runner tests
   - backend-local report includes capability summary
   - backend-local compare distinguishes:
     - transcript rescue
     - capability gap
     - ordinary transcript miss

4. Corpus reruns
   - current 13-video canary
   - targeted transcript-rich subset
   - targeted hard-video subset

## Failure modes

### Failure mode matrix

```text
Codepath                     Failure                       Covered?  Error handling?  User-visible?
--------------------------   ---------------------------   --------  ---------------  -------------
static captions              200 empty / unreadable body   yes       yes              yes
backend youtubei             FAILED_PRECONDITION           yes       yes              yes
yt-dlp captions              tool missing                  partial   yes              yes
yt-dlp captions              bot gate / nonzero exit       yes       yes              yes
headless transcript panel    panel opens, no segments      yes       yes              yes
audio ASR                    helper missing                partial   yes              yes
audio ASR                    runtime import failure        partial   yes              yes
backend-local QA             tab/context race              yes       partial          yes
```

### Current critical gaps

1. Capability visibility gap
   - We often learn that `yt-dlp` or ASR was unavailable only after reading raw artifacts.
   - This is a planning/debugging gap, not a transcript-contract gap.

2. Hosted transcript parity gap
   - The backend can currently mirror the same `FAILED_PRECONDITION` family as local recovery.
   - Until `yt-dlp` or authenticated mode materially improves outcomes, backend rescue is not proven.

## Performance review

### Recommendation 1: capability probes must be cached or cheap

If the backend probes command availability on every request, keep it lightweight and local.
Avoid any network call in capability detection.

### Recommendation 2: do not widen headless retries yet

The current evidence says headless is failing for content reasons, not because retry count is too low.
Do not solve a request-shape problem with more expensive browser work.

### Recommendation 3: keep ASR bounded

Even after runtime support exists:

- keep short duration caps first
- keep the circuit breaker active
- keep CPU-friendly defaults

## NOT in scope

- Turning Defuddle output into transcript-class content
- Generic non-YouTube page support
- New extension UX for backend configuration
- New backend service or queueing system
- Cookie rotation automation
- Larger-model ASR tuning
- Full local-resolver rewrite before backend capability work is complete

## Files likely to change in the next implementation slice

- `backend/resolve.js`
- `backend/server.js`
- `scripts/defuddle-video-qa.mjs`
- `tests/backend-resolver.spec.js`
- `tests/backend-server.spec.js`
- `release/README.md`
- `release/CLOUD_RUN.md`

## Proposed implementation order

1. Add backend capability detection and health metadata.
2. Add `yt-dlp` auto-discovery with tests.
3. Thread capability info into backend-local QA reports.
4. Re-run:
   - one transcript-rich smoke
   - one backend-needed smoke
   - full canary
5. Only if backend transcript wins are still zero:
   - stage authenticated mode
6. Only after authenticated transcript recovery is measured:
   - turn on bounded ASR experiments

## Completion summary

- Step 0: Scope challenge
  - recommendation: scope reduction first
- Architecture review
  - main issue: backend capability is weaker than expected, not absent logic
- Code quality review
  - main issue: capability state is too implicit
- Test review
  - diagram produced
  - main gap: no strong automated proof that auto-detected hosted tools change corpus outcomes
- Performance review
  - main issue: do not spend more browser time before capability gaps are fixed
- NOT in scope
  - written
- What already exists
  - written
- Failure modes
  - critical gaps identified
