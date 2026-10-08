import ledgerMigration from '../../migrations/0002_ledger.sql'
import credentialMigration from '../../migrations/0003_provider_credentials.sql'
import hostingerMigration from '../../migrations/0004_hostinger_discovery.sql'
import { createStoredSubscription, listSubscriptions, patchStoredSubscription } from '../../server/data/ledger.ts'
import { createHostingerLedgerEntry, hostingerEditStatement, linkHostingerToLedger, readHostingerDiscovery, refreshHostingerEntries } from '../../server/data/hostinger.ts'
import { saveProviderCredentials } from '../../server/security/provider-credentials.ts'
import { LedgerError } from '../../server/data/ledger.ts'

const key = 'c'.repeat(64)
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const input = await request.json() as Record<string, any>
    try {
      if (input.action === 'initialize') {
        for (const migration of [ledgerMigration, credentialMigration, hostingerMigration]) await env.DB.exec(migration.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' '))
        return Response.json({ ready: true })
      }
      if (input.action === 'save') return Response.json(await saveProviderCredentials(env.DB, 'hostinger', { apiToken: 'TEST_FAKE_HOSTINGER_TOKEN' }, 0, key))
      if (input.action === 'sync') {
        const responseBody = input.providerResponse ?? []
        const result = await refreshHostingerEntries(env.DB, key, new Date(input.now), async (_url, init) => {
          if (init?.headers && new Headers(init.headers).get('Authorization') !== 'Bearer TEST_FAKE_HOSTINGER_TOKEN') return new Response('TEST_FAKE_HOSTINGER_TOKEN leaked', { status: 401 })
          if (input.failure) return new Response('TEST_FAKE_HOSTINGER_TOKEN provider body', { status: input.failure })
          return Response.json(responseBody)
        })
        return Response.json(result)
      }
      if (input.action === 'list') return Response.json(await readHostingerDiscovery(env.DB))
      if (input.action === 'add') return Response.json(await createHostingerLedgerEntry(env.DB, input.externalId))
      if (input.action === 'link') return Response.json(await linkHostingerToLedger(env.DB, input.externalId, input.subscriptionId, input.revision, input.mode))
      if (input.action === 'edit') {
        return Response.json(await patchStoredSubscription(env.DB, input.id, input.subscription, input.revision, (item, revision) => hostingerEditStatement(env.DB, item, revision)))
      }
      if (input.action === 'manual') return Response.json(await createStoredSubscription(env.DB, input.subscription))
      if (input.action === 'subscriptions') return Response.json(await listSubscriptions(env.DB))
      if (input.action === 'raw') return Response.json(await env.DB.prepare('SELECT raw_json FROM hostinger_subscriptions WHERE external_id = ?').bind(input.externalId).first())
      if (input.action === 'links') return Response.json(await env.DB.prepare('SELECT external_id, subscription_id, overrides_json FROM hostinger_subscription_links ORDER BY external_id').all())
      return new Response('Unknown test action', { status: 400 })
    } catch (cause) {
      const error = cause instanceof LedgerError ? cause : new Error('Test fixture request failed.')
      return Response.json({ message: error.message }, { status: cause instanceof LedgerError ? cause.statusCode : 500 })
    }
  },
}
