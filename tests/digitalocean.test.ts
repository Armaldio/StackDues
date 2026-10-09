import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDigitalOceanInvoices } from '../server/providers/digitalocean.ts'

const now = new Date('2026-10-09T12:00:00.000Z')

test('DigitalOcean imports finalized invoice totals, aggregates within billing period, and excludes preview', async () => {
  let callCount = 0
  const snapshots = await collectDigitalOceanInvoices({
    apiToken: 'TEST_DIGITALOCEAN_TOKEN', now,
    fetch: async (input, init) => {
      callCount++
      assert.equal(new URL(String(input)).pathname, '/v2/customers/my/invoices')
      assert.equal(new URL(String(input)).searchParams.get('per_page'), '200')
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer TEST_DIGITALOCEAN_TOKEN')
      return Response.json({
        invoices: [
          { invoice_uuid: 'inv-1', invoice_id: '2026-08-01', invoice_period: '2026-08', amount: '12.50' },
          { invoice_uuid: 'inv-2', invoice_id: 'credit-adjustment', invoice_period: '2026-08', amount: '-2.50' },
          { invoice_uuid: 'inv-3', invoice_id: '2026-09-01', invoice_period: '2026-09', amount: '20' },
        ],
        invoice_preview: { amount: '999999.99', invoice_period: '2026-10' },
        links: { pages: { next: null } }, meta: { total: 3 },
      })
    },
  })
  assert.equal(callCount, 1)
  assert.deepEqual(snapshots.map(row => [row.periodStart, row.periodEnd, row.amount, row.currency, row.kind]), [
    ['2026-08-01', '2026-09-01', 10, 'USD', 'actual'],
    ['2026-09-01', '2026-10-01', 20, 'USD', 'actual'],
  ])
  assert.equal(snapshots[0]?.metadata?.scope, 'finalized-invoice-total')
  assert.equal(snapshots[0]?.metadata?.invoiceCount, 2)
  assert.ok(!snapshots.some(row => row.periodStart === '2026-10-01'))
})

test('DigitalOcean invoice pages are bounded and repeated invoices fail as incomplete data', async () => {
  const pages: number[] = []
  const snapshots = await collectDigitalOceanInvoices({
    apiToken: 'TEST_DIGITALOCEAN_TOKEN', now,
    fetch: async input => {
      const page = Number(new URL(String(input)).searchParams.get('page'))
      pages.push(page)
      return Response.json({ invoices: page === 1
        ? Array.from({ length: 200 }, (_, index) => ({ invoice_uuid: `inv-${index}`, invoice_id: `id-${index}`, invoice_period: '2026-01', amount: '1' }))
        : [{ invoice_uuid: 'last', invoice_id: 'last', invoice_period: '2026-02', amount: '2' }] })
    },
  })
  assert.deepEqual(pages, [1, 2])
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0]?.amount, 200)
})

test('DigitalOcean auth and rate-limit failures stay generic, malformed invoice data is rejected, and empty results are not zero', async () => {
  for (const [status, message] of [[403, /billing:read/], [429, /rate limit/]] as const) {
    await assert.rejects(collectDigitalOceanInvoices({ apiToken: 'TEST_DIGITALOCEAN_TOKEN', now, fetch: async () => new Response('TEST_DIGITALOCEAN_TOKEN must not leak', { status }) }), message)
  }
  await assert.rejects(collectDigitalOceanInvoices({ apiToken: 'TEST_DIGITALOCEAN_TOKEN', now, fetch: async () => Response.json({ invoices: [{ invoice_uuid: 'x', invoice_id: 'x', invoice_period: 'not-a-month', amount: '1' }] }) }), /invalid invoice data/)
  const empty = await collectDigitalOceanInvoices({ apiToken: 'TEST_DIGITALOCEAN_TOKEN', now, fetch: async () => Response.json({ invoices: [], invoice_preview: { amount: '8' } }) })
  assert.deepEqual(empty, [])
})
