import { ledgerEndpoint } from '../data/http.ts'
import { readCostFeed } from '../data/ledger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, readCostFeed))
