import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteConnection, fetchConnections, parseConnectionStatus, parseConnectionStatuses, refreshProviders, saveConnection } from '../src/lib/connection-api.ts'
const empty = { configured: false, revision: 0 }

test('connection responses retain status fields only and require valid revision/timestamps', () => {
  const states = parseConnectionStatuses({ aws: { configured: true, revision: 1, secretAccessKey: 'private' }, cloudflare: empty, hostinger: { configured: false, revision: 2, ciphertext: 'private' } })
  assert.deepEqual(states.aws, { configured: true, revision: 1 })
  assert.deepEqual(states.hostinger, { configured: false, revision: 2 })
  for (const row of [null, { configured: true, revision: 0 }, { configured: false, revision: -1 }, { configured: true, revision: 1.5 }, { configured: true, revision: 1, updatedAt: '2026-02-30T00:00:00Z' }]) assert.throws(() => parseConnectionStatus(row))
  assert.throws(() => parseConnectionStatuses({ aws: empty }))
})
test('saving sends credentials only in authenticated request body and confirms changed status', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, '/api/connections/aws')
    assert.equal(options?.method, 'PUT')
    assert.equal(options?.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(options?.body as string), { credentials: { accessKeyId: 'key', secretAccessKey: 'private' }, revision: 2 })
    return Response.json({ configured: true, revision: 3, secretAccessKey: 'private' })
  })
  assert.deepEqual(await saveConnection('aws', { accessKeyId: 'key', secretAccessKey: 'private' }, 2), { configured: true, revision: 3 })
})
test('disconnect carries revision in If-Match without a body and preserves tombstone revision', async t => {
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    assert.equal(options?.method, 'DELETE')
    assert.equal(options?.body, undefined)
    assert.equal(new Headers(options?.headers).get('If-Match'), '"3"')
    return Response.json({ configured: false, revision: 4 })
  })
  assert.deepEqual(await deleteConnection('aws', 3), { configured: false, revision: 4 })
})
test('connection/session/conflict/rate-limit failures never expose raw server errors', async t => {
  for (const status of [401, 409, 429, 503]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('private-secret-and-provider-error', { status }))
    await assert.rejects(fetchConnections(), error => error instanceof Error && !error.message.includes('private-secret') && 'status' in error && error.status === status)
    mock.mock.restore()
  }
})
test('manual refresh makes authenticated POST and accepts empty success responses', async t => {
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => { assert.equal(url, '/api/costs/refresh'); assert.equal(options?.method, 'POST'); assert.equal(options?.credentials, 'same-origin'); return new Response(null, { status: 204 }) })
  await refreshProviders()
})
test('provider refresh reports failure when the feed records an unsuccessful collection', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ providers: { aws: { status: 'error' } } }))
  await assert.rejects(refreshProviders('aws'), /provider refresh did not complete/i)
})
test('provider refresh requires a confirmed synced status in its feed', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ providers: { cloudflare: { status: 'synced' } } }))
  await assert.rejects(refreshProviders('aws'), /provider refresh did not complete/i)
})
test('provider-specific refresh is scoped and duplicate in-flight requests coalesce', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: unknown, options?: RequestInit) => {
    calls++
    assert.equal(url, '/api/costs/refresh?provider=cloudflare')
    assert.equal(options?.method, 'POST')
    await new Promise(resolve => setTimeout(resolve, 20))
    return Response.json({ providers: { cloudflare: { status: 'synced' } } })
  })
  await Promise.all([refreshProviders('cloudflare'), refreshProviders('cloudflare')])
  assert.equal(calls, 1)
})
