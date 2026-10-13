import { ledgerEndpoint } from '../../data/http.ts'
import { getProviderConnectionStatus } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => getProviderConnectionStatus(db, 'supabase')))
