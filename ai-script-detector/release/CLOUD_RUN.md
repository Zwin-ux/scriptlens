# Cloud Run Backend Deployment

This guide packages the ScriptLens recovery backend as a container and deploys it to Google Cloud Run.

## Launch defaults

- Automatic ASR is disabled by default in the container image
- Transcript, caption, `yt-dlp`, and headless recovery stay enabled
- The image now includes `ffmpeg`, Python 3, `yt-dlp`, and `faster-whisper`
- Health and version probes are available at:
  - `/healthz`
  - `/version`

## Prerequisites

- Google Cloud project with billing enabled
- `Cloud Run Admin API`, `Artifact Registry API`, and `Cloud Build API` enabled
- A Docker Artifact Registry repository such as `scriptlens-backend`
- Local tools:
  - `gcloud`
  - `docker`

## 1. Authenticate Docker for Artifact Registry

```powershell
gcloud auth configure-docker us-west2-docker.pkg.dev
```

## 2. Build the backend container

From `ai-script-detector/`:

```powershell
docker build -t us-west2-docker.pkg.dev/YOUR_PROJECT_ID/scriptlens-backend/scriptlens-backend:latest .
```

## 3. Push the image

```powershell
docker push us-west2-docker.pkg.dev/YOUR_PROJECT_ID/scriptlens-backend/scriptlens-backend:latest
```

## 4. Deploy to Cloud Run

```powershell
gcloud run deploy scriptlens-backend `
  --image us-west2-docker.pkg.dev/YOUR_PROJECT_ID/scriptlens-backend/scriptlens-backend:latest `
  --region us-west2 `
  --platform managed `
  --allow-unauthenticated `
  --port 8080 `
  --memory 4Gi `
  --cpu 2 `
  --concurrency 1 `
  --timeout 120s `
  --set-env-vars SCRIPTLENS_BACKEND_ENABLE_ASR=false,SCRIPTLENS_BACKEND_TIMEOUT_MS=45000,SCRIPTLENS_BACKEND_TRANSCRIPT_TIMEOUT_MS=30000,SCRIPTLENS_BACKEND_STAGE_STATIC_MS=4000,SCRIPTLENS_BACKEND_STAGE_YOUTUBEI_MS=2500,SCRIPTLENS_BACKEND_STAGE_YTDLP_MS=12000,SCRIPTLENS_BACKEND_STAGE_HEADLESS_MS=15000,SCRIPTLENS_BACKEND_HEADLESS_NAVIGATION_TIMEOUT_MS=15000,SCRIPTLENS_BACKEND_HEADLESS_TRANSCRIPT_WAIT_MS=6000,SCRIPTLENS_BACKEND_HEADLESS_SETTLE_MS=1500,SCRIPTLENS_BACKEND_HEADLESS_EXTRA_ARGS=--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu,--no-zygote
```

Recommended launch posture:

- keep `SCRIPTLENS_BACKEND_ENABLE_ASR=false`
- use `2 CPU / 4 GiB` during staging hardening
- keep Cloud Run concurrency low at first
- verify transcript-class recovery before enabling ASR later

## 4a. ASR envs for a bounded rollout

When you are ready to improve consumer success rate with automatic fallback, turn ASR on
carefully instead of opening it globally without limits.

