# Defuddle Video QA

Generated: 2026-03-13T23:29:12.773Z

## Summary

- Matrix entries: 1
- Control successes: 1
- Defuddle successes: 1
- Control transcript wins: 0
- Defuddle transcript wins: 0
- Control fallback-text-only results: 1
- Defuddle fallback-text-only results: 1
- Control preflight transcript-available pages: 1
- Defuddle preflight transcript-available pages: 1
- Changed outcomes: 0
- Defuddle direct wins: 0
- Transcript regressions: 0
- Labeling issues: 0
- Expectation mismatches: control 1, defuddle 1

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
| 01-ted-your-body-language-may-s | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 01-ted-your-body-language-may-s | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |

## Defuddle Direct Wins

- None
