import { getQuery } from 'h3'
import { ledgerEndpoint } from '../../data/http.ts'
import { syncCosts, type CostSyncBindings } from '../../worker-sync.ts'
import { LedgerError } from '../../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => {
  const env = event.context.cloudflare?.env as Partial<CostSyncBindings> | undefined
  const requested = getQuery(event).provider
  if (requested !== undefined && (typeof requested !== 'string' || !['aws', 'cloudflare', 'openai'].includes(requested))) throw new LedgerError(400, 'Choose a supported provider to refresh.')
  return syncCosts({ DB: db, CREDENTIALS_KEY: env?.CREDENTIALS_KEY }, new Date(), {}, requested ? [requested as 'aws' | 'cloudflare' | 'openai'] : undefined)
}))
