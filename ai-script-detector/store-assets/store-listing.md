# ScriptLens Chrome Web Store Listing

## Extension name

ScriptLens

## One-line summary

Analyze YouTube video transcripts for AI-like writing patterns with a one-click inline button.

## Detailed description

ScriptLens is a YouTube-only Chrome extension for desktop `youtube.com/watch` pages.

It adds an inline `Analyze video` button directly on YouTube so you can:

- check the strongest available transcript path
- review a verdict-first AI-like writing score
- see plain-language explanations before opening the full workspace

ScriptLens keeps the default experience simple:

- one click on the YouTube page
- transcript-first analysis
- compact inline results

For advanced users, ScriptLens also includes:

- a toolbar popup with transcript controls and settings
- a side-panel workspace with detailed signal breakdowns
- optional transcript recovery through a compatible hosted or self-hosted backend

Scoring runs inside the extension with deterministic heuristics. When local YouTube transcript paths are weak or unavailable, ScriptLens can use a configured transcript recovery service before giving up. That backend path is optional and can be ScriptLens-hosted or self-hosted.

## Single-purpose statement

ScriptLens has one purpose: analyze the writing style of YouTube video transcripts for AI-like patterns on desktop YouTube watch pages.

## Privacy disclosure snippet

ScriptLens processes scoring locally by default. If a configured transcript recovery service is enabled and ScriptLens needs it, the extension shares only the YouTube video ID and requested language with that service.

## Support URL

Set this to your Railway public site URL before submission, for example:

https://your-scriptlens-site.example/support.html

## Privacy URL

Set this to your Railway public site URL before submission, for example:

https://your-scriptlens-site.example/privacy.html

## Public support route

https://github.com/Zwin-ux/scriptlens/issues
