# Defuddle Video QA

Generated: 2026-03-13T23:35:52.528Z

## Summary

- Matrix entries: 2
- Control successes: 2
- Defuddle successes: 2
- Control transcript wins: 0
- Defuddle transcript wins: 0
- Control fallback-text-only results: 2
- Defuddle fallback-text-only results: 1
- Control preflight transcript-available pages: 2
- Defuddle preflight transcript-available pages: 2
- Changed outcomes: 1
- Defuddle direct wins: 1
- Transcript regressions: 0
- Labeling issues: 0
- Expectation mismatches: control 1, defuddle 1
- Backend control successes: 2
- Backend defuddle successes: 2
- Backend control transcript wins: 0
- Backend defuddle transcript wins: 0
- Backend control rescues: 0
- Backend defuddle rescues: 0
- Backend expectation mismatches: control 1, defuddle 1

## Changed Cases

| ID | Expected | Control | Defuddle | Delta |
| --- | --- | --- | --- | --- |
| 25-storm-chasing-arch-tornado-outbreak-from-ka | direct-content / weak-fallback-acceptable | transcript:Title + description fallback | page-content:Extracted page content | Defuddle direct content replaced the control outcome. |

## Failures

| ID | Control | Defuddle |
| --- | --- | --- |
| none | - | - |

## Expectation Mismatches

| ID | Variant | Expected | Actual | Notes |
| --- | --- | --- | --- | --- |
| 01-ted-your-body-language-may-s | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 01-ted-your-body-language-may-s | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 01-ted-your-body-language-may-s | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 01-ted-your-body-language-may-s | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |

## Defuddle Direct Wins

- 25-storm-chasing-arch-tornado-outbreak-from-ka: Defuddle direct content replaced the control outcome.

## Backend Rescues

- None
