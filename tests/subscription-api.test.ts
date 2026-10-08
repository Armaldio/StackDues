import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStoredSubscription, deleteStoredSubscription, fetchSubscriptions, importStoredSubscriptions, parseStoredSubscriptions, serializeSubscriptionExport, SUBSCRIPTION_EXPORT_FILENAME } from '../src/lib/subscription-api.ts'
const item = { id: 'legacy', name: 'Bitwarden', billingType: 'fixed' as const, amount: 10, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year' as const, nextRenewalAt: '2026-10-08', status: 'active' as const }

test('server ledger rejects corrupted revisions, duplicate ids and invalid financial records', () => {
  assert.deepEqual(parseStoredSubscriptions([{ ...item, revision: 2 }]), [{ ...item, provider: undefined, revision: 2 }])
  for (const value of [null, [{ ...item, revision: 0 }], [{ ...item, revision: 1.5 }], [{ ...item, revision: 1 }, { ...item, revision: 1 }], [{ ...item, amount: Infinity, revision: 1 }]]) assert.throws(() => parseStoredSubscriptions(value))
})
test('database/network/session failures never become an empty successful ledger or leak raw errors', async t => {
  for (const status of [401, 409, 503]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response('private-provider-secret', { status }))
    await assert.rejects(fetchSubscriptions(), error => error instanceof Error && !error.message.includes('private-provider-secret'))
    mock.mock.restore()
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private-network-info') })
  await assert.rejects(fetchSubscriptions(), /displayed records have been kept/)
})
test('unconfirmed writes and imports fail visibly instead of replacing displayed records', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('{', { status: 200 }))
  await assert.rejects(createStoredSubscription(item), /whether your changes were saved/)
  mock.mock.restore()
  t.mock.method(globalThis, 'fetch', async () => Response.json({ subscriptions: [], createdIds: [] }))
  await assert.rejects(importStoredSubscriptions([item]), /could not be verified/)
})

test('delete sends a quoted revision header without a request body', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, '/api/subscriptions/legacy')
    assert.equal(options?.method, 'DELETE')
    assert.equal(options?.body, undefined)
    assert.equal(new Headers(options?.headers).get('If-Match'), '"2"')
    return Response.json({ deleted: true })
  })
  await deleteStoredSubscription(item.id, 2)
})

test('subscription export matches the importer schema and omits server-only properties', async t => {
  const stored = { ...item, provider: 'Hostinger', revision: 7, encryptedCredentials: 'private-provider-secret', sessionToken: 'private-session-token', password: 'private-password', cookie: 'private-cookie', apiKey: 'private-api-key', errorTrace: 'private-error-trace' }
  const json = serializeSubscriptionExport([stored])
  assert.equal(SUBSCRIPTION_EXPORT_FILENAME, 'stackdues-subscriptions.json')
  assert.deepEqual(JSON.parse(json), [{ ...item, provider: 'Hostinger' }])
  assert.doesNotMatch(json, /revision|encryptedCredentials|private-provider-secret|sessionToken|private-session-token|password|private-password|cookie|private-cookie|apiKey|private-api-key|errorTrace|private-error-trace/)

  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.method, 'POST')
    const body = JSON.parse(String(options?.body)) as { subscriptions: unknown[] }
    assert.deepEqual(body.subscriptions, JSON.parse(json))
    return Response.json({ subscriptions: [{ ...item, provider: 'Hostinger', revision: 1 }], createdIds: ['legacy'] })
  })
  const imported = await importStoredSubscriptions(JSON.parse(json))
  assert.deepEqual(imported.createdIds, ['legacy'])
})

test('subscription export rejects data outside existing importer limits', () => {
  const records = Array.from({ length: 1_001 }, (_, index) => ({ ...item, id: `item-${index}`, revision: 1 }))
  assert.throws(() => serializeSubscriptionExport(records), /1,000-subscription import limit/)
  assert.throws(() => serializeSubscriptionExport([{ ...item, name: 'x'.repeat(1_048_600), revision: 1 }]), /1 MB import limit/)
})
