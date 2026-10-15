import { LedgerError, persistProviderSync, readCostFeed } from './data/ledger.ts'
import { createAwsClient, fetchAwsCosts, type AwsClientCredentials, type AwsCostClient } from './providers/aws.ts'
import { collectCloudflareCosts } from './providers/cloudflare.ts'
import { fetchCloudflareSubscriptions, type CloudflareSubscription } from './providers/cloudflare-subscriptions.ts'
import { fetchCloudflareRegistrations, type CloudflareRegistration } from './providers/cloudflare-registrar.ts'
import { logCloudflareCollectionFailure } from './providers/cloudflare-diagnostics.ts'
import type { CloudflareRegistrarAttempt } from './data/cloudflare-registrar.ts'
import { collectOpenAiCosts } from './providers/openai.ts'
import { collectDigitalOceanInvoices } from './providers/digitalocean.ts'
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
  logCloudflareFailure?: (line: string) => void
}

/** Manual refresh and scheduled execution use the same collection and persistence path. */
export async function syncCosts(env: CostSyncBindings, now = new Date(), dependencies: CostSyncDependencies = {}, selectedProviders: readonly CostProvider[] = ['aws', 'cloudflare', 'openai', 'digitalocean']): Promise<CostFeed> {
  if (!env.DB || !Number.isFinite(now.getTime())) throw new LedgerError(503, 'Cost refresh is unavailable. Try again later.')
  if (!selectedProviders.length || selectedProviders.some(provider => !['aws', 'cloudflare', 'openai', 'digitalocean'].includes(provider)) || new Set(selectedProviders).size !== selectedProviders.length) throw new LedgerError(400, 'Choose one or more supported providers to refresh.')
  const load = dependencies.loadCredentials ?? loadProviderCredentials
  const cloudflareSubscriptions = new Map<CostProvider, CloudflareSubscription[]>()
  const cloudflareRegistrar = new Map<CostProvider, CloudflareRegistrarAttempt>()
  async function connector(provider: CostProvider): Promise<CostConnector> {
    try {
      if (provider === 'aws') {
        const credentials = await load(env.DB, 'aws', env.CREDENTIALS_KEY)
        return { provider, configured: credentials !== null, collect: () => fetchAwsCosts({
          client: (dependencies.awsClient ?? createAwsClient)(credentials!), now, timeoutMs: dependencies.timeoutMs,
        }) }
      }
      if (provider === 'cloudflare') {
        const credentials = await load(env.DB, 'cloudflare', env.CREDENTIALS_KEY)
        if (!credentials) cloudflareRegistrar.set(provider, { status: 'not-configured', lastAttemptAt: now.toISOString() })
        return { provider, configured: credentials !== null, collect: async () => {
          const [costResult, subscriptionResult, registrarResult] = await Promise.allSettled([
            collectCloudflareCosts({ ...credentials!, now, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs }),
            fetchCloudflareSubscriptions({ ...credentials!, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs }),
            fetchCloudflareRegistrations({ ...credentials!, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs }),
          ])
          if (costResult.status === 'rejected') {
            logCloudflareCollectionFailure('billable_usage', costResult.reason, now.toISOString(), dependencies.logCloudflareFailure)
          }
          if (subscriptionResult.status === 'rejected') {
            logCloudflareCollectionFailure('subscriptions', subscriptionResult.reason, now.toISOString(), dependencies.logCloudflareFailure)
          }
          if (registrarResult.status === 'rejected') {
            cloudflareRegistrar.set(provider, { status: 'error', lastAttemptAt: now.toISOString() })
            logCloudflareCollectionFailure('registrar', registrarResult.reason, now.toISOString(), dependencies.logCloudflareFailure)
          } else {
            cloudflareRegistrar.set(provider, { status: 'synced', lastAttemptAt: now.toISOString(), registrations: registrarResult.value as readonly CloudflareRegistration[] })
          }
          if (costResult.status === 'rejected') throw costResult.reason
          if (subscriptionResult.status === 'rejected') throw subscriptionResult.reason
          cloudflareSubscriptions.set(provider, subscriptionResult.value)
          return costResult.value
        } }
      }
      if (provider === 'openai') {
        const credentials = await load(env.DB, 'openai', env.CREDENTIALS_KEY)
        return { provider, configured: credentials !== null, collect: () => collectOpenAiCosts({
          ...credentials!, now, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs,
        }) }
      }
      const credentials = await load(env.DB, 'digitalocean', env.CREDENTIALS_KEY)
      return { provider, configured: credentials !== null, collect: () => collectDigitalOceanInvoices({
        ...credentials!, now, fetch: dependencies.fetch, timeoutMs: dependencies.timeoutMs,
      }) }
    } catch {
      // Missing/decryption-invalid keys are failed configuration, never absent credentials.
      // Credential loader errors and SQL details cannot enter provider state or logs.
      if (provider === 'cloudflare') {
        cloudflareRegistrar.set(provider, { status: 'error', lastAttemptAt: now.toISOString() })
        logCloudflareCollectionFailure('credentials', new Error('Provider credentials are unavailable.'), now.toISOString(), dependencies.logCloudflareFailure)
      }
      return { provider, configured: true, collect: async () => { throw new Error('Provider credentials are unavailable.') } }
    }
  }
  const results = await Promise.allSettled(selectedProviders.map(async provider => {
    const collected = await refreshCosts(emptyCostSyncState(), [await connector(provider)], now)
    // Commit only this provider's complete collection and status. The SQL preserves
    // last successful timestamps and rejects older overlapping status attempts.
    await persistProviderSync(env.DB, provider, collected.snapshots, collected.providers[provider], provider === 'cloudflare' ? cloudflareSubscriptions.get(provider) : undefined, provider === 'cloudflare' ? cloudflareRegistrar.get(provider) : undefined)
  }))
  if (results.some(result => result.status === 'rejected')) throw new LedgerError(503, 'Cost refresh could not be saved. Previous data has been preserved. Try again later.')
  return readCostFeed(env.DB)
}
