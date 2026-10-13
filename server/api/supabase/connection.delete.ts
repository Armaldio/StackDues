import { getHeader } from 'h3'
import { ledgerEndpoint } from '../../data/http.ts'
import { LedgerError } from '../../data/ledger.ts'
import { removeProviderCredentials } from '../../security/provider-credentials.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const header = getHeader(event, 'If-Match')
  const revision = typeof header === 'string' && /^"[1-9]\d*"$/.test(header) ? Number(header.slice(1, -1)) : NaN
  if (!Number.isSafeInteger(revision)) throw new LedgerError(400, 'If-Match must contain one quoted positive connection revision.')
  return removeProviderCredentials(db, 'supabase', revision)
}))
