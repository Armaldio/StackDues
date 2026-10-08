import { ledgerEndpoint } from '../../data/http.ts'
import { listProviderConnections } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, listProviderConnections))
