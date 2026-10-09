import { latestCostSnapshots, normalizeUsageAmount, type CostProvider, type CostSnapshot } from './usage-costs.ts'

export type OverviewInsight = Readonly<{
  provider: CostProvider
  currency: string
  actual: number
  previousComparable: number | null
  changePercent: number | null
  drivers: readonly Readonly<{ service: string; amount: number }>[]
}>

function days(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
}

function breakdown(snapshot: CostSnapshot): readonly { service: string; amount: number; currency: string }[] {
  const value = snapshot.metadata?.breakdown
  if (!Array.isArray(value)) return []
  return value.filter((row): row is { service: string; amount: number; currency: string } =>
    !!row && typeof row === 'object' && typeof row.service === 'string' && typeof row.amount === 'number' && typeof row.currency === 'string')
}

/** Dashboard-only provider insights. Comparisons stay within a provider, currency, and equal elapsed period. */
export function overviewInsights(snapshots: readonly CostSnapshot[]): OverviewInsight[] {
  const latest = latestCostSnapshots(snapshots)
  const current = latest.filter(row => row.kind === 'actual' && row.metadata?.period === 'current')
  const groups = new Map<string, CostSnapshot[]>()
  for (const row of current) {
    const key = `${row.provider}:${row.currency}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.values()].map(rows => {
    const { provider, currency } = rows[0]!
    const captureAt = Math.max(...rows.map(row => Date.parse(row.capturedAt)))
    const active = rows.filter(row => Date.parse(row.capturedAt) === captureAt)
    const actual = normalizeUsageAmount(active.reduce((sum, row) => sum + row.amount, 0))
    const currentPeriod = active.length === 1 ? active[0] : undefined
    const previous = currentPeriod && latest.find(row => row.provider === provider && row.currency === currency && row.kind === 'actual' && row.metadata?.period === 'previous-comparable' && row.capturedAt === currentPeriod.capturedAt && days(row.periodStart, row.periodEnd) === days(currentPeriod.periodStart, currentPeriod.periodEnd) && row.periodEnd <= currentPeriod.periodStart)
    const previousComparable = previous?.amount ?? null
    const changePercent = previousComparable !== null && previousComparable !== 0 ? normalizeUsageAmount(((actual - previousComparable) / Math.abs(previousComparable)) * 100) : null
    const services = new Map<string, number>()
    for (const row of active) for (const service of breakdown(row)) {
      if (service.currency !== currency || service.amount <= 0) continue
      services.set(service.service, normalizeUsageAmount((services.get(service.service) ?? 0) + service.amount))
    }
    const drivers = [...services].map(([service, amount]) => ({ service, amount })).sort((a, b) => b.amount - a.amount || a.service.localeCompare(b.service))
    return { provider, currency, actual, previousComparable, changePercent, drivers }
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency))
}
