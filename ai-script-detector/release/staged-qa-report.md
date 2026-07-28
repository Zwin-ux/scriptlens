# Staged Consumer QA Report

Generated: 2026-03-12T07:12:52.963Z
Backend: https://scriptlens-backend-134711094498.us-west2.run.app
Backend client instance: staging-backend-1773299572963-cuq9tk
Inline client instance: staging-inline-1773299572963-cuq9tk

Backend transcript-class successes: 11/18
Inline success cards: 11/18
Inline compact runs: 18/18
Inline transport issues: 0
Backend-good inline errors: 0

| Video | Categories | Backend | Failure Category | Origin | Recovery | Trust | Winner | Latency (ms) | Inline | Compact | Workspace |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| Writing safety talk | hard-blocker, caption-recovery, medium | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 192 | success | yes | yes |
| Advanced English transitions | hard-blocker, caption-recovery, medium | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 130 | success | yes | yes |
| Me at the zoo | short-video, caption-recovery | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 32 | success | yes | yes |
| YouTube API demo | clean-transcript, medium, developer | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 64 | success | yes | yes |
| Neural networks visual intro | clean-transcript, educational, medium | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 60 | success | yes | yes |
| Try something new for 30 days | clean-transcript, talk, medium | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 44 | success | yes | yes |
| Google keynote session | long-video, clean-transcript, conference | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 109 | success | yes | yes |
| 35 minute lecture | near-asr-cap, lecture, clean-transcript | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 6167 | success | yes | yes |
| Long lecture success case | long-video, clean-transcript, lecture | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 343 | success | yes | yes |
| Spanish talk candidate | non-english, translated-captions-candidate, caption-recovery | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 7949 | success | yes | yes |
| Spanish talk candidate two | non-english, translated-captions-candidate, caption-recovery | success | unknown | manual_caption_track | hosted_transcript | caption-derived | quality-eligible:manual_caption_track | 119 | success | yes | yes |
| Big Buck Bunny trailer | transcript-miss, asr-fallback-candidate | fail (asr_audio_browser_session_media_missing) | transcript-source | unavailable | hosted_transcript | unavailable | asr_audio_browser_session_media_missing | 37727 | error | yes | yes |
| Gangnam Style | non-english, translated-captions-candidate, asr-fallback-candidate | fail (asr_audio_browser_session_media_missing) | transcript-source | unavailable | hosted_transcript | unavailable | asr_audio_browser_session_media_missing | 38713 | error | yes | yes |
| Despacito | non-english, translated-captions-candidate, asr-fallback-candidate | fail (asr_audio_browser_session_media_missing) | transcript-source | unavailable | hosted_transcript | unavailable | asr_audio_browser_session_media_missing | 40532 | error | yes | yes |
| Documentary over auto ASR cap | long-video, asr-duration-policy, documentary | fail (asr_duration_limit) | policy | unavailable | hosted_transcript | unavailable | asr_duration_limit | 18630 | error | yes | yes |
| Very long podcast over absolute cap | long-video, asr-duration-policy, podcast | fail (asr_duration_absolute_limit) | policy | unavailable | hosted_transcript | unavailable | asr_duration_absolute_limit | 16389 | error | yes | yes |
| Rick Astley quality reject | generated-captions-candidate, quality-gate, music | fail (sentence_structure_below_threshold) | unknown | unavailable | hosted_transcript | unavailable | sentence_structure_below_threshold | 28691 | error | yes | yes |
| Japan vlog degraded captions | generated-captions-candidate, quality-gate, non-english | fail (non_letter_noise) | quality | unavailable | hosted_transcript | unavailable | non_letter_noise | 28859 | error | yes | yes |

## Notes

- `Inline` records whether the watch-page widget reached a success card, error card, or timed out.
- `Compact` requires the inline card to stay within the small watch-page footprint and avoid opening the YouTube transcript engagement panel.
- `Workspace` checks that `Open full workspace` stored a valid panel launch request.
- `transport` means the staged runner hit a transient browser/network navigation failure before the page could load; it is tracked separately from product behavior.
