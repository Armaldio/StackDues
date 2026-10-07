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
