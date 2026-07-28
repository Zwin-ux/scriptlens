# ScriptLens

Open-source Chrome extension for transcript-first YouTube analysis.

ScriptLens is a Manifest V3 Chrome extension focused on one job: analyze the writing style of desktop YouTube video transcripts for AI-like patterns. The store-facing release is YouTube-only, inline-first, and local by default.

## What ships in the Chrome Web Store build

- A one-click inline `Analyze video` button on desktop `youtube.com/watch` pages
- A verdict-first inline result card with score, explanation, transcript quality, and an optional details drawer
- A toolbar popup and side-panel workspace for advanced transcript controls and deeper report breakdowns
- Optional transcript recovery through a compatible hosted or self-hosted backend

## Product scope

- Supported: desktop `https://www.youtube.com/watch?...`
- Not supported in the store build: Shorts, `m.youtube.com`, generic page analysis, manual text analysis, or selection/page capture flows

## Open source

- License: [MIT](../LICENSE)
- Public repository: `https://github.com/Zwin-ux/scriptlens`

## Runtime notes

- Scoring runs inside the extension with deterministic heuristics
- The extension is transcript-first by default
- Title and description fallback only happens when the user explicitly allows it
- If transcript recovery is used, ScriptLens sends only the YouTube video ID and requested language to the configured recovery backend

## Repository layout

```text
ai-script-detector/
  manifest.json
  content.js
  service-worker.js
  youtube-main.js
  youtube-overlay.js
  popup.*
  sidepanel.*
  detector/
  transcript/
  surface/
  utils/
  docs/
  release/
  scripts/
  store-assets/
  tests/
```

## Load unpacked in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `ai-script-detector` folder.

## Optional recovery backend

The production build can point at a hosted ScriptLens recovery service. Open-source deployments can also point the extension at a compatible self-hosted backend. The backend is not bundled into the Chrome Web Store package.

Cloud Run deployment notes live in `release/CLOUD_RUN.md`.

### Windows setup

1. Install `yt-dlp` for your user profile:
   - `python -m pip install --user yt-dlp`
2. Set the helper command for future terminals:
   - `[Environment]::SetEnvironmentVariable("SCRIPTLENS_YTDLP_COMMAND", "$env:APPDATA\\Python\\Python311\\Scripts\\yt-dlp.exe", "User")`
3. Open a new terminal and start the helper:
   - `npm.cmd run backend:start`
4. For a production package, set the hosted recovery endpoint before building:
   - `$env:SCRIPTLENS_BACKEND_ENDPOINT='https://your-recovery-service.example/transcript/resolve'`
   - `$env:SCRIPTLENS_BACKEND_ORIGIN='https://your-recovery-service.example'`

You can also use `SCRIPTLENS_YTDLP_PYTHONPATH` and `SCRIPTLENS_YTDLP_PYTHON` instead of `SCRIPTLENS_YTDLP_COMMAND`.

More backend notes live in `release/README.md`.
Cloud Run deployment steps live in `release/CLOUD_RUN.md`.
Shared interface notes live in `release/CONTRACTS.md`.
Release and auth runbooks live in `release/OPERATIONS.md`.

## Development commands

- Install dependencies:
  - `npm.cmd install`
- Start the optional self-hosted backend:
  - `npm.cmd run backend:start`
- Build the backend container locally:
  - `npm.cmd run backend:docker:build`
- Run the Playwright suite:
  - `npm.cmd run test:e2e`
- Run the YouTube smoke suite:
  - `npm.cmd run test:e2e:youtube`
- Run the deterministic CI gate locally:
  - `npm.cmd run ci:fast`
- Run the smoke gate locally:
  - `npm.cmd run ci:smoke`
- Build an unpacked release staging directory:
  - `npm.cmd run build:extension`
- Build the Chrome Web Store zip:
  - `npm.cmd run package:extension`

Release artifacts are written to `dist/chrome-unpacked` and `dist/packages`.

## Store and release assets

- Public site overview: `docs/index.html`
- Privacy policy: `docs/privacy.html`
- Support page: `docs/support.html`
- Store listing source text: `store-assets/store-listing.md`
- Screenshot checklist: `store-assets/screenshot-checklist.md`

The public site is intended to be served from Railway. Set `SCRIPTLENS_PUBLIC_SITE_ORIGIN` before packaging a release so `homepage_url` in the built manifest points at the live public site.

## Permissions

- `storage` for settings and recent report summaries
- `sidePanel` for the advanced workspace
- Host access limited to `https://www.youtube.com/*`
- Production hosted recovery requires a real backend origin during packaging so the build can request the correct host permission

## Validation focus

- Inline analyze stays inline until the user chooses `Open full workspace`
- Transcript quality and result confidence stay clearly separated
- Fallback text is labeled honestly and only used when explicitly enabled
- The release zip contains only extension runtime assets
- Privacy/support docs match the shipped behavior exactly
- Backend-good results should always map to inline-good results before any release candidate is promoted
