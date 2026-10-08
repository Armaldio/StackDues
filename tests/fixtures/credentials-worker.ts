import migration from '../../migrations/0003_provider_credentials.sql'
import { listProviderConnections, loadProviderCredentials, removeProviderCredentials, saveProviderCredentials } from '../../server/security/provider-credentials.ts'
import { LedgerError } from '../../server/data/ledger.ts'

// Local fixture uses only fake credentials and is never imported by production.
export default {
  async fetch(request: Request, env: { DB: D1Database }): Promise<Response> {
    const { action, provider, credentials, revision, key, sql } = await request.json() as any
    try {
      if (action === 'initialize') { await env.DB.exec(migration.replace(/^--.*$/gm, '').replace(/\r?\n/g, ' ')); return Response.json({ ready: true }) }
      if (action === 'list') return Response.json(await listProviderConnections(env.DB))
      if (action === 'save') return Response.json(await saveProviderCredentials(env.DB, provider, credentials, revision, key))
      if (action === 'load') return Response.json(await loadProviderCredentials(env.DB, provider, key))
      if (action === 'remove') return Response.json(await removeProviderCredentials(env.DB, provider, revision))
      if (action === 'inspect') return Response.json(await env.DB.prepare('SELECT * FROM provider_credentials WHERE provider = ?').bind(provider).first())
      if (action === 'sql') { await env.DB.exec(sql); return Response.json({ ready: true }) }
      return new Response('Unknown fixture action', { status: 400 })
    } catch (error) { return Response.json({ message: error instanceof Error ? error.message : 'Failed' }, { status: error instanceof LedgerError ? error.statusCode : 500 }) }
  },
}
