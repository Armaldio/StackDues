import { authPage } from './auth-pages.ts'
import { createSession, hashPassword, secureEqual, SESSION_COOKIE, SESSION_MAX_AGE, verifyPassword, verifySession } from '../server/security/auth.ts'

export type AuthBindings = CloudflareEnv & { SESSION_SECRET?: string; SETUP_TOKEN?: string }
type Owner = { email: string; password_hash: string }
const privateHeaders = { 'Cache-Control': 'no-store' }
const appDocumentRoutes = new Set(['/', '/services', '/connections', '/history'])
function isAppDocumentPath(path: string) { return appDocumentRoutes.has(path.replace(/\/+$/, '') || '/') }
function deny(status = 401) { return new Response('Authentication required', { status, headers: privateHeaders }) }
function redirect(path: string, cookie?: string) { const headers = new Headers({ ...privateHeaders, Location: path }); if (cookie) headers.set('Set-Cookie', cookie); return new Response(null, { status: 303, headers }) }
function cookie(token: string, age = SESSION_MAX_AGE) { return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}` }
function sessionToken(request: Request) { return request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) }
function sameOrigin(request: Request) {
  const origin = request.headers.get('Origin')
  const site = request.headers.get('Sec-Fetch-Site')
  if (site === 'cross-site') return false
  if (origin === new URL(request.url).origin) return true
  // Some browsers submit same-origin HTML forms with an opaque Origin. Accept
  // that only when Fetch Metadata confirms the document and request are same-origin.
  return origin === 'null' && site === 'same-origin'
}
async function readForm(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new Error('Invalid form')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Missing form')
  let length = 0
  const chunks: Uint8Array[] = []
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 8192) { await reader.cancel(); throw new Error('Form too large') }; chunks.push(value) }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const form = new URLSearchParams(new TextDecoder().decode(bytes))
  for (const key of ['email', 'password', 'code']) if (form.getAll(key).length > 1) throw new Error('Duplicate field')
  return form
}

/** Return a public auth response or null only after authenticating a protected request. */
export async function authGate(request: Request, env: AuthBindings): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (request.method === 'GET' && (path === '/login' || path === '/register')) return authPage(path === '/register')
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
  if (mutation && !sameOrigin(request)) return deny(403)
  try {
    if (!env.DB || !env.SESSION_SECRET || !env.OWNER_EMAIL) return deny(503)
    const isAuthPost = request.method === 'POST' && (path === '/auth/login' || path === '/auth/register')
    if (isAuthPost && (!env.LOGIN_RATE_LIMIT || !(await env.LOGIN_RATE_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success)) return new Response('Too many attempts. Try again in a minute.', { status: 429, headers: { ...privateHeaders, 'Retry-After': '60' } })
    const owner = await env.DB.prepare('SELECT email, password_hash FROM owner_credentials WHERE singleton = 1').first<Owner>()
    const config = { ownerEmail: owner?.email, passwordHash: owner?.password_hash, sessionSecret: env.SESSION_SECRET }
    if (isAuthPost) {
      const form = await readForm(request)
      const email = form.get('email')?.trim().toLowerCase() ?? ''
      const password = form.get('password') ?? ''
      if (path === '/auth/register') {
        if (owner || email !== env.OWNER_EMAIL || !env.SETUP_TOKEN || !await secureEqual(form.get('code') ?? '', env.SETUP_TOKEN)) return authPage(true, 'Account setup failed. Check your email and setup code, or sign in if already registered.')
        const passwordHash = await hashPassword(password)
        const inserted = await env.DB.prepare('INSERT INTO owner_credentials(singleton, email, password_hash, created_at) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO NOTHING').bind(email, passwordHash, new Date().toISOString()).run()
        if (inserted.meta.changes !== 1) return authPage(true, 'Account already created. Please sign in.')
        const token = await createSession({ ownerEmail: email, passwordHash, sessionSecret: env.SESSION_SECRET })
        if (!token) return deny(503)
        return redirect('/', cookie(token))
      }
      // Verify even for a wrong email to avoid exposing the configured owner's identity.
      const correctPassword = owner ? await verifyPassword(password, owner.password_hash) : false
      if (!owner || email !== owner.email || !correctPassword) return authPage(false, 'Email or password is incorrect.')
      const token = await createSession(config)
      if (!token) return deny(503)
      return redirect('/', cookie(token))
    }
    const identity = await verifySession(sessionToken(request), config)
    if (!identity) {
      if (request.method === 'GET' && isAppDocumentPath(path) && request.headers.get('Accept')?.includes('text/html')) return redirect('/login')
      return deny()
    }
    if (request.method === 'POST' && path === '/auth/logout') return redirect('/login', cookie('', 0))
    // Never let unsupported auth routes fall through to the private SPA renderer.
    if (path.startsWith('/auth/')) return new Response('Not found', { status: 404, headers: privateHeaders })
    return null
  } catch {
    // No passwords, tokens, SQL errors or provider credentials enter response/logs.
    return new Response('Request could not be completed. Check the form or try again.', { status: 503, headers: privateHeaders })
  }
}
