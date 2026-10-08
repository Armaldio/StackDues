# StackDues

Personal subscription commitments and metered infrastructure costs. [Plane DUES-1](https://app.plane.so/armaldio/projects/8bbba4d1-340a-4a63-9782-ffd2cdecce73/issues/05145959-8843-4c2a-955b-820fa1b18ed9) is the implementation and status source of truth. The completed V1 record remains in Git history; no local V2 plan is maintained.

## Development

Use Node.js 24 and `npm ci`. `npm run dev` starts Nuxt on localhost. The dashboard retains its Vue components and pure domain calculations; client rendering preserves browser-local subscriptions during the migration. Clearing browser storage removes these records, so keep them until the explicit D1 import is available.

- `npm test`: recurrence, renewal, normalization, local storage, cost parsing, provider failure isolation and signed Access verification.
- `npm run build`: Nuxt/Nitro Workers production build.
- `npm run typecheck`: application, server adapters, scripts and tests.
- `npm run test:e2e`: existing CRUD, persistence, currencies, keyboard dialogs, responsive layouts and provider-error scenarios against local Nuxt. CI uses preinstalled Chrome; locally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` if needed.
- `npm run test:aws-worker`: mocked AWS signing/response spike in real workerd, without provider API requests.
- `npm run test:worker`: real workerd checks that unauthenticated app, assets, API and legacy-feed requests are denied.
- `npm run preview`: run the production entry locally, denied by default without valid Access configuration and assertion.

## Financial behavior

Fixed subscriptions and metered observations remain separate domain models. Arbitrary day/week/month/year recurrences retain the original charge; normalized equivalents use 365 days or 12 months per year. Calendar renewals are UTC, anchored to their original day and clamped at month ends without drift. Paused/cancelled entries are excluded. Totals are grouped by currency, with no implied exchange conversion.

Actual provider observations are immutable and timestamped. Whole-month forecasts already include actual costs and are never added to actuals. Missing forecasts prevent misleading combined estimates; failed providers retain their previous observations. The dashboard reads `/api/costs`, with no public billing JSON. During the first migration slice this endpoint returns unconfigured providers; D1 and Workers ingestion follow in their own PRs.

## Workers and Cloudflare Access

The production entry is **`worker/index.ts`**, wrapping Nitro with a signed Access gate before static asset routing. Always deploy with `npm run deploy`, which uses the repository Wrangler configuration. Do not deploy `.output/server/index.mjs` directly: that generated entry omits the outer gate.

Deployment target: `dues.armaldio.xyz` in account `37dcf91b09d88c94354b136b5a366235`. Wrangler authentication must have Workers deployment and route permissions. Configure a Zero Trust Self-hosted Access application for this hostname **and every path**, permitting only the owner. Store `ACCESS_TEAM_DOMAIN` (full `https://<team>.cloudflareaccess.com` origin), `ACCESS_AUDIENCE` (application AUD tag), and `OWNER_EMAIL` as Worker bindings through `wrangler secret put`. They are not exposed in Nuxt public runtime configuration.

The gate verifies RS256 signatures against the team's bounded cached JWKS, issuer, exact audience, expiry and owner email. Missing configuration, forged identity headers, invalid tokens and key-fetch failures deny access. All responses are private/no-store. `run_worker_first: true` prevents asset bypass. `workers_dev: false` and `preview_urls: false` disable alternate public hosts; any future preview hostname must have its own Access application/audience before enabling it. Production has no authentication bypass. Local Nuxt development is for loopback use only.

Build with `npm run build`, configure Access and bindings, then `npm run deploy`. Verify an unauthenticated request returns the Access login redirect (or the Worker's 403) for `/`, `/favicon.svg` and `/api/costs`. Authenticate as the owner and confirm the dashboard; another identity must be denied. Roll back by deploying the previous reviewed commit with the same gate and bindings.

GitHub Actions validates code only and never refreshes billing. The previous Pages refresh/deployment workflow has been removed. An existing Pages deployment is not automatically unpublished by removing its workflow; disable Pages in repository settings when replacing it. No provider credentials belong in GitHub ingestion jobs or client JavaScript. V2 provider credentials will live only in Workers Secrets.

## Provider adapters

AWS uses Cost Explorer's `us-east-1` endpoint, MTD UnblendedCost through the previous UTC day, matched prior-month comparison, service breakdowns and available forecasts. The Workers compatibility spike proves request signing and response handling with explicit secret bindings and `FetchHttpHandler`; the Node default credential chain does not work in Workers. Required billing permissions are `ce:GetCostAndUsage` and `ce:GetCostForecast`.

Cloudflare's existing adapter reads priced PayGo charge rows; it does not sum cumulative values or unpriced quantities and does not invent unavailable forecasts. The Workers sync slice will verify the currently supported endpoint before enabling ingestion.

The retained `scripts/refresh-costs.ts` is a V1 offline helper covered by historical regression tests, not a deployment or CI ingestion step. It must not be used to publish private billing data.

## Dependency audit

`npm audit --omit=dev --audit-level=high` gates deployed application dependencies. Full audits currently report unpatched build/development-only `braces` (deep glob pattern exhaustion) and `node-forge` (RSA verification in local development certificate tooling); neither is included in the Workers or browser bundle. Nuxt dev runs only on loopback. Patched `simple-git` and `sharp` are pinned via overrides; builds and browser tests validate compatibility. Revisit these overrides and unpatched tooling advisories when upstream fixes ship. Do not force an audit downgrade of Nuxt or Wrangler.
