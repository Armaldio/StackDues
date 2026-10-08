import { ledgerBody, ledgerEndpoint } from '../../../../data/http.ts'
import { linkHostingerToLedger } from '../../../../data/hostinger.ts'

export default defineEventHandler(event => ledgerEndpoint(event, async db => {
  const body = await ledgerBody(event)
  return linkHostingerToLedger(db, getRouterParam(event, 'externalId', { decode: true }) ?? '', String(body.subscriptionId ?? ''), body.revision, body.mode)
}))
