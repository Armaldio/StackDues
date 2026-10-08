import { ledgerEndpoint } from '../data/http.ts'
import { listSubscriptions } from '../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, listSubscriptions))
