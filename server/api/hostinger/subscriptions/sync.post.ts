import { ledgerEndpoint } from '../../../data/http.ts'
import { refreshHostingerEntries } from '../../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, db => {
  const key = (event.context.cloudflare?.env as { CREDENTIALS_KEY?: string } | undefined)?.CREDENTIALS_KEY
  return refreshHostingerEntries(db, key)
}))
