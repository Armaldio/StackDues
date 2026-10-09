import { upcomingRenewals, type Renewal, type Subscription } from './subscriptions.ts'
import { latestCostSnapshots, type CostSnapshot } from './usage-costs.ts'

export type SpendingTimeline = Readonly<{
  windowStart: string
  windowEnd: string
  renewals: readonly Renewal[]
  actuals: readonly CostSnapshot[]
  forecasts: readonly CostSnapshot[]
}>

function dateOffset(value: string, offset: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) throw new Error('Timeline dates must use a valid UTC calendar date')
  date.setUTCDate(date.getUTCDate() + offset)
  if (!Number.isFinite(date.getTime())) throw new Error('Timeline window is outside the supported date range')
  return date.toISOString().slice(0, 10)
}

/** Builds independent fixed-renewal and provider-observation lanes for one UTC window. */
export function spendingTimeline(
  subscriptions: readonly Subscription[],
  snapshots: readonly CostSnapshot[],
  asOf: string,
  days: 30 | 90 | 365,
): SpendingTimeline {
  if (![30, 90, 365].includes(days)) throw new Error('Timeline window must be 30, 90, or 365 days')
  const windowStart = dateOffset(asOf, -(days - 1))
  const windowEnd = dateOffset(asOf, days - 1)
  const latest = latestCostSnapshots(snapshots)
  return {
    windowStart,
    windowEnd,
    renewals: upcomingRenewals(subscriptions, asOf, windowEnd),
    actuals: latest.filter(row => row.kind === 'actual' && row.periodEnd > windowStart && row.periodStart <= asOf),
    forecasts: latest.filter(row => row.kind === 'forecast' && row.periodEnd > asOf && row.periodStart <= windowEnd),
  }
}
