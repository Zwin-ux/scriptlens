# Releasing ScriptLens

ScriptLens ships as a local-only Chrome extension. There is no backend to deploy: transcripts are read from YouTube and scored inside the extension.

## Release checklist

1. Run the deterministic gate from `ai-script-detector/`:

   ```bash
   npm run ci:fast
   ```

2. Build and package the store zip, pointing `homepage_url` at the public site:

   ```bash
   SCRIPTLENS_PUBLIC_SITE_ORIGIN=https://synergyaiscript.up.railway.app npm run package:extension
   ```

   The zip is written to `dist/packages/scriptlens-youtube-v<version>.zip`.

3. Load `dist/chrome-unpacked` in Chrome and check a few real videos by hand on a normal home network (YouTube often CAPTCHAs datacenter and CI IPs):
   - a video with manual captions
   - a video with only auto-generated captions
   - a video with no captions (should report the transcript as unavailable)
   - navigate between videos without reloading and confirm the card resets

4. Confirm the privacy policy, support page, and `store-assets/store-listing.md` still match the shipped behavior.

5. Capture screenshots per `store-assets/screenshot-checklist.md` and upload the zip in the Chrome Web Store developer dashboard.

## Related notes

- Shared report contracts: `CONTRACTS.md`
- Runtime debugging: `DEBUGGING.md`
- Public site hosting: `RAILWAY.md`
- YouTube transcript investigation notes: `YOUTUBE_TRANSCRIPT_DEBUG_FINDINGS.md`
