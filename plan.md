Developer subscription & infra cost dashboard
Goal
Build a small hosted app that combines:
- fixed subscriptions with arbitrary recurrence
- upcoming renewals / commitments
- variable infrastructure spend
- live AWS + Cloudflare cost ingestion
- normalized monthly/yearly totals and projections
Keep V1 intentionally narrow. Do not build generic FinOps, accounting, team management, invoice parsing, or a connector marketplace yet.
Plan
- [x] PR 1 — Core subscription ledger
  - Add subscriptions with name, amount, currency, billing_type, recurrence_interval, recurrence_unit, next_renewal_at, status, provider.
  - Support arbitrary recurrence such as 1 month, 3 months, 2 years, 4 years; derive monthly/yearly equivalent values without mutating the original amount.
  - Acceptance: Bitwarden yearly, Hostinger every 4 years, and a monthly VPS can coexist and produce correct upcoming-renewal + normalized-cost calculations.
  - Implemented: `src/domain/subscriptions.ts` provides fixed subscription creation/validation, monthly/yearly normalization grouped by currency, and anchored UTC renewal calculations with inclusive date windows.
  - Verified: focused Node tests cover the acceptance examples, arbitrary intervals, month-end/leap-year behavior, input validation, inactive status, currency separation, and date-range boundaries; `npm run build` type-checks application and tests.
  - Scope at PR 1 completion: domain ledger only; persistence/manual entry were subsequently implemented in PR 2, and hosting in PR 5. The personal Pages workspace needs no account system. Metered spend remains a separate future model. Day/week equivalents use a 365-day year; no FX conversion is implied.
- [x] PR 2 — Dashboard & commitments
  - Build the main dashboard with current normalized monthly cost, annual commitments, upcoming 30/90-day renewals, and fixed-vs-variable split.
  - Add a simple subscriptions CRUD flow; prioritize fast manual entry over logos, vendor catalogs, tags, or advanced organization.
  - Acceptance: from a fresh account, a user can add their real subscriptions and immediately understand “what I pay”, “what is coming”, and “what this costs per year”.
  - Implemented: responsive Vue dashboard, per-currency fixed monthly/annual equivalents, actual 30/90-day commitments, searchable subscription ledger, add/edit/delete and status controls.
  - Persistence: validated browser-local storage with read/write failure states and corruption protection; explicit example data is optional and never presented as real spend. This personal Pages workspace needs no account and does not upload manual subscriptions.
  - Verified: focused storage durability/error tests, production build, and real Chromium CRUD/persistence/status/mobile smoke checks. Infrastructure placeholders are replaced in PR 3.
- [x] PR 3 — Variable cost model + AWS
  - Add cost_snapshots / usage_costs separately from subscription definitions; keep actual metered spend immutable and timestamped.
  - Implement AWS Cost Explorer ingestion for month-to-date spend, previous period comparison, forecast if available, and optional service breakdown.
  - Acceptance: AWS appears beside fixed subscriptions without pretending it has a fixed renewal amount; dashboard totals distinguish committed vs estimated spend.
  - Implemented: immutable, timestamped `CostSnapshot` model separate from fixed subscriptions; official server-only AWS Cost Explorer SDK adapter for MTD actuals, matched previous-period/full-month comparisons, service pagination, and whole-month forecasts when available.
  - Dashboard: reported usage, service breakdowns, forecasts and per-currency fixed-plus-variable estimated totals; incomplete forecasts are identified instead of treating missing providers as zero. Current data is selected by the last successful capture.
  - Safety: bounded requests, sanitized errors, validation, credits, overflow protection, no fake zero-cost snapshots, and no speculative connector contract. Missing comparison/forecast data preserves current actuals.
  - Verified: focused AWS/usage/feed tests plus build and browser rendering; live ingestion is wired by PR 5 and requires repository secrets.
