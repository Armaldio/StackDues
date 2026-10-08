import { ledgerEndpoint, subscriptionId, subscriptionRevision } from '../../data/http.ts'
import { deleteStoredSubscription } from '../../data/ledger.ts'
import { hostingerDeleteExclusionStatement } from '../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  return deleteStoredSubscription(db, subscriptionId(event), subscriptionRevision(event), (id, revision) => hostingerDeleteExclusionStatement(db, id, revision))
}))
