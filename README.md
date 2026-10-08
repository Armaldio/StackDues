# StackDues

Personal subscription commitments and metered infrastructure costs. [Plane DUES-1](https://app.plane.so/armaldio/projects/8bbba4d1-340a-4a63-9782-ffd2cdecce73/issues/05145959-8843-4c2a-955b-820fa1b18ed9) is the implementation and status source of truth. The completed V1 record remains in Git history; no local V2 plan is maintained.

## Development

Use Node.js 24 and `npm ci`. `npm run dev` starts Nuxt on localhost. The dashboard retains its Vue components and pure domain calculations; client rendering preserves the existing UI while subscriptions are loaded from the private D1 API. Legacy browser records are never automatically uploaded, overwritten or deleted.

- `npm test`: recurrence, renewal, normalization, local storage, cost parsing, provider failure isolation and password hashing and signed session verification.
- `npm run build`: Nuxt/Nitro Workers production build.
- `npm run typecheck`: application, server adapters, scripts and tests.
- `npm run test:e2e`: existing CRUD, persistence, currencies, keyboard dialogs, responsive layouts and provider-error scenarios against local Nuxt. CI uses preinstalled Chrome; locally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if needed.
- `npm run test:aws-worker`: mocked AWS signing/response spike in real workerd, without provider API requests.
- `npm run test:worker`: real workerd checks that unauthenticated app, assets, API and legacy-feed requests are denied.
- `npm run preview`: run the production entry locally, denied by default without a valid owner session.

## Financial behavior

Fixed subscriptions and metered observations remain separate domain models. Arbitrary day/week/month/year recurrences retain the original charge; normalized equivalents use 365 days or 12 months per year. Calendar renewals are UTC, anchored to their original day and clamped at month ends without drift. Paused/cancelled entries are excluded. Totals are grouped by currency, with no implied exchange conversion.

Actual provider observations are immutable and timestamped. Whole-month forecasts already include actual costs and are never added to actuals. Missing forecasts prevent misleading combined estimates; failed providers retain their previous observations. The dashboard reads `/api/costs`, with no public billing JSON. The endpoint reads immutable D1 observations and sync status; provider ingestion is enabled in the Workers sync slice.

## Private persistence and browser import

D1 keeps manual fixed subscriptions, immutable cost observations, provider sync status and owner credentials in separate tables. CRUD uses prepared statements and row revisions: a stale edit/delete returns 409 instead of overwriting another device. Storage failures appear as errors while the browser keeps the previously displayed data; they never become a successful empty ledger. Server transactions enforce finite per-currency fixed totals.

Use **Import an existing browser ledger** to select a JSON file, paste JSON, or read same-origin legacy data. Preview and validate the entire array, download its exact original backup, then explicitly import. Imports are limited to 1 MiB/1,000 records, idempotent by subscription ID, atomic, and never overwrite existing server edits. The interface displays verified account values for comparison. Original LocalStorage keys remain untouched. The former Pages data belongs to `https://armaldio.github.io`, so the new hostname cannot read it; visit the previous Pages address (a 404 does not remove browser storage) and export `ledger.subscriptions.v1` from Developer Tools → Application/Storage → Local Storage.

Apply the focused migrations with `npx wrangler d1 migrations apply stackdues --remote` before deploying. Cost inserts and status updates commit together, duplicate observations cannot change values, errors preserve the last success, and older attempts cannot regress status. `npm run test:d1` proves these paths with a temporary local D1 database; authenticated API routing is tested separately against the full Worker.

## Workers and login

The production entry is **`worker/index.ts`**, wrapping Nitro with an email/password session gate before static asset routing. Always deploy with `npm run deploy`, which uses the repository Wrangler configuration. Do not deploy `.output/server/index.mjs` directly: that generated entry omits the outer gate.

Deployment target: `https://dues.armaldio.xyz` in account `37dcf91b09d88c94354b136b5a366235`. No Cloudflare Access or Zero Trust setup is required. The configured owner opens `/register`, enters their email, chooses a password of 16–1024 characters, and supplies the one-time setup code. The code is saved locally in `/root/workspace/stackdues-setup-code.txt` with owner-only file permissions, not published in this repository. Account setup is available only while the singleton owner row is absent; concurrent/repeated registration cannot overwrite it. The user sets the password, which is never logged or stored in plaintext.

D1 stores only the owner's salted PBKDF2-SHA256 hash (100,000 iterations, the Workers Web Crypto ceiling). A random 32-byte `SESSION_SECRET` and random `SETUP_TOKEN` live only in Workers Secrets. `OWNER_EMAIL` is the server's allowlist. Sessions are signed with HS256, expire after eight hours and use a host-only Secure/HttpOnly/SameSite=Strict cookie. Rotating the password hash or session key invalidates earlier sessions. Sign-out clears the browser cookie; a previously copied token remains valid until expiry/rotation. All authenticated responses are private/no-store. Mutation requests require an exact same-origin Origin; login and registration forms have bounded bodies and a Workers rate-limit binding permits ten attempts per minute per IP/location. Missing database/configuration or cryptographic failures deny access.

`run_worker_first: true` prevents asset bypass. `workers_dev: false` and `preview_urls: false` disable alternate public hosts; any future preview must retain the session gate and separate test database/secrets. The only anonymous pages are `/login` and `/register`; app JavaScript, billing APIs and assets require authentication. Local Nuxt development is for loopback use only.

Create the D1 binding, apply `npx wrangler d1 migrations apply stackdues --remote`, configure Worker Secrets through protected stdin/file input, build with `npm run build`, then `npm run deploy`. CI creates only a temporary local D1 database with fake credentials for runtime tests. It never creates an owner account in production or reads billing secrets.

GitHub Actions validates code only and never refreshes billing. The previous Pages refresh/deployment workflow has been removed, and the legacy Pages deployment and scheduled workflow are disabled to remove the alternate public host. Provider credentials belong only in Workers Secrets. Roll back by deploying the previous reviewed commit with the same gate and bindings; D1 data does not roll back with Worker code.

## Provider adapters

AWS uses Cost Explorer's `us-east-1` endpoint, MTD UnblendedCost through the previous UTC day, matched prior-month comparison, service breakdowns and available forecasts. The Workers compatibility spike proves request signing and response handling with explicit secret bindings and `FetchHttpHandler`; the Node default credential chain does not work in Workers. Required billing permissions are `ce:GetCostAndUsage` and `ce:GetCostForecast`.

Cloudflare's existing adapter reads priced PayGo charge rows; it does not sum cumulative values or unpriced quantities and does not invent unavailable forecasts. The Workers sync slice will verify the currently supported endpoint before enabling ingestion.

The retained `scripts/refresh-costs.ts` is a V1 offline helper covered by historical regression tests, not a deployment or CI ingestion step. It must not be used to publish private billing data.

## Dependency audit

`npm audit --omit=dev --audit-level=high` gates deployed application dependencies. Full audits currently report unpatched build/development-only `braces` (deep glob pattern exhaustion) and `node-forge` (RSA verification in local development certificate tooling); neither is included in the Workers or browser bundle. Nuxt dev runs only on loopback. Patched `simple-git` and `sharp` are pinned via overrides; builds and browser tests validate compatibility. Revisit these overrides and unpatched tooling advisories when upstream fixes ship. Do not force an audit downgrade of Nuxt or Wrangler.
