import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectCloudflareCosts } from '../server/providers/cloudflare.ts'

const accountId = '023e105f4ecef8ad9ca31a8372d0c353'
const options = { accountId, apiToken: 'server-secret', now: new Date('2026-10-07T12:00:00Z') }
const row = {
  BillingCurrency: 'USD', BillingPeriodStart: '2026-09-15T00:00:00Z',
  ChargePeriodStart: '2026-10-05T00:00:00Z', ChargePeriodEnd: '2026-10-06T00:00:00Z',
  ServiceName: 'Workers Standard', ContractedCost: 0.75, CumulatedContractedCost: 900,
  ConsumedQuantity: 50000000,
}
const response = (result: unknown) => new Response(JSON.stringify({ success: true, result }))

test('Cloudflare uses monetary charge-period costs and exposes service breakdown without accumulating running totals', async () => {
  const snapshots = await collectCloudflareCosts({ ...options, fetch: async (url, init) => {
    assert.equal(String(url), `https://api.cloudflare.com/client/v4/accounts/${accountId}/billable-usage`)
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer server-secret')
    assert.ok(init?.signal)
    return response([row, { ...row, ServiceName: 'R2 Storage', ContractedCost: 1.25 }])
  } })
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0]?.amount, 2)
  assert.equal(snapshots[0]?.periodStart, '2026-09-15')
  assert.equal(snapshots[0]?.periodEnd, '2026-10-06')
  assert.equal(snapshots[0]?.metadata?.period, 'current')
  assert.deepEqual(snapshots[0]?.metadata?.breakdown, [
    { service: 'R2 Storage', amount: 1.25, currency: 'USD' },
    { service: 'Workers Standard', amount: 0.75, currency: 'USD' },
  ])
  assert.equal(snapshots[0]?.metadata?.projectionUnavailable, true)
  assert.ok(!JSON.stringify(snapshots).includes(options.apiToken))
})

test('Cloudflare keeps currencies and billing periods separate and retains credits', async () => {
  const snapshots = await collectCloudflareCosts({ ...options, fetch: async () => response([
    row, { ...row, ContractedCost: -0.25 }, { ...row, BillingCurrency: 'EUR', ContractedCost: 2 },
    { ...row, BillingPeriodStart: '2026-10-01T00:00:00Z', ContractedCost: 3 },
  ]) })
  assert.deepEqual(snapshots.map(({ amount, currency, periodStart }) => [amount, currency, periodStart]), [
    [0.5, 'USD', '2026-09-15'], [2, 'EUR', '2026-09-15'], [3, 'USD', '2026-10-01'],
  ])
})

test('empty Cloudflare data does not manufacture a zero-dollar actual snapshot', async () => {
  assert.deepEqual(await collectCloudflareCosts({ ...options, fetch: async () => response([]) }), [])
})

test('replaying a Cloudflare capture produces stable IDs and separate later observations', async () => {
  const collect = (now: Date) => collectCloudflareCosts({ ...options, now, fetch: async () => response([row]) })
  const first = await collect(options.now)
  assert.deepEqual(await collect(options.now), first)
  const later = await collect(new Date(options.now.getTime() + 1000))
  assert.notEqual(later[0]?.id, first[0]?.id)
})

test('Cloudflare preserves its reported interval when the charge ends during the day', async () => {
  const [snapshot] = await collectCloudflareCosts({ ...options, fetch: async () => response([
    { ...row, ChargePeriodEnd: '2026-10-06T23:59:59Z' },
  ]) })
  assert.equal(snapshot?.periodEnd, '2026-10-07')
  assert.equal(snapshot?.metadata?.reportedThrough, '2026-10-06T23:59:59.000Z')
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot?.metadata))
})

test('Cloudflare rejects malformed costs, currency, dates, and unpriced usage rather than reporting a false total', async () => {
  for (const invalid of [
    { ...row, ContractedCost: undefined }, { ...row, ContractedCost: '1' },
    { ...row, ContractedCost: null }, { ...row, BillingCurrency: 'dollars' },
    { ...row, ChargePeriodEnd: '2026-02-30T00:00:00Z' },
    { ...row, ChargePeriodEnd: row.ChargePeriodStart },
    { ...row, BillingPeriodStart: '2026-10-07T00:00:00Z' },
  ]) {
    await assert.rejects(collectCloudflareCosts({ ...options, fetch: async () => response([invalid]) }), /invalid billing data/)
  }
})

test('Cloudflare sanitizes authorization, API envelope, network, and parse failures', async () => {
  const failures: typeof fetch[] = [
    async () => new Response('server-secret', { status: 403 }),
    async () => new Response('server-secret', { status: 500 }),
    async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'server-secret' }], result: [] })),
    async () => { throw new Error('server-secret') },
    async () => new Response('server-secret'),
  ]
  for (const fetch of failures) {
    await assert.rejects(collectCloudflareCosts({ ...options, fetch }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.startsWith('Cloudflare '))
      assert.ok(!error.message.includes('server-secret'))
      return true
    })
  }
})

test('Cloudflare stops a stalled request after its bounded timeout', async () => {
  await assert.rejects(collectCloudflareCosts({ ...options, timeoutMs: 10, fetch: async (_url, init) =>
    await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('secret'))))
  }), /Cloudflare request timed out/)
})

test('Cloudflare refuses silently truncated result sets', async () => {
  await assert.rejects(collectCloudflareCosts({ ...options, fetch: async () => new Response(JSON.stringify({
    success: true, result: [row], result_info: { total_pages: 2, page: 1 },
  })) }), /incomplete billing data/)
})

test('Cloudflare credentials stay out of requests when configuration is invalid', async () => {
  await assert.rejects(collectCloudflareCosts({ ...options, accountId: '../other', fetch: async () => { throw new Error('must not request') } }), /configuration/)
})
