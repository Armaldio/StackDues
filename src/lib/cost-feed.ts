import { createCostSnapshot, isValidCostTimestamp, type CostProvider, type CostSnapshot } from '../domain/usage-costs.ts'

export type ProviderSyncStatus = Readonly<{
  status: 'not-configured' | 'synced' | 'error'
  lastAttemptAt?: string
  lastSyncedAt?: string
  error?: string
}>
export type CostFeed = Readonly<{
  snapshots: readonly CostSnapshot[]
  providers: Readonly<Record<CostProvider, ProviderSyncStatus>>
}>

export function emptyCostFeed(): CostFeed {
  return { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' } } }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cost feed')
  return value as Record<string, unknown>
}
function timestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (!isValidCostTimestamp(value)) throw new Error('Invalid sync timestamp')
  return value
}

/** Validate the published feed, accepting only the public financial fields. */
export function parseCostFeed(value: unknown): CostFeed {
  const input = record(value)
  const providers = record(input.providers)
  if (!Array.isArray(input.snapshots)) throw new Error('Invalid cost snapshots')
  const statuses = {} as Record<CostProvider, ProviderSyncStatus>
  for (const provider of ['aws', 'cloudflare'] as const) {
    const state = record(providers[provider])
    if (state.status !== 'not-configured' && state.status !== 'synced' && state.status !== 'error') throw new Error('Invalid sync status')
    statuses[provider] = Object.freeze({
      status: state.status, lastAttemptAt: timestamp(state.lastAttemptAt), lastSyncedAt: timestamp(state.lastSyncedAt),
      error: state.status === 'error' ? `${provider === 'aws' ? 'AWS' : 'Cloudflare'} refresh failed. Check the provider configuration and try again.` : undefined,
    })
  }
  const snapshots = input.snapshots.map((value: unknown) => {
    const snapshot = record(value)
    const raw = snapshot.metadata === undefined ? {} : record(snapshot.metadata)
    const metadata: Record<string, unknown> = {}
    for (const field of ['period', 'scope', 'reportedThrough'] as const) {
      if (raw[field] !== undefined) {
        if (typeof raw[field] !== 'string') throw new Error('Invalid cost metadata')
        metadata[field] = raw[field]
      }
    }
    for (const field of ['estimated', 'forecastUnavailable', 'projectionUnavailable', 'comparisonUnavailable'] as const) {
      if (raw[field] !== undefined) {
        if (typeof raw[field] !== 'boolean') throw new Error('Invalid cost metadata')
        metadata[field] = raw[field]
      }
    }
    if (raw.breakdown !== undefined) {
      if (!Array.isArray(raw.breakdown)) throw new Error('Invalid cost breakdown')
      metadata.breakdown = raw.breakdown.map((item: unknown) => {
        const row = record(item)
        if (typeof row.service !== 'string' || !row.service.trim() || typeof row.amount !== 'number' || !Number.isFinite(row.amount) || typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) throw new Error('Invalid cost breakdown')
        return { service: row.service, amount: row.amount, currency: row.currency }
      })
    }
    return createCostSnapshot({
      id: snapshot.id, provider: snapshot.provider, periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd,
      amount: snapshot.amount, currency: snapshot.currency, kind: snapshot.kind, capturedAt: snapshot.capturedAt, metadata,
    } as CostSnapshot)
  })
  return Object.freeze({ snapshots: Object.freeze(snapshots), providers: Object.freeze(statuses) })
}

export async function fetchCostFeed(url: string, request: typeof fetch = fetch): Promise<CostFeed> {
  const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Cost data could not be loaded. Previous observations are still displayed.')
  return parseCostFeed(await response.json())
}

export function isProviderStale(status: ProviderSyncStatus, now = new Date()): boolean {
  return status.lastSyncedAt !== undefined && now.getTime() - Date.parse(status.lastSyncedAt) > 36 * 60 * 60 * 1000
}

/** Empty successful collections must not make an older observation look freshly synced. */
export function currentCostSnapshots(feed: CostFeed): readonly CostSnapshot[] {
  return feed.snapshots.filter(row => Date.parse(row.capturedAt) === Date.parse(feed.providers[row.provider].lastSyncedAt ?? ''))
}
