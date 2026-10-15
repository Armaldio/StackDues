import ledgerMigration from '../../migrations/0002_ledger.sql'
import hostingerDiscoveryMigration from '../../migrations/0004_hostinger_discovery.sql'
import hostingerAutomaticMigration from '../../migrations/0005_hostinger_auto_commitments.sql'
import cloudflareCommitmentsMigration from '../../migrations/0010_cloudflare_fixed_commitments.sql'
import { createStoredSubscription, deleteStoredSubscription, importSubscriptions, LedgerError, listSubscriptions, patchStoredSubscription, persistProviderSync, readCostFeed } from '../../server/data/ledger.ts'

const migrations = [ledgerMigration, hostingerDiscoveryMigration, hostingerAutomaticMigration, cloudflareCommitmentsMigration]

async function applyMigration(db: D1Database, migration: string) {
  // D1 exec accepts one complete statement per line; keep trigger bodies intact.
  await db.exec(migration.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' ').replace(/;\s*(?=CREATE)/g, ';\n'))
}

// Local workerd-only fixture: never imported by the application's Worker.
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const { action, ...input } = await request.json() as Record<string, any>
    try {
      if (action === 'initialize') {
        for (const migration of migrations) await applyMigration(env.DB, migration)
        return Response.json({ ready: true })
      }
      if (action === 'list') return Response.json(await listSubscriptions(env.DB))
      if (action === 'create') return Response.json(await createStoredSubscription(env.DB, input.subscription))
      if (action === 'patch') return Response.json(await patchStoredSubscription(env.DB, input.id, input.subscription, input.revision))
      if (action === 'delete') return Response.json(await deleteStoredSubscription(env.DB, input.id, input.revision))
      if (action === 'import') return Response.json(await importSubscriptions(env.DB, input.subscriptions))
      if (action === 'costs') return Response.json(await readCostFeed(env.DB))
      if (action === 'persist') { await persistProviderSync(env.DB, input.provider, input.snapshots, input.status); return Response.json(await readCostFeed(env.DB)) }
      if (action === 'sql') { await env.DB.exec(input.sql); return Response.json({ ready: true }) }
      return new Response('Unknown fixture action', { status: 400 })
    } catch (error) {
      return Response.json({ message: error instanceof Error ? error.message : 'Failed' }, { status: error instanceof LedgerError ? error.statusCode : 500 })
    }
  },
}
