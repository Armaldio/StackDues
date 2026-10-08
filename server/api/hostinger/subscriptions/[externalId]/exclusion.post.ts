import { ledgerEndpoint } from '../../../../data/http.ts'
import { setHostingerExclusion } from '../../../../data/hostinger.ts'

export default defineEventHandler(async event => {
  const body = await readBody<{ excluded?: unknown }>(event)
  return ledgerEndpoint(event, db => setHostingerExclusion(db, getRouterParam(event, 'externalId', { decode: true }) ?? '', body?.excluded))
})
