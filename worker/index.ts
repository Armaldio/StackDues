// Nitro generates this runtime entry during the build; it has no declaration file.
// @ts-ignore generated Nitro module has no stable declaration file
import nitro from '../.output/server/index.mjs'
import { authGate, type AuthBindings } from './auth-gate.ts'
import { syncCosts } from '../server/worker-sync.ts'

type WorkerBindings = AuthBindings & { CREDENTIALS_KEY?: string }

export default {
  scheduled(controller: ScheduledController, env: WorkerBindings, context: ExecutionContext): void {
    context.waitUntil(syncCosts(env, new Date(controller.scheduledTime)))
  },
  async fetch(request: Request, env: WorkerBindings, context: ExecutionContext): Promise<Response> {
    const authResponse = await authGate(request, env)
    if (authResponse) return authResponse
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/costs/refresh') {
      const limit = await env.COST_REFRESH_RATE_LIMIT.limit({ key: 'owner-cost-refresh' })
      if (!limit.success) return new Response('Please wait before refreshing providers again.', { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } })
    }
    // Nitro's Cloudflare adapter buffers bodies; bound the ingress stream first.
    let routed = request
    if (request.body) {
      const maximumBodySize = new URL(request.url).pathname.startsWith('/api/connections/') ? 8 * 1024 : 1024 * 1024
      const reader = request.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maximumBodySize) { await reader.cancel(); return new Response('Request body too large', { status: 413, headers: { 'Cache-Control': 'no-store' } }) }
        chunks.push(value)
      }
      const body = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
      routed = new Request(request.url, { method: request.method, headers: request.headers, body })
    }
    const response = await nitro.fetch(routed, env, context)
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'private, no-store')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'same-origin')
    headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  },
}
