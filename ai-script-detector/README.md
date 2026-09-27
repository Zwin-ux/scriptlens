# ScriptLens

Open-source Chrome extension for transcript-first YouTube analysis.

ScriptLens is a Manifest V3 Chrome extension focused on one job: analyze the writing style of desktop YouTube video transcripts for AI-like patterns. The store-facing release is YouTube-only, inline-first, and runs entirely on your device.

## What ships in the Chrome Web Store build

- A one-click inline `Analyze video` button on desktop `youtube.com/watch` pages
- A verdict-first inline result card with score, explanation, transcript quality, and an optional details drawer
- A toolbar popup and side-panel workspace for advanced transcript controls and deeper report breakdowns

## Product scope

- Supported: desktop `https://www.youtube.com/watch?...`
- Not supported in the store build: Shorts, `m.youtube.com`, generic page analysis, manual text analysis, or selection/page capture flows

## Open source

- License: [MIT](../LICENSE)
- Public repository: `https://github.com/Zwin-ux/scriptlens`

## Runtime notes

- Local-only: transcripts are read from YouTube and scored inside the extension with deterministic heuristics
- ScriptLens has no backend; the only network requests go to `https://www.youtube.com` for the active video's captions
- The extension is transcript-first by default
- Title and description fallback only happens when the user explicitly allows it
- Videos without a usable YouTube transcript are reported as unavailable rather than guessed

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

## Development commands

- Install dependencies: `npm install`
- Run the deterministic CI gate: `npm run ci:fast`
- Run the full Playwright suite: `npm run test:e2e`
- Run the YouTube smoke suite (needs a network that YouTube does not CAPTCHA): `npm run test:e2e:youtube`
- Build an unpacked release staging directory: `npm run build:extension`
- Build the Chrome Web Store zip: `npm run package:extension`

Release artifacts are written to `dist/chrome-unpacked` and `dist/packages`.

To run the browser specs against an already-installed Chromium instead of the one Playwright pins, set `PW_CHROMIUM_EXECUTABLE=/path/to/chrome`.

## Store and release assets

- Public site overview: `docs/index.html`
- Privacy policy: `docs/privacy.html`
- Support page: `docs/support.html`
- Store listing source text: `store-assets/store-listing.md`
- Screenshot checklist: `store-assets/screenshot-checklist.md`

The public site is served from Railway at `https://synergyaiscript.up.railway.app`. Set `SCRIPTLENS_PUBLIC_SITE_ORIGIN` before packaging a release so `homepage_url` in the built manifest points at the live public site.

## Permissions

- `storage` for settings and recent report summaries
- `sidePanel` for the advanced workspace
- Host access limited to `https://www.youtube.com/*`

## Validation focus

- Inline analyze stays inline until the user chooses `Open full workspace`
- Transcript quality and result confidence stay clearly separated
- Fallback text is labeled honestly and only used when explicitly enabled
- The release zip contains only extension runtime assets
- Privacy/support docs match the shipped behavior exactly
