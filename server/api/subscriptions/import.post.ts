import { ledgerBody, ledgerEndpoint } from '../../data/http.ts'
import { importSubscriptions } from '../../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => importSubscriptions(db, (await ledgerBody(event)).subscriptions)))
