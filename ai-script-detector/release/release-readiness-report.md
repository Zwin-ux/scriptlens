# Release Readiness

Generated: 2026-03-14T02:18:58.467Z
Mode: canary
Overall: FAIL
Health score: 65/100
Backend origin: https://scriptlens-backend-134711094498.us-west2.run.app

## Checks

| Check | Status | Summary |
| --- | --- | --- |
| Defuddle corpus gate | PASS | No transcript regressions, labeling issues, or expectation mismatches. |
| Staged canary gate | PASS | Canary expectations and inline handoff stayed healthy. |
| Staged full QA gate | PASS | Backend expectations, inline compactness, and handoff signals stayed healthy. |
| Backend capability gate | FAIL | yt-dlp capability is unavailable, ASR is enabled but not configured |

## Metrics

### Defuddle Corpus

- total: 13
- transcriptRegressions: 0
- labelingIssues: 0
- expectationMismatches: 0

### Staged Canary

- total: 7
- backendSuccess: 5
- inlineSuccess: 0
- inlineMeasured: 0
- inlineCompact: 0
- inlineTransportIssues: 0
- backendGoodInlineErrors: 0
- canaryMismatches: 0
- backendExpectationFailures: 0

### Staged QA

- total: 18
- backendSuccess: 11
- inlineSuccess: 11
- inlineMeasured: 18
- inlineCompact: 18
- inlineTransportIssues: 0
- backendGoodInlineErrors: 0
- canaryMismatches: 0
- backendExpectationFailures: 0

### Backend

- origin: https://scriptlens-backend-134711094498.us-west2.run.app
- service: scriptlens-backend
- version: 0.1.0
- authenticatedModeEnabled: true
- asrEnabled: true
- ytDlpAvailable: false
- ytDlpSource: null
- asrConfigured: false

## Blocking Issues

- Backend capability gate: yt-dlp capability is unavailable, ASR is enabled but not configured
