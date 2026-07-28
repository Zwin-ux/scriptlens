# Railway Public Site

ScriptLens uses Railway for the public landing, privacy, and support pages. The transcript recovery backend remains on Cloud Run.

## What Railway serves

The Railway service runs from the repository root and serves the static files in `ai-script-detector/docs`.

- landing page: `/`
- privacy page: `/privacy.html`
- support page: `/support.html`
- health check: `/healthz`

## Why the root service exists

Railway was connected to the repository root, but the repo root did not contain a deployable app. The root `package.json`, `server.js`, and `railway.json` provide an explicit Node entrypoint so Railway can build and run the public site without touching the Cloud Run backend.

## Railway setup

1. Keep the Railway service source rooted at the repository root.
2. Expose the service publicly.
3. Confirm the health check succeeds at `/healthz`.
4. Once Railway assigns a public domain, use that origin for release packaging.

## Release packaging

Before building the Chrome extension for release, set:

```powershell
$env:SCRIPTLENS_PUBLIC_SITE_ORIGIN='https://your-scriptlens-site.example'
```

Then build normally:

```powershell
npm.cmd run build:extension
npm.cmd run package:extension
```

That will set `homepage_url` in the packaged manifest to the Railway-hosted public site.

## Current hosting split

- Railway: public docs and support pages
- Cloud Run: transcript recovery backend
