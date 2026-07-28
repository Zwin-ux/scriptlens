# YouTube Transcript Debug Findings

Date: 2026-03-13

These findings came from the Playwright transcript probe in `scripts/debug-youtube-transcript.mjs`.

## Videos checked

- `https://www.youtube.com/watch?v=Ks-_Mh1QhMc`
- `https://www.youtube.com/watch?v=aircAruvnKk`

## Consistent pattern

- The watch pages expose strong transcript signals up front:
  - non-zero `captionTrackCount`
  - `transcriptParamsPresent: true`
  - transcript engagement panel continuation present
- Direct page-origin `api/timedtext` fetches return `200` with `Content-Type: text/html; charset=UTF-8` and empty bodies for:
  - default
  - `fmt=json3`
  - `fmt=srv3`
  - `fmt=vtt`
- A simple bootstrap `youtubei/v1/get_transcript` POST with `{ context, params }` returns `400 FAILED_PRECONDITION`.
- Executing YouTube's own transcript continuation through `ytd-app.resolveCommand(...)` also returns `400 FAILED_PRECONDITION`.
- The internal continuation request is materially richer than the simple bootstrap request:
  - gzip-compressed JSON body
  - `languageCode`
  - `externalVideoId`
  - `x-goog-visitor-id`
  - attestation data in `context.request.attestationResponseData`
- Even with that richer internal request, visible transcript segments remain `0`.

## Practical conclusion

- In this headless Chromium environment, current YouTube transcript recovery is failing after discovery, not before discovery.
- The evidence does not support treating the remaining failure as a Defuddle experiment regression.
- The evidence also does not support assuming that adding a page-origin fetch transport alone will restore transcript wins.
- Any further local fix should start from YouTube's current transcript continuation semantics, not the legacy `timedtext` assumption.

## Artifacts

- `release/ted-transcript-debug.json`
- `release/3b1b-transcript-debug.json`
