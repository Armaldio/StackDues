import { ledgerEndpoint, subscriptionId, subscriptionRevision } from '../../data/http.ts'
import { deleteStoredSubscription } from '../../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  return deleteStoredSubscription(db, subscriptionId(event), subscriptionRevision(event))
}))
