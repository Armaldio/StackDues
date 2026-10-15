import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchCloudflareRegistrations } from '../server/providers/cloudflare-registrar.ts'

const accountId = '023e105f4ecef8ad9ca31a8372d0c353'
const apiToken = 'server-secret'
const registration = {
  domain_name: 'example.com',
  status: 'active',
  expires_at: '2027-04-02T00:00:00Z',
  auto_renew: true,
  registrant_contact: { email: 'private@example.com', address: 'private address' },
}

test('Cloudflare registration discovery follows cursor pages and persists only renewal fields', async () => {
  const urls: URL[] = []
  const result = await fetchCloudflareRegistrations({ accountId, apiToken, fetch: async url => {
    const parsed = new URL(String(url))
    urls.push(parsed)
    if (urls.length === 1) return Response.json({ success: true, result: [registration], result_info: { count: 1, per_page: 50, cursor: 'opaque cursor' } })
    return Response.json({ success: true, result: [{ ...registration, domain_name: 'example.net', auto_renew: false, expires_at: null, status: 'transfer_pending' }], result_info: { count: 1, per_page: 50, cursor: '' } })
  } })

  assert.deepEqual(urls.map(url => `${url.pathname}${url.search}`), [
    `/client/v4/accounts/${accountId}/registrar/registrations?per_page=50`,
    `/client/v4/accounts/${accountId}/registrar/registrations?per_page=50&cursor=opaque+cursor`,
  ])
  assert.deepEqual(result, [
    { domainName: 'example.com', status: 'active', expiresAt: '2027-04-02', autoRenew: true },
    { domainName: 'example.net', status: 'transfer_pending', expiresAt: null, autoRenew: false },
  ])
  assert.ok(!JSON.stringify(result).includes('private@example.com'))
  assert.ok(!JSON.stringify(result).includes('private address'))
})

test('Cloudflare registration discovery treats a complete empty account as successful', async () => {
  const result = await fetchCloudflareRegistrations({ accountId, apiToken, fetch: async () => Response.json({
    success: true, result: [], result_info: { count: 0, per_page: 50, cursor: '',
    },
  }) })
  assert.deepEqual(result, [])
})

test('Cloudflare registration discovery rejects incomplete, duplicate, and malformed results', async () => {
  const invalid = [
    { success: true, result: [registration], result_info: { count: 2, per_page: 50, cursor: '' } },
    { success: true, result: [registration, { ...registration, domain_name: 'EXAMPLE.COM' }], result_info: { count: 2, per_page: 50, cursor: '' } },
    { success: true, result: [{ ...registration, auto_renew: 'yes' }], result_info: { count: 1, per_page: 50, cursor: '' } },
    { success: true, result: [{ ...registration, expires_at: 'not-a-date' }], result_info: { count: 1, per_page: 50, cursor: '' } },
  ]
  for (const body of invalid) await assert.rejects(fetchCloudflareRegistrations({ accountId, apiToken, fetch: async () => Response.json(body) }), /invalid|incomplete/i)
})

test('Cloudflare registration authorization and transport failures are sanitized', async () => {
  for (const fetch of [
    async () => new Response('server-secret', { status: 403 }),
    async () => { throw new Error('server-secret') },
  ] as typeof globalThis.fetch[]) {
    await assert.rejects(fetchCloudflareRegistrations({ accountId, apiToken, fetch }), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.ok(error.message.startsWith('Cloudflare '))
      assert.ok(!error.message.includes('server-secret'))
      return true
    })
  }
})
