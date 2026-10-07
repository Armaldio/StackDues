# Subscription & infrastructure costs

Implementation follows [plan.md](plan.md), one reviewable slice at a time.

## Development

Use Node.js 22.18 or newer and install dependencies with `npm install`.

- `npm test` runs the fixed subscription domain tests using Node's native TypeScript support.
- `npm run build` type-checks the application and builds it.
- `npm run dev` starts the Vue starter; the dashboard and entry form are planned for PR 2.

## Core ledger (PR 1)

`src/domain/subscriptions.ts` defines validated fixed subscriptions and pure cost/renewal calculations. The original billing amount is preserved. Monthly and yearly equivalents use 12 months or 365 days per year (a week is seven days); these are comparison values, not invoices or forecasts. Totals stay grouped by currency without implicit conversion. Paused and cancelled subscriptions do not contribute to active totals or upcoming renewals.

Renewal dates are calendar dates in `YYYY-MM-DD` form, calculated in UTC. Month/year recurrence stays anchored to the original renewal date, clamping to the final day of shorter months without accumulating drift. Renewal windows include both boundary dates. `nextRenewalAt` is the schedule anchor; calculations do not mutate it.

This slice is a domain ledger, with no persistence or account system yet. Metered usage will have separate immutable snapshots in PR 3. Provider integrations and credentials belong on the server and are not part of the frontend ledger.
