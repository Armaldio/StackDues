import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCostSnapshot } from '../src/domain/usage-costs.ts'
import { emptyCostSyncState, refreshCosts } from '../server/sync.ts'

const now = new Date('2026-10-07T12:00:00Z')
const old = createCostSnapshot({ id: 'old', provider: 'cloudflare', periodStart: '2026-10-01', periodEnd: '2026-10-06', amount: 2, currency: 'USD', kind: 'actual', capturedAt: '2026-10-06T12:00:00Z', metadata: { period: 'current' } })
const fresh = createCostSnapshot({ ...old, id: 'new', provider: 'aws', amount: 4, capturedAt: now.toISOString() })

test('one broken provider cannot block another or replace previous successful snapshots', async () => {
  const previous = { ...emptyCostSyncState(), snapshots: [old], providers: { ...emptyCostSyncState().providers,
    cloudflare: { status: 'synced' as const, lastSyncedAt: old.capturedAt },
  } }
  const state = await refreshCosts(previous, [
    { provider: 'aws', configured: true, collect: async () => [fresh] },
    { provider: 'cloudflare', configured: true, collect: async () => { throw new Error('provider-secret') } },
  ], now)
  assert.deepEqual(state.snapshots, [old, fresh])
  assert.equal(state.providers.aws.status, 'synced')
  assert.equal(state.providers.aws.lastSyncedAt, now.toISOString())
  assert.equal(state.providers.cloudflare.status, 'error')
  assert.equal(state.providers.cloudflare.lastAttemptAt, now.toISOString())
  assert.equal(state.providers.cloudflare.lastSyncedAt, old.capturedAt)
  assert.ok(!JSON.stringify(state).includes('provider-secret'))
  assert.equal(previous.snapshots.length, 1)
  assert.equal(previous.providers.cloudflare.status, 'synced')
})

test('both providers begin refreshing independently', async () => {
  let release!: () => void
  const stalled = new Promise<void>((resolve) => { release = resolve })
  let cloudflareStarted = false
  const pending = refreshCosts(emptyCostSyncState(), [
    { provider: 'aws', configured: true, collect: async () => { await stalled; return [fresh] } },
    { provider: 'cloudflare', configured: true, collect: async () => { cloudflareStarted = true; release(); return [old] } },
  ], now)
  const state = await pending
  assert.equal(cloudflareStarted, true)
  assert.equal(state.snapshots.length, 2)
})

test('unconfigured providers do not request credentials or fabricate zero usage', async () => {
  const state = await refreshCosts(emptyCostSyncState(), [
    { provider: 'aws', configured: false, collect: async () => { throw new Error('must not run') } },
    { provider: 'cloudflare', configured: false, collect: async () => { throw new Error('must not run') } },
  ], now)
  assert.deepEqual(state.snapshots, [])
  assert.equal(state.providers.aws.status, 'not-configured')
  assert.equal(state.providers.cloudflare.status, 'not-configured')
  assert.equal(state.providers.aws.lastSyncedAt, undefined)
  assert.equal(state.providers.aws.lastAttemptAt, undefined)
})

test('malformed or wrong-provider results fail atomically and preserve historical snapshots', async () => {
  for (const result of [[fresh, { ...fresh, amount: Number.NaN }], [{ ...fresh, provider: 'cloudflare' as const }]]) {
    const state = await refreshCosts({ ...emptyCostSyncState(), snapshots: [old] }, [
      { provider: 'aws', configured: true, collect: async () => result },
    ], now)
    assert.deepEqual(state.snapshots, [old])
    assert.equal(state.providers.aws.status, 'error')
  }
})

test('a later successful refresh appends history and clears stale provider errors', async () => {
  const previous = { ...emptyCostSyncState(), snapshots: [old], providers: { ...emptyCostSyncState().providers,
    aws: { status: 'error' as const, error: 'AWS refresh failed.' },
  } }
  const state = await refreshCosts(previous, [{ provider: 'aws', configured: true, collect: async () => [fresh] }], now)
  assert.deepEqual(state.snapshots, [old, fresh])
  assert.equal(state.providers.aws.error, undefined)
  assert.equal(state.providers.aws.status, 'synced')
  assert.ok(Object.isFrozen(state.snapshots))
})
