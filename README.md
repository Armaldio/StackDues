# Subscription & infrastructure costs

Implementation follows [plan.md](plan.md), one reviewable slice at a time.

## Development

Use Node.js 22.18 or newer and install dependencies with `npm install`.

- `npm test` runs the fixed subscription domain tests using Node's native TypeScript support.
- `npm run build` type-checks the application and builds it.
- `npm run dev` starts the subscription dashboard.

## Core ledger (PR 1)

`src/domain/subscriptions.ts` defines validated fixed subscriptions and pure cost/renewal calculations. The original billing amount is preserved. Monthly and yearly equivalents use 12 months or 365 days per year (a week is seven days); these are comparison values, not invoices or forecasts. Totals stay grouped by currency without implicit conversion. Paused and cancelled subscriptions do not contribute to active totals or upcoming renewals.

Renewal dates are calendar dates in `YYYY-MM-DD` form, calculated in UTC. Month/year recurrence stays anchored to the original renewal date, clamping to the final day of shorter months without accumulating drift. Renewal windows include both boundary dates. `nextRenewalAt` is the schedule anchor; calculations do not mutate it.

## Dashboard (PR 2)

Add, edit, pause/resume, or delete fixed subscriptions from the dashboard. Charges can recur every positive number of days, weeks, months, or years. The dashboard shows normalized rates alongside the actual renewals due in the next 30 and 90 days, grouped by currency.

Manual subscriptions persist in this browser's local storage. No account is required, and these records are never uploaded. Clearing browser data removes them; saved-data errors block overwriting corrupted records. Optional example subscriptions are clearly labelled.

## Metered usage and AWS (PR 3)

`CostSnapshot` observations are immutable, timestamped actuals or forecasts, separate from fixed subscriptions. The dashboard reads the published `data/costs.json` feed. Actuals are never added to forecasts because whole-month forecasts already include actual costs. Currency totals remain separate; missing forecasts prevent a misleading combined estimate.

The AWS adapter runs only on the server/in GitHub Actions using the official Cost Explorer SDK. It collects month-to-date UnblendedCost through the previous UTC day, comparable previous-month days, full previous-month spend, service breakdowns, and available forecasts. Pagination, unavailable history/forecasts, malformed responses and sanitized errors have focused tests. [AWS Cost Explorer API reference](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html) describes the source data.

Provider setup and scheduled public feed deployment are added in PR 5. Credentials are never entered into the dashboard or bundled into frontend JavaScript.

## Cloudflare and independent refresh (PR 4)

The server adapter uses [Cloudflare PayGo Billable Usage v1](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/paygo/), summing `ContractedCost` charge rows with returned Workers/R2/service breakdowns. Running cumulative costs and consumption quantities are never mistaken for prices. Billing currency, credits and billing-period groups are preserved.

The API reports charge intervals rather than a full billing-cycle end, so the dashboard labels these as billing-period-to-date actuals without inventing a forecast. Empty responses remain unavailable. A tiny shared refresh contract is introduced now that both adapters exist. Each provider refreshes independently; failed collections cannot replace successful history or another provider's costs.

## Provider setup

This personal app is hosted at **https://armaldio.github.io/billing/**. GitHub Pages serves the dashboard; trusted GitHub Actions jobs call billing APIs. Manual subscriptions stay in your browser. Provider observations published to this public site are public, including their cost history. No provider credentials are published.

1. In the repository's **Settings → Secrets and variables → Actions**, add the provider secrets below. Never create `VITE_` secrets or enter keys in the dashboard.
2. For AWS, enable Cost Explorer and grant the credential identity only the billing read permissions it needs: `ce:GetCostAndUsage` and `ce:GetCostForecast`. Add `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN` for temporary credentials. Temporary credentials expire and must be renewed; a dedicated read-only identity is appropriate for unattended use. The adapter uses Cost Explorer's `us-east-1` endpoint.
3. For Cloudflare, create an account-scoped token with **Billing Read** permission, then add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The PayGo API is for supported self-serve accounts; unavailable API access appears as a failed sync, not zero spend.
4. When you want to publish metered costs publicly, add the repository **variable** `PUBLISH_PROVIDER_COSTS` with value `true`. Publication defaults off even when secrets are present. Turning it off publishes an empty provider feed on the next deployment; already downloaded public data cannot be recalled.
5. Run **Actions → Refresh costs and deploy Pages → Run workflow**. Reload cost data in the dashboard after the deployment finishes. The button reads published observations; provider ingestion happens in Actions, not in the browser.

The workflow refreshes and deploys on main changes, manual dispatch, and every six hours at minute 17 UTC. GitHub schedules can be delayed, and GitHub can disable scheduled jobs in inactive repositories. Last-successful sync dates, failure messages and a 36-hour stale warning make missing refreshes visible. The browser reloads the feed every 15 minutes while open.

Each deployment recovers the prior published feed before appending new captures. Provider failures preserve prior observations and the other provider's success. A network/validation failure recovering history stops publication rather than erasing history. Records are immutable; the dashboard shows the 30 most recent observations while the published feed retains full history.

No provider credentials were configured during initial deployment, so live account ingestion has not been authenticated against your accounts. Adapters and independent failure paths are covered with realistic API fixtures; the initial site accurately shows Not connected.

## Verification and deployment

- `npm test`: focused recurrence, renewal, normalization, storage, adapter, failure-isolation and history-publication tests.
- `npm run build`: application, server script and test type checking plus the production Pages build.
- `npm run test:e2e`: Chromium CRUD/persistence, currency separation, keyboard dialog, responsive layout, provider failure/staleness/history checks against the built app. Run `npx playwright install chromium` once, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing Chromium binary.
- `npm run refresh:costs`: trusted server-side refresh using environment variables. Publication is opt-in; the command never asks the browser for secrets.

GitHub Actions CI runs tests, type checking/build, Chromium checks, and a dependency audit. The Pages workflow builds and validates before using provider secrets in its dedicated ingestion step. It publishes only `dist`, never source files or secret environment variables. Roll back by reverting a change on main and letting the same deployment workflow rebuild it; prior provider history is recovered from the published feed.

The Pages base path is `/billing/`, including the cost feed and favicon. Development opens at `http://localhost:5173/billing/`. There is no cloud account system or cross-device subscription synchronization in this personal V1 workspace.
