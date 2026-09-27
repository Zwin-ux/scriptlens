# ScriptLens Contracts

ScriptLens treats the extension surfaces and test tooling as consumers of one
shared response contract.

## Stable analysis fields

Every release-grade report should preserve these fields:

- `contractVersion`
- `analysisMode`
- `originKind`
- `sourceTrustTier`
- `winnerReason`
- `qualityGate`
- `scoringStatus`
- `failureCategory`

The shared source of truth lives in:

- `shared/contracts.js`

The current contract version is `2026-09-27`. It dropped `recoveryTier`, which only described hosted recovery, when ScriptLens became local-only.

## Shared error taxonomy

Failure categories are intentionally broader than raw error codes:

- `quality`
- `timeout`
- `transport`
- `transcript-source`
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

- `SCRIPTLENS_PUBLIC_SITE_ORIGIN`

Treat a drift in any of these interfaces as a test failure, not an ad hoc debug task.
