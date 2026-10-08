import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyCostFeed, parseCostFeed } from '../src/lib/cost-feed.ts'
import { loadPreviousFeed, runRefresh, writeCostFeed } from '../scripts/refresh-costs.ts'

test('first deployment accepts missing history but transient or corrupt history stops publication', async () => {
  assert.deepEqual(await loadPreviousFeed('https://example.test/data', async () => new Response('', { status: 404 })), emptyCostFeed())
  for (const request of [async () => new Response('', { status: 500 }), async () => new Response('{'), async () => { throw new Error('secret') }]) {
    await assert.rejects(loadPreviousFeed('https://example.test/data', request), error => error instanceof Error && error.message.includes('Publication stopped') && !error.message.includes('secret'))
  }
})
test('previous deployment snapshots and sync dates are recovered for later refreshes', async () => {
  const state = { ...emptyCostFeed(), snapshots: [{ id: 'a', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-10-07', amount: 10, currency: 'USD', kind: 'actual', capturedAt: '2026-10-07T12:00:00Z', metadata: { period: 'current' } }] }
  assert.deepEqual(await loadPreviousFeed('https://example.test/data', async () => Response.json(state)), parseCostFeed(state))
})
test('publication is opt-in and missing credentials never trigger a provider call', async () => {
  for (const state of [
    await runRefresh({ AWS_ACCESS_KEY_ID: 'private', AWS_SECRET_ACCESS_KEY: 'private', PREVIOUS_COST_FEED_URL: 'https://must-not-request.invalid' }),
    await runRefresh({ PUBLISH_PROVIDER_COSTS: 'true' }),
  ]) {
    assert.deepEqual(state.snapshots, [])
    for (const provider of [state.providers.aws, state.providers.cloudflare]) {
      assert.equal(provider.status, 'not-configured')
      if (provider.lastAttemptAt !== undefined) assert.ok(Number.isFinite(Date.parse(provider.lastAttemptAt)))
    }
  }
})
test('atomic feed writer publishes only validated public fields and preserves file on validation failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-feed-'))
  const path = join(directory, 'data/costs.json')
  try {
    await writeCostFeed(path, emptyCostFeed())
    const previous = await readFile(path, 'utf8')
    await assert.rejects(writeCostFeed(path, { ...emptyCostFeed(), snapshots: [{}] } as never))
    assert.equal(await readFile(path, 'utf8'), previous)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
