import { ledgerBody, ledgerEndpoint } from '../../data/http.ts'
import { LedgerError } from '../../data/ledger.ts'
import { saveProviderCredentials } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const body = await ledgerBody(event)
  const env = event.context.cloudflare?.env as { CREDENTIALS_KEY?: string } | undefined
  return saveProviderCredentials(db, 'supabase', body.credentials, body.revision, env?.CREDENTIALS_KEY)
}))
