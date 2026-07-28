# ScriptLens Debugging Pass

Use this when the inline YouTube flow fails on a real watch page.

## Console surfaces

1. Page DevTools on the YouTube watch page
   - Look for logs prefixed with `ScriptLens`
   - Relevant scopes:
     - `youtube-main`
     - `content`
     - `youtube-overlay`

2. Extension service worker console
   - Open `chrome://extensions`
   - Find ScriptLens
   - Open the service worker inspector
   - Relevant scopes:
     - `service-worker`
     - `transcript-acquire`
     - `youtube-resolver`
     - `backend-resolver`

3. Side panel or popup DevTools
   - Relevant scopes:
     - `sidepanel`
     - `popup`

## What to capture

- The YouTube URL
- The last `traceId` mentioned in the service worker logs
- Whether `youtube-main` captured a transcript request
- Whether `content` saw caption tracks or transcript params
- Which resolver strategy failed first
- Whether tab switching triggered `tabs.onActivated`, `tabs.onUpdated`, or `navigation_changed`

## Useful console helpers

- `ScriptLensDebug.getHistory()`
  - Returns the recent in-context log buffer for the current surface

## Test sequence

1. Load the target watch page
2. Click `Analyze video`
3. If it fails, capture page console logs and service worker logs
4. Click `Open full workspace`
5. Switch tabs away and back
6. Capture:
   - side panel logs
   - service worker logs
   - any `Unhandled error` or `Unhandled rejection` entries
