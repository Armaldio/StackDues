import { ledgerEndpoint } from '../../data/http.ts'
import { syncCosts, type CostSyncBindings } from '../../worker-sync.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => {
  const env = event.context.cloudflare?.env as Partial<CostSyncBindings> | undefined
  return syncCosts({ DB: db, CREDENTIALS_KEY: env?.CREDENTIALS_KEY })
}))
