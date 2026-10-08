// Nitro generates this runtime entry during the build; it has no declaration file.
// @ts-ignore generated Nitro module has no stable declaration file
import nitro from '../.output/server/index.mjs'
import { authGate, type AuthBindings } from './auth-gate.ts'

export default {
  async fetch(request: Request, env: AuthBindings, context: ExecutionContext): Promise<Response> {
    const authResponse = await authGate(request, env)
    if (authResponse) return authResponse
    const response = await nitro.fetch(request, env, context)
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'same-origin')
    headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