- [x] PR 4 — Cloudflare ingestion
  - Add Cloudflare Billable Usage ingestion with billing-period total and useful service breakdowns such as Workers/R2 where returned.
  - Reuse only the genuinely shared pieces from AWS; extract a small connector contract now, not before this PR.
  - Acceptance: AWS and Cloudflare refresh independently, failures are visible, and one broken provider cannot block the other or corrupt previous snapshots.
  - Implemented: server-only Cloudflare PayGo Billable Usage adapter, summed priced charge rows grouped by billing period/currency with returned service breakdowns. Running cumulative values and unpriced consumption are never summed as spend.
  - API limitation: billing-period end/forecast is not returned; snapshots retain reported charge intervals and explicitly mark projection unavailable. Empty results remain unavailable, not a manufactured zero.
  - Shared behavior extracted only after both adapters: a small provider/configured/collect contract, independent refreshes, immutable appended history, atomic validation, sanitized per-provider failures, preserved last successful snapshots and sync dates.
  - Verified: 14 focused Cloudflare/sync tests cover priced fields, malformed data, missing configuration, authentication/network/timeouts, pagination safeguards, provider isolation and failure recovery; build passes.
- [x] PR 5 — Product hardening
  - Add scheduled refreshes, last_synced_at, sync status/error states, stale-data warnings, basic history, and credential handling using server-side secrets only.
  - Split work between subagents: one for recurrence/financial calculations + tests, one for AWS/Cloudflare API research and adapters, one for dashboard UX; final agent integrates and removes unnecessary abstractions.
  - Acceptance: the app is usable daily with no manual maintenance except adding/changing subscriptions, and the architecture is ready for connector #3 without introducing a plugin framework.
  - Implemented: six-hour GitHub Actions refreshes, provider last-attempt/last-success status, failure recovery and immutable history across deployments, 36-hour stale warnings, browser feed reloads, recent history table, and actual 365-day fixed commitments alongside normalized rates.
  - Credential handling: provider SDK/API calls run only in trusted Actions jobs using repository secrets. The frontend receives an allowlisted financial feed. Public provider-cost publication requires `PUBLISH_PROVIDER_COSTS=true`; manual subscriptions remain browser-local.
  - Hardening: finite financial totals, strict capture/sync timestamps, atomic writes, fail-safe previous-history recovery, clean Pages asset paths, CI tests/build/browser checks/audit, and documentation for setup/rollback.
  - Verified: 68 focused tests, two Chromium production-build scenarios (CRUD/persistence, separate currencies, keyboard modal, responsive layouts, provider errors/staleness/history), type checking/build and zero dependency-audit vulnerabilities. Three parallel domain/provider/UI workers were integrated and reviewed.
  - Delivery: the Pages workflow publishes main automatically to https://armaldio.github.io/billing/ and can be manually dispatched. Deployment status and the live rendered site are verified before the final delivery report.
  - External setup: no AWS/Cloudflare secrets are currently configured. Live authenticated account ingestion cannot be verified until the repository owner adds them; the deployed app accurately shows Not connected and does not invent costs.
Explicitly defer
Do not include these in V1 unless a real usage problem demands them:
- generic connector SDK / marketplace
- invoice or email parsing
- bank synchronization
- budgeting
- organizations / RBAC
- mobile apps
- usage anomaly detection
- AI categorization
- provider logo/catalog system
- complex forecasting
- accounting/export integrations
Data model direction
type Subscription = {
  id: string
  name: string
  provider?: string

  billingType: 'fixed' | 'variable'

  amount?: number
  currency: string

  recurrenceInterval?: number
  recurrenceUnit?: 'day' | 'week' | 'month' | 'year'

  nextRenewalAt?: string

  status: 'active' | 'paused' | 'cancelled'
}

type CostSnapshot = {
  id: string
  subscriptionId?: string

  provider: 'aws' | 'cloudflare'
  periodStart: string
  periodEnd: string

  amount: number
  currency: string

  kind: 'actual' | 'forecast'
  capturedAt: string

  metadata?: Record<string, unknown>
}

The important constraint is: never collapse fixed commitments and metered usage into the same financial concept. They can share the dashboard, but they should remain different in the model.
For V1, I’d aim for 5 PRs maximum and resist adding anything until you’re personally using the dashboard with your actual Bitwarden, Hostinger, AWS, Cloudflare, VPS, and domain costs.
