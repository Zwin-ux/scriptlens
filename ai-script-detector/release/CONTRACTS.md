# ScriptLens Contracts

ScriptLens now treats the extension, backend, and QA tooling as consumers of one
shared response contract.

## Stable analysis fields

Every release-grade report should preserve these fields:

- `contractVersion`
- `analysisMode`
- `originKind`
- `recoveryTier`
- `sourceTrustTier`
- `winnerReason`
- `qualityGate`
- `scoringStatus`
- `failureCategory`

The shared source of truth lives in:

- `shared/contracts.js`

The current contract version is `2026-03-11`.

## Shared error taxonomy

Failure categories are intentionally broader than raw backend error codes:

- `policy`
- `quality`
- `timeout`
- `transport`
- `auth-session`
- `transcript-source`
- `request`
- `server`
- `unknown`

Use the shared helper instead of hard-coding category logic:

- `ScriptLensContracts.categorizeFailureCode(...)`
- `ScriptLensContracts.resolveFailureCategory(...)`

## Runtime message contract

The release build keeps these message shapes stable:

- `inline:init`
  - returns current YouTube context and minimal inline settings
- `inline:analyze`
  - returns the existing analysis payload shape, plus shared contract fields
- `panel:open`
  - stores or opens the advanced workspace handoff

## Packaging inputs

These build-time environment variables are considered release inputs:

- `SCRIPTLENS_BACKEND_ENDPOINT`
- `SCRIPTLENS_BACKEND_ORIGIN`
- `SCRIPTLENS_PUBLIC_SITE_ORIGIN`

Treat a drift in any of these interfaces as a test failure, not an ad hoc debug task.
