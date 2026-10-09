import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectOpenAiCosts } from '../server/providers/openai.ts'

const now = new Date('2026-10-09T12:00:00.000Z')
const bucket = (start: string, results: unknown[]) => ({ start_time: Date.parse(`${start}T00:00:00Z`) / 1000, end_time: Date.parse(`${start}T00:00:00Z`) / 1000 + 86_400, results })
const cost = (value: number | string, currency: string, lineItem: string | null, projectId: string | null = null) => ({ amount: { value, currency }, line_item: lineItem, project_id: projectId, api_key_id: null, quantity: null, quantity_unit: null })

test('OpenAI daily costs normalize currencies and breakdowns without treating repeated pages as new charges', async () => {
  const requests: URL[] = []
  const snapshots = await collectOpenAiCosts({
    adminApiKey: 'TEST_OPENAI_ADMIN_KEY', now,
    fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url)
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer TEST_OPENAI_ADMIN_KEY')
      assert.equal(url.searchParams.get('bucket_width'), '1d')
      assert.equal(url.searchParams.getAll('group_by[]').join(','), 'line_item,project_id')
      if (!url.searchParams.has('page')) return Response.json({ data: [bucket('2026-10-08', [cost(1.25, 'usd', 'Images', 'proj_a'), cost(2.75, 'usd', 'Responses', 'proj_a')])], has_more: true, next_page: 'cursor-2' })
      return Response.json({ data: [bucket('2026-10-09', [cost('3', 'usd', 'Responses'), cost(1, 'eur', 'Audio')])], has_more: false, next_page: null })
    },
  })

  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.searchParams.get('page'), 'cursor-2')
  assert.equal(snapshots.length, 3)
  assert.deepEqual(snapshots.map(row => [row.periodStart, row.amount, row.currency]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[2]).localeCompare(String(b[2]))), [
    ['2026-10-08', 4, 'USD'], ['2026-10-09', 1, 'EUR'], ['2026-10-09', 3, 'USD'],
  ])
  assert.equal(snapshots.find(row => row.periodStart === '2026-10-08')?.metadata?.period, 'current')
  assert.deepEqual(snapshots.find(row => row.periodStart === '2026-10-08')?.metadata?.breakdown, [
    { service: 'Images · proj_a', amount: 1.25, currency: 'USD' },
    { service: 'Responses · proj_a', amount: 2.75, currency: 'USD' },
  ])
})

test('OpenAI costs reject repeated cursors, malformed amounts and unsupported currencies atomically', async () => {
  for (const response of [
    { data: [], has_more: true, next_page: 'repeat' },
    { data: [bucket('2026-10-09', [cost(Number.NaN, 'usd', 'Responses')])], has_more: false },
    { data: [bucket('2026-10-09', [cost(2, 'not-a-currency', 'Responses')])], has_more: false },
  ]) {
    let calls = 0
    await assert.rejects(collectOpenAiCosts({ adminApiKey: 'TEST_OPENAI_ADMIN_KEY', now, fetch: async () => {
      calls++
      return Response.json({ ...response, ...(calls > 1 ? { next_page: 'repeat' } : {}) })
    } }))
  }
})

test('OpenAI pagination rejects duplicate daily result rows instead of counting a row twice', async () => {
  let page = 0
  await assert.rejects(collectOpenAiCosts({ adminApiKey: 'TEST_OPENAI_ADMIN_KEY', now, fetch: async () => {
    page++
    return Response.json({ data: [bucket('2026-10-09', [cost(2, 'usd', 'Responses')])], has_more: page === 1, next_page: page === 1 ? 'next' : null })
  } }), /overlapping paginated cost data/)
})

test('OpenAI permission and rate-limit responses are actionable and contain no response body', async () => {
  for (const [status, expected] of [[403, /Admin API key and organization costs access/], [429, /rate limit/]] as const) {
    await assert.rejects(collectOpenAiCosts({ adminApiKey: 'TEST_OPENAI_ADMIN_KEY', now, fetch: async () => new Response('TEST_SECRET_BODY', { status }) }), expected)
  }
})

test('OpenAI organization cost endpoint can return an empty completed report without inventing a zero observation', async () => {
  const snapshots = await collectOpenAiCosts({ adminApiKey: 'TEST_OPENAI_ADMIN_KEY', now, fetch: async () => Response.json({ data: [], has_more: false }) })
  assert.deepEqual(snapshots, [])
})
