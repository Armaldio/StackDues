import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentCostSnapshots, emptyCostFeed, fetchCostFeed, isProviderStale, parseCostFeed } from '../src/lib/cost-feed.ts'

const snapshot = { id: 'a', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-11-01', kind: 'actual', amount: 4, currency: 'USD', capturedAt: '2026-10-07T12:00:00Z', metadata: { period: 'current', breakdown: [{ service: 'EC2', amount: 4, currency: 'USD' }] } }
test('public cost feed validates observations and removes unrecognized fields and raw errors', () => {
  const feed = parseCostFeed({ snapshots: [{ ...snapshot, apiToken: 'private', metadata: { ...snapshot.metadata, password: 'private' } }], providers: { aws: { status: 'error', error: 'private' }, cloudflare: { status: 'not-configured' } } })
  assert.equal(feed.snapshots[0]?.amount, 4)
  assert.ok(!JSON.stringify(feed).includes('private'))
  assert.ok(Object.isFrozen(feed.snapshots))
})
test('invalid snapshots or statuses are rejected atomically', () => {
  for (const input of [null, {}, { ...emptyCostFeed(), snapshots: [{ ...snapshot, amount: null }] }, { ...emptyCostFeed(), providers: { aws: { status: 'success' }, cloudflare: { status: 'not-configured' } } }, { ...emptyCostFeed(), snapshots: [{ ...snapshot, metadata: { breakdown: [{ amount: '4' }] } }] }]) assert.throws(() => parseCostFeed(input))
})
test('feed request failures remain failures, never zero cost data', async () => {
  await assert.rejects(fetchCostFeed('https://example.test/costs', async () => new Response('broken', { status: 500 })))
  await assert.rejects(fetchCostFeed('https://example.test/costs', async () => new Response('{')))
  assert.deepEqual(await fetchCostFeed('https://example.test/costs', async () => Response.json(emptyCostFeed())), parseCostFeed(emptyCostFeed()))
})
test('invalid successful-sync timestamps are rejected instead of being normalized to another date', () => {
  assert.throws(() => parseCostFeed({ ...emptyCostFeed(), providers: { aws: { status: 'synced', lastSyncedAt: '2026-02-30T12:00:00Z' }, cloudflare: { status: 'not-configured' } } }))
})
test('staleness uses the last successful sync with a 36-hour grace period', () => {
  const now = new Date('2026-10-07T12:00:00Z')
  assert.equal(isProviderStale({ status: 'error', lastSyncedAt: '2026-10-05T00:00:00Z' }, now), true)
  assert.equal(isProviderStale({ status: 'synced', lastSyncedAt: '2026-10-07T00:00:00Z' }, now), false)
  assert.equal(isProviderStale({ status: 'not-configured' }, now), false)
})

test('empty successful captures suppress older costs while failures retain the last successful observations', () => {
  const feed = parseCostFeed({ ...emptyCostFeed(), snapshots: [snapshot], providers: { aws: { status: 'synced', lastSyncedAt: '2026-10-08T12:00:00Z' }, cloudflare: { status: 'not-configured' } } })
  assert.deepEqual(currentCostSnapshots(feed), [])
  const failed = parseCostFeed({ ...feed, providers: { ...feed.providers, aws: { status: 'error', lastSyncedAt: snapshot.capturedAt } } })
  assert.equal(currentCostSnapshots(failed)[0]?.amount, 4)
})
