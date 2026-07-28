# Release Readiness

ScriptLens now has a single readiness evaluator that turns the existing QA artifacts into an explicit go or no-go signal.

## Canary flow

1. Run the fast suite:

```bash
npm run ci:fast
```

2. Refresh the Defuddle canary corpus:

```bash
PW_HEADLESS=1 npm run qa:defuddle:backend:canary
```

3. Refresh the staged backend canary against the target backend:

```bash
SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL' npm run qa:canary
```

4. Evaluate readiness:

```bash
SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL' npm run release:readiness
```

This writes:

- `release/release-readiness-report.json`
- `release/release-readiness-report.md`

The canary gate fails when any of these regress:

- Defuddle honesty: transcript regressions, labeling issues, expectation mismatches
- staged canary expectations
- backend-good inline handoff behavior
- backend capability metadata for the target origin

## Public flow

Public release should also refresh the full staged consumer matrix:

```bash
SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL' npm run qa:staging
SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL' npm run release:readiness:public
```

The public gate adds stronger checks for:

- full staged QA expectation failures
- inline compactness regressions
- backend-good inline mismatches
- remote backend capability gaps

## Backend capability metadata

The readiness evaluator now reads backend `/version` and `/healthz` metadata when available.

That metadata includes:

- authenticated mode status
- `yt-dlp` availability and source
- ASR enablement and configuration state

This is how the gate distinguishes:

- a product regression
- a broken or under-provisioned backend
- a local-only dev environment

## Reading a failure

Common examples:

- `Defuddle corpus gate` failed:
  - the experiment changed transcript-class behavior or mislabeled direct content
- `Staged canary gate` failed:
  - the backend canary set drifted from expected winners or inline handoff regressed
- `Backend capability gate` failed:
  - the target backend is missing authenticated recovery, `yt-dlp`, or usable ASR configuration

Do not promote a build until the failed gate is explained or fixed.
