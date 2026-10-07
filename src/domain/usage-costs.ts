export type CostProvider = 'aws' | 'cloudflare'
export type CostBreakdown = Readonly<{ service: string; amount: number; currency: string }>

/** Metered observations are separate from fixed subscription commitments. End dates are exclusive. */
export type CostSnapshot = Readonly<{
  id: string
  provider: CostProvider
  periodStart: string
  periodEnd: string
  amount: number
  currency: string
  kind: 'actual' | 'forecast'
  capturedAt: string
  metadata?: Readonly<Record<string, unknown>>
}>

export type UsageTotal = {
  currency: string
  actual: number
  estimatedMonthly: number
  estimatedYearly: number
  hasActual: boolean
  hasForecast: boolean
  estimationComplete: boolean
}

function validDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Signed amounts allow genuine billing credits; malformed or nonfinite values never become zero. */
export function normalizeUsageAmount(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
    throw new Error('Usage amount must be a finite decimal number')
  }
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error('Usage amount must be a finite decimal number')
  return amount
}

function freezeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeMetadata))
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeMetadata(item)])))
  }
  return value
}

export function createCostSnapshot(input: CostSnapshot): CostSnapshot {
  if (typeof input.id !== 'string' || !input.id.trim()) throw new Error('Snapshot id is required')
  if (!['aws', 'cloudflare'].includes(input.provider)) throw new Error('Invalid cost provider')
  if (!validDate(input.periodStart) || !validDate(input.periodEnd) || input.periodStart >= input.periodEnd) throw new Error('Cost period must contain valid ascending dates')
  if (typeof input.amount !== 'number') throw new Error('Snapshot amount must be a number')
  const amount = normalizeUsageAmount(input.amount)
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('Invalid cost currency')
  if (!['actual', 'forecast'].includes(input.kind)) throw new Error('Invalid snapshot kind')
  if (typeof input.capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.capturedAt) || !Number.isFinite(Date.parse(input.capturedAt))) throw new Error('Invalid capture timestamp')
  return Object.freeze({ ...input, id: input.id.trim(), amount, metadata: input.metadata ? freezeMetadata(input.metadata) as Readonly<Record<string, unknown>> : undefined })
}

/** Repeated captures remain in history; only the newest observation for a period contributes to summaries. */
export function latestCostSnapshots(snapshots: readonly CostSnapshot[]): CostSnapshot[] {
  const latest = new Map<string, CostSnapshot>()
  for (const snapshot of snapshots) {
    const key = JSON.stringify([snapshot.provider, snapshot.periodStart, snapshot.periodEnd, snapshot.kind, snapshot.currency])
    const previous = latest.get(key)
    if (!previous || Date.parse(snapshot.capturedAt) > Date.parse(previous.capturedAt)) latest.set(key, snapshot)
  }
  return [...latest.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
}

/** Actuals and whole-month forecasts occupy separate totals. Forecasts already include actuals. No FX conversion. */
export function usageTotals(snapshots: readonly CostSnapshot[], asOf: string): UsageTotal[] {
  if (!validDate(asOf)) throw new Error('Invalid summary date')
  const candidates = latestCostSnapshots(snapshots).filter(snapshot => snapshot.metadata?.period === 'current' && snapshot.capturedAt.slice(0, 7) === asOf.slice(0, 7) && snapshot.periodStart <= asOf)
  const latestCapture = new Map<string, number>()
  for (const snapshot of candidates) {
    const key = snapshot.provider
    latestCapture.set(key, Math.max(latestCapture.get(key) ?? 0, Date.parse(snapshot.capturedAt)))
  }
  const current = candidates.filter(snapshot => Date.parse(snapshot.capturedAt) === latestCapture.get(snapshot.provider))
  // All billing groups in the newest provider capture contribute; historical partial periods do not.
  const totals = new Map<string, UsageTotal>()
  for (const snapshot of current) {
    const total = totals.get(snapshot.currency) ?? { currency: snapshot.currency, actual: 0, estimatedMonthly: 0, estimatedYearly: 0, hasActual: false, hasForecast: false, estimationComplete: true }
    if (snapshot.kind === 'actual') {
      total.actual = normalizeUsageAmount(total.actual + snapshot.amount)
      total.hasActual = true
      if (!current.some(item => item.provider === snapshot.provider && item.kind === 'forecast' && item.currency === snapshot.currency)) total.estimationComplete = false
    } else {
      total.estimatedMonthly = normalizeUsageAmount(total.estimatedMonthly + snapshot.amount)
      total.estimatedYearly = normalizeUsageAmount(total.estimatedYearly + snapshot.amount * 12)
      total.hasForecast = true
    }
    totals.set(snapshot.currency, total)
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}
