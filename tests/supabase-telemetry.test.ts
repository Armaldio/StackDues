import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectSupabaseTelemetry } from '../server/providers/supabase-telemetry.ts'
import { emptyCostFeed } from '../src/lib/cost-feed.ts'

const credentials = { apiToken: 'TEST_SCOPED_SUPABASE_PAT', organizationSlug: 'team-stackdues' }
const now = new Date('2026-10-13T12:00:00.000Z')
function response(value: unknown) { return Response.json(value) }

test('Supabase reads organization projects and documented project telemetry with bounded, read-only requests', async () => {
  const calls: { url: URL; authorization: string | null; method: string | undefined }[] = []
  const observations = await collectSupabaseTelemetry(credentials, now, { fetch: async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url, authorization: new Headers(init?.headers).get('Authorization'), method: init?.method })
    if (url.pathname.endsWith('/organizations/team-stackdues/projects')) return response({ projects: [
      { ref: 'abcdefghijklmnopqrst', name: 'Main app' },
      { ref: 'bcdefghijklmnopqrstu', name: 'Worker' },
    ], pagination: { count: 2, limit: 100, offset: 0 } })
    return response({ result: [
      { timestamp: '2026-10-12T00:00:00Z', total_auth_requests: 4, total_realtime_requests: 1, total_rest_requests: 8, total_storage_requests: 2 },
      { timestamp: '2026-10-13T00:00:00Z', total_auth_requests: 7, total_realtime_requests: 2, total_rest_requests: 12, total_storage_requests: 3 },
    ], error: null })
  } })
  assert.equal(calls.length, 3)
  assert.ok(calls.every(call => call.authorization === `Bearer ${credentials.apiToken}` && call.method === undefined))
  assert.equal(calls[0]!.url.pathname, '/v1/organizations/team-stackdues/projects')
  assert.equal(calls[0]!.url.searchParams.get('limit'), '100')
  assert.equal(calls[0]!.url.searchParams.get('offset'), '0')
  assert.ok(calls.slice(1).every(call => call.url.pathname.includes('/analytics/endpoints/usage.api-counts') && call.url.searchParams.get('interval') === '1day'))
  assert.equal(observations.length, 4)
  assert.equal(observations[0]!.capturedAt, now.toISOString())
  assert.equal(observations[0]!.restRequests, 8)
  assert.equal(observations[1]!.observedAt, '2026-10-13T00:00:00Z')
  assert.equal(observations[2]!.projectName, 'Worker')
})

test('malformed counts and upstream failures fail closed without returning the token', async () => {
  for (const fetcher of [
    async () => response([{ ref: 'abcdefghijklmnopqrst', name: 'Main app' }]),
    async (input: RequestInfo | URL) => new URL(String(input)).pathname.endsWith('/projects') ? response({ projects: [{ ref: 'abcdefghijklmnopqrst', name: 'Main app' }], pagination: { count: 1, limit: 100, offset: 0 } }) : response({ result: [{ timestamp: '2026-10-13T00:00:00Z', total_auth_requests: -1, total_realtime_requests: 0, total_rest_requests: 0, total_storage_requests: 0 }] }),
    async () => new Response('private provider error', { status: 403 }),
  ]) {
    await assert.rejects(() => collectSupabaseTelemetry(credentials, now, { fetch: fetcher as typeof fetch }), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes(credentials.apiToken))
      return true
    })
  }
})

test('request-count telemetry has no provider slot in the financial cost feed', () => {
  const feed = emptyCostFeed()
  assert.deepEqual(Object.keys(feed.providers).sort(), ['aws', 'cloudflare', 'digitalocean', 'openai'])
  assert.deepEqual(feed.snapshots, [])
})
