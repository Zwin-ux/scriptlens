# Defuddle Video QA

Use this runbook to compare the shipped transcript-first path against the flagged Defuddle experiment on real YouTube watch pages.

The checked-in matrix lives at:

- `release/defuddle-video-matrix.json`

The runner builds two unpacked variants:

- `control`: `enableDefuddleExperiment: false`
- `defuddle`: `enableDefuddleExperiment: true`

Both variants analyze the same watch pages through the popup `popup:analyze` runtime flow so the report data comes from the real normalized service-worker contract.

When you enable backend compare, the runner adds two more runtime variants on top of those same builds:

- `backend-control`: control build with `allowBackendTranscriptFallback: true`
- `backend-defuddle`: Defuddle build with `allowBackendTranscriptFallback: true`

## 1. Install the browser runtime

```bash
npx playwright install chromium
```

## 2. Run the canary subset

```bash
PW_HEADLESS=1 npm run qa:defuddle:canary
```

This is the quickest gate before a wider pass. It writes:

- `release/defuddle-video-report.json`
- `release/defuddle-video-report.md`

## 3. Run the full matrix

```bash
PW_HEADLESS=1 npm run qa:defuddle
```

Useful filters:

```bash
PW_HEADLESS=1 node scripts/defuddle-video-qa.mjs --limit 5
PW_HEADLESS=1 node scripts/defuddle-video-qa.mjs --ids 01-ted-your-body-language-may-s,37-ifc-films-good-boy-official-traile
PW_HEADLESS=1 node scripts/defuddle-video-qa.mjs --category trailer
```

Backend compare with the runner's in-process local backend:

```bash
PW_HEADLESS=1 npm run qa:defuddle:backend:canary
```

Equivalent direct CLI:

```bash
PW_HEADLESS=1 node scripts/defuddle-video-qa.mjs \
  --canary-only \
  --include-backend \
  --backend-local
```

If you need to compare against a separately hosted endpoint instead:

```bash
PW_HEADLESS=1 node scripts/defuddle-video-qa.mjs \
  --canary-only \
  --include-backend \
  --backend-endpoint https://<origin>/transcript/resolve
```

## 4. What to look for

- Transcript-available videos should stay transcript-class in both variants.
- Defuddle wins should appear only as direct content, never as recovered transcript copy.
- Control failures that become clean direct-content results under the Defuddle variant are the primary experiment wins.
- Any case where the control variant is transcript-class and the Defuddle variant drops to non-transcript content is a regression.

## 5. Report fields

The JSON and Markdown reports summarize:

- `ok` and latency per variant
- acquisition kind, source label, strategy, and quality
- contract snapshot fields such as `originKind`, `recoveryTier`, `sourceTrustTier`, and `winnerReason`
- Defuddle extractor metadata including warnings and durations
- normalized failure families such as `youtubei_failed_precondition` and `weak_fallback_only`
- expectation checks derived from `expectedWinnerClass`, `expectedLocalBehavior`, `expectedBackendBehavior`, and `expectedDefuddleBehavior`
- changed outcomes, Defuddle direct wins, transcript regressions, backend rescues, and labeling issues

## 6. Matrix expectation fields

The checked-in matrix now supports these fields per entry:

- `expectedWinnerClass`
- `expectedLocalBehavior`
- `expectedBackendBehavior`
- `expectedDefuddleBehavior`

Current semantics:

- `transcript-class`: the winning acquisition should stay a real transcript result
- `direct-or-fallback`: direct content is preferred, but a fallback-text-only result is still acceptable for that variant
- `transcript-or-direct-or-fallback`: used for backend-tolerant cases where a recovered transcript is fine, but honest direct/fallback content is still acceptable

These are used only for QA reporting. They do not change product behavior.

## 7. Debug a single transcript failure

Use the transcript probe when a video shows `caption_fetch_failed`, `youtubei_http_403`, or a persistent title/description fallback:

```bash
PW_HEADLESS=1 npm run debug:youtube-transcript -- \
  --url https://www.youtube.com/watch?v=Ks-_Mh1QhMc \
  --out release/ted-transcript-debug.json
```

The debug report captures:

- bootstrap transcript signals such as `captionTrackCount`, `defaultTrackBaseUrl`, and transcript-panel continuation presence
- page-origin `timedtext` fetch behavior across `default`, `json3`, `srv3`, and `vtt`
- a direct bootstrap `youtubei/v1/get_transcript` POST using the page's own params
- the internal `ytd-app.resolveCommand(...)` transcript continuation path
- decoded request metadata for `get_transcript`, including whether YouTube used attestation, click tracking, visitor data, and extra body fields beyond `{ context, params }`

Current dated findings from this probe live in:

- `release/YOUTUBE_TRANSCRIPT_DEBUG_FINDINGS.md`

The broader next-phase execution plan lives in:

- `release/TRANSCRIPT_HARDENING_SPEC.md`
