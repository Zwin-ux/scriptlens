# Optional Recovery Backend

The Chrome Web Store package for ScriptLens does not include the recovery backend. The backend is an advanced companion service for stronger transcript recovery on videos where local YouTube transcript paths do not return enough usable text.

## What the backend is for

- Recover transcript or caption text when local watch-page transcript paths are weak or unavailable
- Run deeper transcript-class recovery with `yt-dlp`, watch-page extraction, and headless recovery when configured
- Optionally run audio-to-ASR recovery under backend policy limits
- Provide a hosted or self-hosted HTTP endpoint for the extension

## Automatic ASR fallback

ScriptLens now supports bounded audio-derived fallback as the final recovery tier when
transcript and caption recovery miss.

Default backend behavior:

- transcript and caption recovery still run first
- automatic ASR is off unless `SCRIPTLENS_BACKEND_ENABLE_ASR=true`
- ASR stays bounded by backend policy limits, duration caps, rate limits, and the ASR circuit breaker
- audio-derived results are always labeled as reduced trust in the extension UI

The default open-source ASR helper is:

- `backend/asr-faster-whisper.py`

It expects:

- `ffmpeg`
- Python 3
- `faster-whisper`

The Cloud Run container now installs those dependencies. The helper reads these env vars:

- `SCRIPTLENS_BACKEND_ASR_MODEL`
- `SCRIPTLENS_BACKEND_ASR_DEVICE`
- `SCRIPTLENS_BACKEND_ASR_COMPUTE_TYPE`
- `SCRIPTLENS_BACKEND_ASR_BEAM_SIZE`
- `SCRIPTLENS_BACKEND_ASR_VAD_FILTER`

If you prefer a different ASR engine, set:

- `SCRIPTLENS_BACKEND_ASR_COMMAND`
- optionally `SCRIPTLENS_BACKEND_ASR_ARGS_JSON`

The command must emit ScriptLens-compatible JSON with `text`, `segments`, and language fields.

## What the backend receives

When the extension uses the recovery backend, it sends only:

- the YouTube video ID
- the requested language, if one is selected

The backend is still optional. ScriptLens works in local-only mode when no backend is configured.

For Google Cloud Run deployment, use `release/CLOUD_RUN.md`.

For staged consumer QA and daily canary checks, use `release/STAGING_QA.md`.

For the explicit go/no-go evaluator across Defuddle QA, staged QA, and backend capability metadata, use `release/RELEASE_READINESS.md`.

For shared runtime and report contracts, use `release/CONTRACTS.md`.

For the next-phase transcript recovery and Defuddle hardening plan, use `release/TRANSCRIPT_HARDENING_SPEC.md`.

For the detailed engineering review of the next backend recovery slice, use `release/BACKEND_RECOVERY_PLAN_ENG_REVIEW.md`.

For release gates, cookie rotation, and canary promotion rules, use `release/OPERATIONS.md`.

## Windows self-host setup

1. Install `yt-dlp` for your user profile:
   - `python -m pip install --user yt-dlp`
2. Set the persistent `yt-dlp` path for future terminals:
   - `[Environment]::SetEnvironmentVariable("SCRIPTLENS_YTDLP_COMMAND", "$env:APPDATA\\Python\\Python311\\Scripts\\yt-dlp.exe", "User")`
3. Open a new terminal and start the backend:
   - `npm.cmd run backend:start`
4. Package the extension with your backend endpoint and origin:
   - `$env:SCRIPTLENS_BACKEND_ENDPOINT='https://your-recovery-service.example/transcript/resolve'`
   - `$env:SCRIPTLENS_BACKEND_ORIGIN='https://your-recovery-service.example'`
   - `npm.cmd run build:extension`

If you prefer Python module execution instead of a direct executable, use `SCRIPTLENS_YTDLP_PYTHONPATH` and optionally `SCRIPTLENS_YTDLP_PYTHON`.

## Release note

Keep this backend documentation outside the Chrome Web Store upload zip. The backend is a separate advanced deployment path, not part of the extension runtime package.
