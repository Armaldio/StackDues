import { ledgerEndpoint } from '../../data/http.ts'
import { getProviderConnectionStatus, loadProviderCredentials } from '../../security/provider-credentials.ts'
import { readSupabaseTelemetry } from '../../providers/supabase-telemetry.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const status = await getProviderConnectionStatus(db, 'supabase')
  if (!status.configured) return { configured: false, status, observations: [] }
  const env = event.context.cloudflare?.env as { CREDENTIALS_KEY?: string } | undefined
  const credentials = await loadProviderCredentials(db, 'supabase', env?.CREDENTIALS_KEY)
  return { configured: true, status, observations: await readSupabaseTelemetry(db, credentials?.organizationSlug) }
}))
