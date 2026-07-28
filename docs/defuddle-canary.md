# Defuddle Canary Flow

Use the Defuddle experiment only through the flagged canary build. The source-tree extension keeps the experiment disabled by default.

## Build And Package

```bash
npm run build:defuddle-canary
npm run package:defuddle-canary
```

The canary build writes an unpacked extension to `dist/chrome-unpacked` and packages a zip under `dist/packages/`.

## Extension Test Gate

Run the flagged extension through the extension-level Playwright suite:

```bash
npm run test:defuddle-canary
```

By default this runs:

- `tests/popup.render.spec.js`
- `tests/service-worker.inline.spec.js`
- `tests/youtube.smoke.spec.js`

To run a narrower set:

```bash
node scripts/defuddle-canary.mjs test tests/popup.render.spec.js --reporter=line
```

## Manual Playwright CLI Setup

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export PWCLI="$CODEX_HOME/skills/playwright/scripts/playwright_cli.sh"
mkdir -p output/playwright
npx playwright install chromium
"$PWCLI" --help
```

Use the CLI for manual browser checks and screenshots. Use the extension Playwright suite for regression coverage.

## Matrix QA

For the real-video compare pass, use the checked-in matrix at `release/defuddle-video-matrix.json` and the Defuddle QA runner:

```bash
PW_HEADLESS=1 npm run qa:defuddle:canary
PW_HEADLESS=1 npm run qa:defuddle
```

To compare local-only vs local-plus-backend transcript recovery on the same corpus:

```bash
PW_HEADLESS=1 npm run qa:defuddle:backend:canary
```

This uses the runner's in-process local backend automatically. If you need an external backend instead, pass `--backend-endpoint https://<origin>/transcript/resolve`.

The runner builds both control and Defuddle variants, analyzes the same watch pages through the popup runtime flow, and writes compare reports to:

- `release/defuddle-video-report.json`
- `release/defuddle-video-report.md`

Once the corpus run and staged canary are refreshed, turn them into an explicit promotion signal with:

```bash
npm run release:readiness
```

The report now includes normalized failure families and per-variant expectation mismatches derived from the matrix fields:

- `expectedWinnerClass`
- `expectedLocalBehavior`
- `expectedBackendBehavior`
- `expectedDefuddleBehavior`

See `release/DEFUDDLE_QA.md` for the full runbook and filter options.
