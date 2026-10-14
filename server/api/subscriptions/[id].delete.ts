import { ledgerEndpoint, subscriptionId, subscriptionRevision } from '../../data/http.ts'
import { deleteStoredSubscription } from '../../data/ledger.ts'
import { hostingerDeleteExclusionStatement } from '../../data/hostinger.ts'
import { cloudflareDeleteExclusionStatement } from '../../data/cloudflare-commitments.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  return deleteStoredSubscription(db, subscriptionId(event), subscriptionRevision(event), async (id, revision) => {
    const statements = await Promise.all([hostingerDeleteExclusionStatement(db, id, revision), cloudflareDeleteExclusionStatement(db, id, revision)])
    return statements.filter((statement): statement is D1PreparedStatement => statement !== null)
  })
}))
