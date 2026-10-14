import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCloudflareSubscriptions } from '../server/providers/cloudflare-subscriptions.ts'

const accountId = '023e105f4ecef8ad9ca31a8372d0c353'
const apiToken = 'server-secret'
const workerPlan = {
  id: '506e3185e9c882d175a2d0cb0093d9f2',
  currency: 'USD',
  current_period_start: '2026-10-15T00:00:00Z',
  current_period_end: '2026-11-15T00:00:00Z',
  frequency: 'monthly',
  price: 12.34,
  rate_plan: { id: 'workers_paid', public_name: 'Workers Paid Plan', scope: 'account', sets: ['workers'] },
  state: 'Paid',
}
const response = (result: unknown[], totalCount = result.length) => new Response(JSON.stringify({
  success: true,
  result,
  result_info: { count: result.length, page: 1, per_page: 100, total_count: totalCount },
}))

test('Cloudflare discovers active Workers plans as fixed subscriptions with provider renewal fields', async () => {
  const urls: string[] = []
  const subscriptions = await fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async (url, init) => {
    urls.push(String(url))
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${apiToken}`)
    if (new URL(String(url)).search) return new Response('unsupported query parameters', { status: 400 })
    return response([workerPlan, {
      ...workerPlan,
      id: 'a06e3185e9c882d175a2d0cb0093d9f1',
      rate_plan: { id: 'business', public_name: 'Business Plan', scope: 'zone', sets: ['zone'] },
    }])
  } })

  assert.deepEqual(urls, [`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`])
  assert.deepEqual(subscriptions, [{
    externalId: workerPlan.id,
    state: 'Paid',
    commitment: {
      name: 'Workers Paid Plan', amount: 12.34, currency: 'USD',
      recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: '2026-11-15', status: 'active',
    },
  }])
  assert.ok(!JSON.stringify(subscriptions).includes(apiToken))
})

test('Cloudflare maps documented renewal frequencies without changing the provider price', async () => {
  const plans = [
    ['weekly', 1, 'week'], ['monthly', 1, 'month'], ['quarterly', 3, 'month'], ['yearly', 1, 'year'],
  ] as const
  for (const [frequency, recurrenceInterval, recurrenceUnit] of plans) {
    const [subscription] = await fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response([{ ...workerPlan, frequency }]) })
    assert.equal(subscription?.commitment?.recurrenceInterval, recurrenceInterval)
    assert.equal(subscription?.commitment?.recurrenceUnit, recurrenceUnit)
    assert.equal(subscription?.commitment?.amount, workerPlan.price)
  }
})

test('Cloudflare accepts optional display currency and records the billed subscription price in USD', async () => {
  for (const currency of [undefined, 'EUR']) {
    const [subscription] = await fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response([{ ...workerPlan, currency }]) })
    assert.equal(subscription?.commitment?.amount, workerPlan.price)
    assert.equal(subscription?.commitment?.currency, 'USD')
  }
})

test('Cloudflare marks non-paid Worker subscriptions inactive while retaining their provider identity', async () => {
  const [subscription] = await fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response([{ ...workerPlan, state: 'Cancelled' }]) })
  assert.equal(subscription?.externalId, workerPlan.id)
  assert.equal(subscription?.state, 'Cancelled')
  assert.equal(subscription?.commitment?.status, 'cancelled')
})

test('Cloudflare keeps trial and provisioned plans visible as upcoming fixed commitments', async () => {
  for (const state of ['Trial', 'Provisioned', 'AwaitingPayment']) {
    const [subscription] = await fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response([{ ...workerPlan, state }]) })
    assert.equal(subscription?.commitment?.status, 'active', state)
  }
})

test('Cloudflare rejects incomplete account responses instead of silently omitting subscriptions', async () => {
  const results = Array.from({ length: 100 }, (_, index) => ({ ...workerPlan, id: `${String(index).padStart(32, '0')}` }))
  await assert.rejects(fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response(results, 101) }), /incomplete subscription data/)
  await assert.rejects(fetchCloudflareSubscriptions({ accountId, apiToken, fetch: async () => response([workerPlan], 0) }), /incomplete subscription data/)
})

test('Cloudflare sanitizes authorization, malformed plan, network, and timeout failures', async () => {
  const failures: typeof fetch[] = [
    async () => new Response('server-secret', { status: 403 }),
    async () => response([{ ...workerPlan, price: '12.34' }]),
    async () => { throw new Error('server-secret') },
    async (_url, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('server-secret')))),
  ]
  for (const fetch of failures) {
    await assert.rejects(fetchCloudflareSubscriptions({ accountId, apiToken, timeoutMs: 10, fetch }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.startsWith('Cloudflare '))
      assert.ok(!error.message.includes('server-secret'))
      return true
    })
  }
})
