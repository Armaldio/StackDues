import { ledgerEndpoint } from '../../../data/http.ts'
import { LedgerError } from '../../../data/ledger.ts'
import { collectSupabaseTelemetry, persistSupabaseTelemetry, readSupabaseTelemetry } from '../../../providers/supabase-telemetry.ts'
import { getProviderConnectionStatus, loadProviderCredentials } from '../../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const status = await getProviderConnectionStatus(db, 'supabase')
  if (!status.configured) throw new LedgerError(409, 'Connect Supabase before checking telemetry.')
  const env = event.context.cloudflare?.env as { CREDENTIALS_KEY?: string } | undefined
  const credentials = await loadProviderCredentials(db, 'supabase', env?.CREDENTIALS_KEY)
  if (!credentials) throw new LedgerError(409, 'Connect Supabase before checking telemetry.')
  const observations = await collectSupabaseTelemetry(credentials)
  await persistSupabaseTelemetry(db, observations)
  return { configured: true, status, observations: await readSupabaseTelemetry(db, credentials.organizationSlug) }
}))
