import { ledgerEndpoint } from '../../data/http.ts'
import { readCloudflareRegistrarDiscovery } from '../../data/cloudflare-registrar.ts'

export default defineEventHandler(event => ledgerEndpoint(event, readCloudflareRegistrarDiscovery))
