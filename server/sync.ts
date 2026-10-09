import { createCostSnapshot, type CostProvider, type CostSnapshot } from '../src/domain/usage-costs.ts'
import { emptyCostFeed, type CostFeed } from '../src/lib/cost-feed.ts'

export type CostSyncState = CostFeed

/** Only the behavior shared by the two concrete adapters belongs in this contract. */
export type CostConnector = Readonly<{
  provider: CostProvider
  configured: boolean
  collect: () => Promise<readonly CostSnapshot[]>
}>

export function emptyCostSyncState(): CostSyncState {
  return emptyCostFeed()
}

/** Publish only whole successful collections; failed providers retain their immutable history. */
export async function refreshCosts(
  previous: CostSyncState,
  connectors: readonly CostConnector[],
  now = new Date(),
): Promise<CostSyncState> {
  const attemptedAt = now.toISOString()
  if (new Set(connectors.map(({ provider }) => provider)).size !== connectors.length) throw new Error('Duplicate cost provider')
  const results = await Promise.allSettled(connectors.map(async (connector) => {
    if (!connector.configured) return []
    const snapshots = await connector.collect()
    if (!Array.isArray(snapshots)) throw new Error('Invalid provider snapshots')
    return snapshots.map((snapshot) => {
      if (snapshot.provider !== connector.provider) throw new Error('Unexpected cost provider')
      return createCostSnapshot(snapshot)
    })
  }))
  const snapshots = [...previous.snapshots]
  const ids = new Set(snapshots.map(({ id }) => id))
  const providers = { ...previous.providers }
  connectors.forEach((connector, index) => {
    const result = results[index]!
    if (!connector.configured) {
      providers[connector.provider] = {
        status: 'not-configured',
        lastAttemptAt: attemptedAt,
        ...(previous.providers[connector.provider].lastSyncedAt ? { lastSyncedAt: previous.providers[connector.provider].lastSyncedAt } : {}),
      }
    } else if (result.status === 'fulfilled') {
      for (const snapshot of result.value) {
        if (!ids.has(snapshot.id)) { snapshots.push(snapshot); ids.add(snapshot.id) }
      }
      providers[connector.provider] = { status: 'synced', lastAttemptAt: attemptedAt, lastSyncedAt: attemptedAt }
    } else {
      providers[connector.provider] = {
        ...previous.providers[connector.provider], status: 'error', lastAttemptAt: attemptedAt,
        // Provider errors can contain authorization headers or SDK request details.
        error: `${connector.provider === 'aws' ? 'AWS' : connector.provider === 'cloudflare' ? 'Cloudflare' : connector.provider === 'openai' ? 'OpenAI' : 'DigitalOcean'} refresh failed. Check server configuration and retry.`,
      }
    }
  })
  return Object.freeze({ snapshots: Object.freeze(snapshots), providers: Object.freeze(Object.fromEntries(
    Object.entries(providers).map(([provider, status]) => [provider, Object.freeze(status)]),
  )) as CostSyncState['providers'] })
}
