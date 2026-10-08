import { ledgerEndpoint, subscriptionRevision } from '../../data/http.ts'
import { removeProviderCredentials, validateCredentialProvider } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => {
  const provider = validateCredentialProvider(getRouterParam(event, 'provider', { decode: true }))
  return removeProviderCredentials(db, provider, subscriptionRevision(event))
}))
