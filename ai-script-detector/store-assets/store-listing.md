# ScriptLens Chrome Web Store Listing

## Extension name

ScriptLens

## One-line summary

Analyze YouTube video transcripts for AI-like writing patterns with a one-click inline button.

## Detailed description

ScriptLens is a YouTube-only Chrome extension for desktop `youtube.com/watch` pages.

It adds an inline `Analyze video` button directly on YouTube so you can:

- read the transcript YouTube already provides for the video
- review a verdict-first AI-like writing score
- see plain-language explanations before opening the full workspace

ScriptLens keeps the default experience simple:

- one click on the YouTube page
- transcript-first analysis
- compact inline results

For advanced users, ScriptLens also includes:

- a toolbar popup with transcript controls and settings
- a side-panel workspace with detailed signal breakdowns

Everything runs on your device. ScriptLens reads captions directly from YouTube and scores them inside the extension with deterministic heuristics. It has no servers, accounts, analytics, or telemetry. When a video has no usable transcript, ScriptLens says so instead of guessing.

The score is a heuristic signal about writing style, not proof of how a script was produced.

## Single-purpose statement

ScriptLens has one purpose: analyze the writing style of YouTube video transcripts for AI-like patterns on desktop YouTube watch pages.

## Permission justifications

- `storage`: saves settings, a short recent-report history, and small session values that pass the active video to the side panel.
- `sidePanel`: opens the detailed analysis workspace when the user asks for it.
- Host access to `https://www.youtube.com/*`: shows the inline button on watch pages and reads the transcript for the active video.

## Data usage disclosure

ScriptLens does not collect or transmit user data. Transcript text is read from YouTube and analyzed locally; nothing is sent to ScriptLens or any third party.

## Privacy disclosure snippet

ScriptLens runs entirely on your device. It loads captions for the active video directly from youtube.com and scores them inside the extension. No transcript text, scores, or identifiers are sent to any server.

## Support URL

https://synergyaiscript.up.railway.app/support

## Privacy URL

https://synergyaiscript.up.railway.app/privacy

## Public support route

https://github.com/Zwin-ux/scriptlens/issues
