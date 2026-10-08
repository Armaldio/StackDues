import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchHostingerSubscriptions, normalizeHostingerSubscription } from '../server/providers/hostinger.ts'

const fixture = { id: 'host-kvm-1', name: 'KVM 1', status: 'active', billing_period: 12, billing_period_unit: 'month', currency_code: 'USD', total_price: 8999, renewal_price: 17999, is_auto_renewed: true, created_at: '2025-10-08T11:54:22Z', expires_at: null, next_billing_at: '2026-10-08T11:54:22Z' }

test('Hostinger maps renewal cents, not introductory total price, and anchors to next billing date', () => {
  const row = normalizeHostingerSubscription(fixture)
  assert.equal(row.totalPrice, 89.99)
  assert.equal(row.renewalPrice, 179.99)
  assert.equal(row.recurrenceInterval, 12)
  assert.equal(row.recurrenceUnit, 'month')
  assert.equal(row.nextBillingAt, '2026-10-08T11:54:22.000Z')
  assert.equal(row.nextBillingDate, '2026-10-08')
})

test('keeps the provider billing calendar date when an offset timestamp crosses UTC midnight', () => {
  const row = normalizeHostingerSubscription({ ...fixture, next_billing_at: '2027-01-01T00:30:00+02:00' })
  assert.equal(row.nextBillingAt, '2026-12-31T22:30:00.000Z')
  assert.equal(row.nextBillingDate, '2027-01-01')
})

test('non-renewing services have no future billing date even if a stale value is returned', () => {
  const row = normalizeHostingerSubscription({ ...fixture, status: 'not_renewing', is_auto_renewed: false, next_billing_at: '2026-10-08T11:54:22Z', expires_at: '2027-10-08T11:54:22Z' })
  assert.equal(row.nextBillingAt, null)
  assert.equal(row.expiresAt, '2027-10-08T11:54:22.000Z')
})

test('unknown periods and missing renewal dates stay visible without guessed recurrence', () => {
  const unknown = normalizeHostingerSubscription({ ...fixture, billing_period_unit: 'fortnight', next_billing_at: null })
  assert.equal(unknown.recurrenceInterval, null)
  assert.equal(unknown.recurrenceUnit, 'unsupported')
  assert.equal(unknown.nextBillingAt, null)
  const none = normalizeHostingerSubscription({ ...fixture, billing_period_unit: 'none' })
  assert.equal(none.recurrenceUnit, null)
})

test('Hostinger rejects malformed IDs, prices, dates, currencies and duplicate IDs', async () => {
  for (const row of [
    { ...fixture, id: '' }, { ...fixture, renewal_price: -1 }, { ...fixture, total_price: 1.5 },
    { ...fixture, created_at: 'yesterday' }, { ...fixture, currency_code: 'US' },
  ]) assert.throws(() => normalizeHostingerSubscription(row))
  await assert.rejects(fetchHostingerSubscriptions('fake-token', { fetch: async () => Response.json([fixture, fixture]) }))
})

test('Hostinger sends a read-only bearer request, bounds results and sanitizes failures', async () => {
  let request: Request | undefined
  const rows = await fetchHostingerSubscriptions('fake-token', { fetch: async (input, init) => { request = new Request(input, init); return Response.json([fixture]) } })
  assert.equal(rows.length, 1)
  assert.equal(request?.method, 'GET')
  assert.equal(request?.url, 'https://developers.hostinger.com/api/billing/v1/subscriptions')
  assert.equal(request?.headers.get('Authorization'), 'Bearer fake-token')
  assert.equal(request?.body, null)
  await assert.rejects(fetchHostingerSubscriptions('secret-token', { fetch: async () => new Response('secret-token in body', { status: 403 }) }), error => error instanceof Error && !error.message.includes('secret-token'))
  await assert.rejects(fetchHostingerSubscriptions('fake-token', { fetch: async () => new Response(JSON.stringify([fixture]), { headers: { 'Content-Length': String(2 * 1024 * 1024) } }) }), /too large/i)
})
