import { ledgerBody, ledgerEndpoint } from '../data/http.ts'
import { createStoredSubscription } from '../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => createStoredSubscription(db, await ledgerBody(event))))
