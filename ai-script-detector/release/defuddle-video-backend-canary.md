# Defuddle Video QA

Generated: 2026-03-13T23:49:50.567Z

## Summary

- Matrix entries: 13
- Control successes: 13
- Defuddle successes: 13
- Control transcript wins: 0
- Defuddle transcript wins: 0
- Control fallback-text-only results: 13
- Defuddle fallback-text-only results: 12
- Control preflight transcript-available pages: 12
- Defuddle preflight transcript-available pages: 12
- Changed outcomes: 1
- Defuddle direct wins: 1
- Transcript regressions: 0
- Labeling issues: 0
- Expectation mismatches: control 10, defuddle 10
- Backend control successes: 13
- Backend defuddle successes: 11
- Backend control transcript wins: 0
- Backend defuddle transcript wins: 0
- Backend control rescues: 0
- Backend defuddle rescues: 0
- Backend expectation mismatches: control 10, defuddle 11

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
| 03-3blue1brown-but-what-is-a-neural-net | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 03-3blue1brown-but-what-is-a-neural-net | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 03-3blue1brown-but-what-is-a-neural-net | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 03-3blue1brown-but-what-is-a-neural-net | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 04-khan-academy-algebra-linear-equations | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 04-khan-academy-algebra-linear-equations | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 04-khan-academy-algebra-linear-equations | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 04-khan-academy-algebra-linear-equations | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 12-bbc-news-prince-andrew-the-epstei | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 12-bbc-news-prince-andrew-the-epstei | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 12-bbc-news-prince-andrew-the-epstei | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 12-bbc-news-prince-andrew-the-epstei | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 13-caseyneistat-my-first-vlog | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 13-caseyneistat-my-first-vlog | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 13-caseyneistat-my-first-vlog | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 13-caseyneistat-my-first-vlog | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 19-jacksepticeye-journey-walkthrough-part | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 19-jacksepticeye-journey-walkthrough-part | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 19-jacksepticeye-journey-walkthrough-part | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 19-jacksepticeye-journey-walkthrough-part | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 22-jacksepticeye-surgeon-simulator-2013-i | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 22-jacksepticeye-surgeon-simulator-2013-i | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 22-jacksepticeye-surgeon-simulator-2013-i | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 22-jacksepticeye-surgeon-simulator-2013-i | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 31-spanish-after-hour-learn-spanish-with-this- | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 31-spanish-after-hour-learn-spanish-with-this- | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 31-spanish-after-hour-learn-spanish-with-this- | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 31-spanish-after-hour-learn-spanish-with-this- | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 33-lifestyle-creator--speaking-only-spanish-fo | backend-defuddle | transcript-class | error:transport_error | transport_error |
| 37-ifc-films-good-boy-official-traile | backend-defuddle | transcript-or-direct-or-fallback | error:page.goto: Target page, context or browser has been closed
Call log:
[2m  - navigating to "https://www.youtube.com/watch?v=q4-CRkd_74g", waiting until "domcontentloaded"[22m
 | page.goto: Target page, context or browser has been closed
Call log:
[2m  - navigating to "https://www.youtube.com/watch?v=q4-CRkd_74g", waiting until "domcontentloaded"[22m
 |
| 40-genius-sub-urban-uh-oh-official | control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 40-genius-sub-urban-uh-oh-official | defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 40-genius-sub-urban-uh-oh-official | backend-control | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |
| 40-genius-sub-urban-uh-oh-official | backend-defuddle | transcript-class | fallback-text-only | caption_track_fetch_failed, youtubei_http_403, youtubei_failed_precondition, dom_transcript_timeout, dom_transcript_panel_opened_no_segments, weak_fallback_only |

## Defuddle Direct Wins

- 25-storm-chasing-arch-tornado-outbreak-from-ka: Defuddle direct content replaced the control outcome.

## Backend Rescues

- None