Recommended first ASR posture:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --update-env-vars SCRIPTLENS_BACKEND_ENABLE_ASR=true,SCRIPTLENS_BACKEND_STAGE_ASR_MS=30000,SCRIPTLENS_BACKEND_ASR_TIMEOUT_MS=90000,SCRIPTLENS_BACKEND_ASR_AUTO_MAX_SECONDS=2100,SCRIPTLENS_BACKEND_ASR_MANUAL_MAX_SECONDS=5400,SCRIPTLENS_BACKEND_ASR_ABSOLUTE_MAX_SECONDS=5400,SCRIPTLENS_BACKEND_ASR_MODEL=tiny.en,SCRIPTLENS_BACKEND_ASR_DEVICE=cpu,SCRIPTLENS_BACKEND_ASR_COMPUTE_TYPE=int8,SCRIPTLENS_BACKEND_ASR_BEAM_SIZE=1,SCRIPTLENS_BACKEND_ASR_VAD_FILTER=true
```

## 4b. Authenticated acquisition with Secret Manager

For the hardest public YouTube videos, anonymous transcript/audio acquisition can still be
bot-gated. ScriptLens now supports an operator-managed cookie file so the backend can run
authenticated `yt-dlp` and authenticated browser sessions without changing the extension UX.

Use a Netscape-format cookie file stored in Secret Manager. Keep this server-side only.

1. Create the secret from a local cookie file:

```powershell
gcloud secrets create youtube-cookie-file --replication-policy="automatic"
gcloud secrets versions add youtube-cookie-file --data-file="C:\path\to\youtube-cookies.txt"
```

2. Grant the Cloud Run runtime service account access:

```powershell
gcloud secrets add-iam-policy-binding youtube-cookie-file `
  --member="serviceAccount:YOUR_CLOUD_RUN_SERVICE_ACCOUNT" `
  --role="roles/secretmanager.secretAccessor"
```

3. Deploy or update the service with the secret mounted as a file:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --add-volume name=youtube-cookies-volume,type=secret,secret=youtube-cookie-file `
  --add-volume-mount volume=youtube-cookies-volume,mount-path=/secrets/youtube `
  --update-env-vars SCRIPTLENS_BACKEND_AUTH_MODE=cookie-file,SCRIPTLENS_BACKEND_YOUTUBE_COOKIE_FILE=/secrets/youtube/youtube-cookie-file,SCRIPTLENS_BACKEND_AUTH_USE_YTDLP=true,SCRIPTLENS_BACKEND_AUTH_USE_BROWSER_SESSION=true
```

Recommended staged posture:

- enable authenticated mode on a staging revision first
- keep ASR bounded even when authenticated mode is on
- never log or return cookie contents or cookie paths
- monitor whether `authenticatedAcquisitionUsed` materially improves success rate on the known hard-video set

If you need to disable authenticated acquisition quickly:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --update-env-vars SCRIPTLENS_BACKEND_AUTH_MODE=disabled
```

Notes:

- `tiny.en` is the safest first production model for latency, not the highest-quality one
- audio-derived results stay visibly reduced trust in the extension
- if Cloud Run starts to struggle, force ASR off without affecting transcript recovery:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --update-env-vars SCRIPTLENS_BACKEND_ASR_CIRCUIT_FORCED_OPEN=true
```

- if you want to disable ASR again entirely:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --update-env-vars SCRIPTLENS_BACKEND_ENABLE_ASR=false,SCRIPTLENS_BACKEND_ASR_CIRCUIT_FORCED_OPEN=false
```

## 5. Verify the service

After deploy, verify both routes:

```powershell
curl https://YOUR_CLOUD_RUN_URL/healthz
curl https://YOUR_CLOUD_RUN_URL/version
```

`/healthz` should return JSON with:

- `ok: true`
- `service: "scriptlens-backend"`
- `version`
- `asrEnabled: false`

## 6. Run the backend smoke check against the live endpoint

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run backend:smoke -- --require-success
```

The smoke script defaults to:

- `https://www.youtube.com/watch?v=NPY2NIS-iao`
- `https://www.youtube.com/watch?v=vWQk67meYUA`

For staged ASR validation:

```powershell
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run backend:smoke:asr -- --max-automatic-asr-duration-seconds 2100 --require-success
```

## 7. Build the Chrome extension against the deployed backend

```powershell
$env:SCRIPTLENS_BACKEND_ENDPOINT='https://YOUR_CLOUD_RUN_URL/transcript/resolve'
$env:SCRIPTLENS_BACKEND_ORIGIN='https://YOUR_CLOUD_RUN_URL'
npm.cmd run build:extension
npm.cmd run package:extension
```

## 8. Later ASR enablement

Do not enable ASR until transcript-class recovery is stable under staged traffic.

When ready:

```powershell
gcloud run services update scriptlens-backend `
  --region us-west2 `
  --set-env-vars SCRIPTLENS_BACKEND_ENABLE_ASR=true
```
