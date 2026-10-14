import { ledgerBody, ledgerEndpoint, subscriptionId } from '../../data/http.ts'
import { patchStoredSubscription } from '../../data/ledger.ts'
import { hostingerEditStatement } from '../../data/hostinger.ts'
import { cloudflareEditStatement } from '../../data/cloudflare-commitments.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const body = await ledgerBody(event)
  return patchStoredSubscription(db, subscriptionId(event), body.subscription, body.revision, async (item, revision) => {
    const statements = await Promise.all([hostingerEditStatement(db, item, revision), cloudflareEditStatement(db, item, revision)])
    return statements.filter((statement): statement is D1PreparedStatement => statement !== null)
  })
}))
