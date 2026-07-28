# Staged Consumer QA

This runbook keeps ScriptLens staging checks focused on the shipped watch-page flow:

- build the extension against the live backend
- verify the backend canary set
- run the full staged QA matrix when you need a release-grade pass

## 1. Build the staging candidate

```powershell
$env:SCRIPTLENS_BACKEND_ENDPOINT='https://YOUR_CLOUD_RUN_URL/transcript/resolve'
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run build:extension
npm.cmd run package:extension
```

The unpacked candidate is written to:

- `dist/chrome-unpacked`

The upload zip is written to:

- `dist/packages/scriptlens-youtube-v0.1.0.zip`

## 2. Run the daily backend canary

The canary uses the stable subset in `release/staging-video-matrix.json`.

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run qa:canary
```

This checks:

- caption-backed wins still return transcript-class success
- the long-duration policy cases still fail with the expected duration errors

If the canary fails, do not cut a new staging build until the mismatch is understood.

The canary writes:

- `release/staged-canary-report.json`
- `release/staged-canary-report.md`

## 3. Run the full staged QA pass

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run qa:staging
```

The runner writes:

- `release/staged-qa-report.json`
- `release/staged-qa-report.md`

The report includes:

- backend success or failure
- `originKind`
- `recoveryTier`
- `sourceTrustTier`
- `winnerReason`
- latency
- inline outcome
- compactness check
- workspace handoff result

After the backend canary or full staged pass finishes, evaluate the combined gate with:

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run release:readiness
```

For public release, use:

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run release:readiness:public
```

## 4. Cookie and auth-session health

Authenticated acquisition is now a real dependency for production recovery. Treat cookie health as
an operational concern, not a one-time setup step.

Healthy signs:

- canary caption-backed videos keep succeeding through `authenticated-yt-dlp-captions`
- `/version` returns `authenticatedModeEnabled: true`
- failures stay concentrated in known policy or quality-gate categories

Suspect the mounted cookie file first if:

- multiple stable canary videos suddenly move from `manual_caption_track` success to `yt_dlp_exit_nonzero`
- transcript recovery starts falling back to headless on every known-good canary
- the backend starts logging bot-gate behavior again for previously stable videos

When that happens:

1. rotate/export a fresh Netscape cookie file from the dedicated backend account
2. add a new Secret Manager version
3. redeploy the Cloud Run service or update the secret mount
4. rerun `npm.cmd run qa:canary`

## 5. Failure categories to watch during staging

Expected or acceptable in the current product:

- `asr_duration_limit`
- `asr_duration_absolute_limit`
- `sentence_structure_below_threshold`
- `word_count_below_threshold`
- `non_letter_noise`

Operational warnings that need attention before broader staging:

- `transport_error`
- `backend_timeout`
- `backend_http_*`
- `yt_dlp_exit_nonzero` on previously stable canaries
- `asr_rate_limited` during normal consumer-like single-video checks
- `asr_circuit_open` outside deliberate load-shedding

Product experience warnings to call out in QA:

- inline card times out instead of reaching a success or clear error card
- YouTube transcript panel opens automatically
- `Open full workspace` does not store a panel launch request
- an audio-derived success does not show the reduced-trust label

## 6. Current matrix source

The staged QA matrix lives in:

- `release/staging-video-matrix.json`

Keep it intentionally mixed:

- stable success canaries
- policy-limited long videos
- quality-gate failures
- hard public-video misses

That mix is what tells you whether ScriptLens still behaves honestly under real traffic.
