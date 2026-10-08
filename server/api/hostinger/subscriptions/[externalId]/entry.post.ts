import { ledgerEndpoint } from '../../../../data/http.ts'
import { createHostingerLedgerEntry } from '../../../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => createHostingerLedgerEntry(db, getRouterParam(event, 'externalId', { decode: true }) ?? '')))
