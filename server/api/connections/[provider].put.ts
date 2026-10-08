import { ledgerBody, ledgerEndpoint } from '../../data/http.ts'
import { LedgerError } from '../../data/ledger.ts'
import { saveProviderCredentials, validateCredentialProvider } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const body = await ledgerBody(event)
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 8192) throw new LedgerError(400, 'Provider credential requests must be no larger than 8 KB.')
  const provider = validateCredentialProvider(getRouterParam(event, 'provider', { decode: true }))
  const key = (event.context.cloudflare?.env as { CREDENTIALS_KEY?: string } | undefined)?.CREDENTIALS_KEY
  return saveProviderCredentials(db, provider, body.credentials, body.revision, key)
}))
