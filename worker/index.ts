// Nitro generates this runtime entry during the build; it has no declaration file.
// @ts-expect-error generated module
import nitro from '../.output/server/index.mjs'
import { verifyAccessToken } from '../server/security/access.ts'

type Bindings = {
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUDIENCE?: string
  OWNER_EMAIL?: string
  ASSETS: { fetch(request: Request): Promise<Response> }
}
export default {
  async fetch(request: Request, env: Bindings, context: unknown): Promise<Response> {
    const identity = await verifyAccessToken(request.headers.get('Cf-Access-Jwt-Assertion'), {
      teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUDIENCE, ownerEmail: env.OWNER_EMAIL,
    })
    if (!identity) return new Response('Access denied', { status: 403, headers: { 'Cache-Control': 'no-store' } })
    const response = await nitro.fetch(request, env, context)
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'same-origin')
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
