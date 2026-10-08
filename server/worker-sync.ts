import { LedgerError, persistProviderSync, readCostFeed } from './data/ledger.ts'
import { createAwsClient, fetchAwsCosts, type AwsClientCredentials, type AwsCostClient } from './providers/aws.ts'
import { collectCloudflareCosts } from './providers/cloudflare.ts'
import { loadProviderCredentials } from './security/provider-credentials.ts'
import { emptyCostSyncState, refreshCosts, type CostConnector } from './sync.ts'
import type { CostFeed } from '../src/lib/cost-feed.ts'
import type { CostProvider } from '../src/domain/usage-costs.ts'

export type CostSyncBindings = { DB: D1Database; CREDENTIALS_KEY?: string }
export type CostSyncDependencies = {
  loadCredentials?: typeof loadProviderCredentials
  awsClient?: (credentials: AwsClientCredentials) => AwsCostClient
  fetch?: typeof fetch
  timeoutMs?: number
}

/** Manual refresh and scheduled execution use the same collection and persistence path. */
export async function syncCosts(env: CostSyncBindings, now = new Date(), dependencies: CostSyncDependencies = {}, selectedProviders: readonly CostProvider[] = ['aws', 'cloudflare']): Promise<CostFeed> {
  if (!env.DB || !Number.isFinite(now.getTime())) throw new LedgerError(503, 'Cost refresh is unavailable. Try again later.')
  if (!selectedProviders.length || selectedProviders.some(provider => !['aws', 'cloudflare'].includes(provider)) || new Set(selectedProviders).size !== selectedProviders.length) throw new LedgerError(400, 'Choose one or more supported providers to refresh.')
  const load = dependencies.loadCredentials ?? loadProviderCredentials
  async function connector(provider: CostProvider): Promise<CostConnector> {
    try {
      if (provider === 'aws') {
        const credentials = await load(env.DB, 'aws', env.CREDENTIALS_KEY)
        return { provider, configured: credentials !== null, collect: () => fetchAwsCosts({
          client: (dependencies.awsClient ?? createAwsClient)(credentials!), now, timeoutMs: dependencies.timeoutMs,
        }) }
      }
      const credentials = await load(env.DB, 'cloudflare', env.CREDENTIALS_KEY)
      return { provider, configured: credentials !== null, collect: () => collectCloudflareCosts({
        ...credentials!, now, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs,
      }) }
    } catch {
      // Missing/decryption-invalid keys are failed configuration, never absent credentials.
      // Credential loader errors and SQL details cannot enter provider state or logs.
      return { provider, configured: true, collect: async () => { throw new Error('Provider credentials are unavailable.') } }
    }
  }
  const results = await Promise.allSettled(selectedProviders.map(async provider => {
    const collected = await refreshCosts(emptyCostSyncState(), [await connector(provider)], now)
    // Commit only this provider's complete collection and status. The SQL preserves
    // last successful timestamps and rejects older overlapping status attempts.
    await persistProviderSync(env.DB, provider, collected.snapshots, collected.providers[provider])
  }))
  if (results.some(result => result.status === 'rejected')) throw new LedgerError(503, 'Cost refresh could not be saved. Previous data has been preserved. Try again later.')
  return readCostFeed(env.DB)
}
