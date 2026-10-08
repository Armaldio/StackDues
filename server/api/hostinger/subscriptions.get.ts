import { ledgerEndpoint } from '../../data/http.ts'
import { readHostingerDiscovery } from '../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, readHostingerDiscovery))
