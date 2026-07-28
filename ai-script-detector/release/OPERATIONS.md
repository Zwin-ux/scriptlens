# ScriptLens Operations

## Release gates

ScriptLens uses three release gates:

1. `fast-checks`
2. `smoke-e2e`
3. `scheduled-canary`

Promotion rules:

- unlisted Chrome Web Store staging only happens when `fast-checks`, `smoke-e2e`, and the latest canary are green
- public release only happens after several consecutive healthy canary days and a fresh staged QA pass
- use `npm run release:readiness` for canary promotion decisions and `npm run release:readiness:public` before public release

## Authenticated backend dependency

The production recovery backend depends on an authenticated YouTube session.

### Cookie rotation checklist

1. Export a fresh Netscape-format cookie file from the dedicated backend YouTube account.
2. Upload it to Secret Manager as a new secret version.
3. Confirm Cloud Run still mounts the secret path.
4. Redeploy or restart the backend if the mounted file changed.
5. Verify:
   - `/version` shows `authenticatedModeEnabled: true`
   - the daily canary still reaches expected caption-backed successes

### Healthy canary pattern

Treat the canary as healthy when:

- stable caption-backed videos keep succeeding
- failures stay limited to known policy or unavailable cases
- there is no abrupt rise in `auth-session`, `timeout`, or `transport` categories

### Suspect canary pattern

Treat the canary as suspect when:

- previously stable canaries flip into `auth-session` failures
- multiple videos regress into `backend_timeout`
- backend-good videos stop rendering inline success in staged QA

### Auth recovery failure checklist

If authenticated recovery looks unhealthy:

1. verify the Cloud Run service still reports `authenticatedModeEnabled: true`
2. verify the mounted secret path still exists inside the service revision
3. rotate the cookie secret and redeploy
4. rerun the canary before promoting any release

## Daily review expectations

Each canary review should check:

- overall pass count
- stage-level failure categories
- auth-enabled health
- any new backend-good versus inline-good mismatches

If the canary regresses, block promotion until the regression is explained or fixed.
