import { ledgerBody, ledgerEndpoint, subscriptionId } from '../../data/http.ts'
import { patchStoredSubscription } from '../../data/ledger.ts'
import { hostingerEditStatement } from '../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const body = await ledgerBody(event)
  return patchStoredSubscription(db, subscriptionId(event), body.subscription, body.revision, (item, revision) => hostingerEditStatement(db, item, revision))
}))
