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
