# Defuddle Video QA

Generated: 2026-03-13T23:53:13.149Z

## Summary

- Matrix entries: 2
- Control successes: 2
- Defuddle successes: 2
- Control transcript wins: 0
- Defuddle transcript wins: 0
- Control fallback-text-only results: 2
- Defuddle fallback-text-only results: 2
- Control preflight transcript-available pages: 1
- Defuddle preflight transcript-available pages: 1
- Changed outcomes: 0
- Defuddle direct wins: 0
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
| none | - | - | - | no changed outcomes |

## Failures

| ID | Control | Defuddle |
| --- | --- | --- |
| none | - | - |

## Expectation Mismatches

| ID | Variant | Expected | Actual | Notes |
| --- | --- | --- | --- | --- |
| 33-lifestyle-creator--speaking-only-spanish-fo | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |

## Defuddle Direct Wins

- None

## Backend Rescues

- None
