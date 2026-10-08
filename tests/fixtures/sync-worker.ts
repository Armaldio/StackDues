import { GetCostForecastCommand } from '@aws-sdk/client-cost-explorer'
import migration from '../../migrations/0002_ledger.sql'
import { LedgerError, readCostFeed } from '../../server/data/ledger.ts'
import { syncCosts, type CostSyncDependencies } from '../../server/worker-sync.ts'
import type { loadProviderCredentials } from '../../server/security/provider-credentials.ts'

const awsCredentials = { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'TEST_FAKE_AWS_SECRET' }
const cloudflareCredentials = { accountId: '023e105f4ecef8ad9ca31a8372d0c353', apiToken: 'TEST_FAKE_CLOUDFLARE_TOKEN' }
type Mode = 'missing' | 'success' | 'aws-error' | 'cloudflare-error' | 'credential-error' | 'timeout' | 'malformed' | 'empty-cloudflare'

// Local-only fixture. Neither the SDK client nor fetch can contact real providers.
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const input = await request.json() as { action: string; mode?: Mode; now?: string; sql?: string; providers?: ('aws' | 'cloudflare')[] }
    try {
      if (input.action === 'initialize') {
        await env.DB.exec(migration.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' ').replace(/;\s*(?=CREATE)/g, ';\n'))
        return Response.json({ ready: true })
      }
      if (input.action === 'sql') { await env.DB.exec(input.sql!); return Response.json({ ready: true }) }
      if (input.action === 'costs') return Response.json(await readCostFeed(env.DB))
      const mode = input.mode ?? 'success'
      const calls = { aws: 0, cloudflare: 0 }
      const dependencies: CostSyncDependencies = {
        loadCredentials: (async (_db: D1Database, provider: string) => {
          if (mode === 'missing') return null
          if (mode === 'credential-error' && provider === 'aws') throw new Error('TEST_FAKE_AWS_SECRET decryption failed')
          return provider === 'aws' ? awsCredentials : cloudflareCredentials
        }) as typeof loadProviderCredentials,
        awsClient: credentials => {
          if (credentials.secretAccessKey !== awsCredentials.secretAccessKey) throw new Error('Unexpected fake credentials')
          return { async send(command) {
            calls.aws++
            if (mode === 'aws-error') throw Object.assign(new Error('TEST_FAKE_AWS_SECRET denied'), { name: 'AccessDeniedException' })
            if (mode === 'timeout') return new Promise(() => {})
            if (command instanceof GetCostForecastCommand) return { Total: { Amount: '10', Unit: 'USD' } }
            return { ResultsByTime: [{ Total: { UnblendedCost: { Amount: '9', Unit: 'USD' } }, Groups: [{ Keys: ['Amazon EC2'], Metrics: { UnblendedCost: { Amount: '9', Unit: 'USD' } } }] }] }
          } }
        },
        fetch: async (_url, init) => {
          calls.cloudflare++
          if ((init?.headers as Record<string, string>).Authorization !== `Bearer ${cloudflareCredentials.apiToken}`) throw new Error('Unexpected fake credentials')
          if (mode === 'cloudflare-error') return new Response('TEST_FAKE_CLOUDFLARE_TOKEN denied', { status: 403 })
          return Response.json({ success: true, result: mode === 'empty-cloudflare' ? [] : [{
            BillingCurrency: 'USD', BillingPeriodStart: '2026-09-15T00:00:00Z',
            ChargePeriodStart: '2026-10-05T00:00:00Z', ChargePeriodEnd: '2026-10-06T00:00:00Z',
            ServiceName: 'Workers Standard', ContractedCost: mode === 'malformed' ? 'not-money' : 2,
            CumulatedContractedCost: 999,
          }] })
        },
        timeoutMs: mode === 'timeout' ? 5 : 1000,
      }
      // Both execution triggers call this exact production function with their timestamp.
      const feed = await syncCosts({ DB: env.DB }, new Date(input.now ?? '2026-10-08T12:00:00Z'), dependencies, input.providers)
      return Response.json({ feed, calls })
    } catch (error) {
      return Response.json({ message: error instanceof LedgerError ? error.message : 'Fixture request failed.' }, { status: error instanceof LedgerError ? error.statusCode : 500 })
    }
  },
}
