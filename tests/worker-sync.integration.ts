import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CostFeed } from '../src/lib/cost-feed.ts'
import { latestCostSnapshots } from '../src/domain/usage-costs.ts'
import type { StoredSubscription } from '../server/data/ledger.ts'

type WorkerSyncResponse = { feed: CostFeed; calls: { aws: number; cloudflare: number; openai: number; digitalocean: number }; diagnostics: { event: string; provider: string; stage: string; kind: string; attemptedAt: string }[]; message?: string }

test('Worker sync isolates providers and commits honest observations in real D1', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-sync-'))
  const fixture = JSON.parse(await readFile(new URL('./fixtures/sync-worker.wrangler.jsonc', import.meta.url), 'utf8'))
  const configPath = join(directory, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify({ ...fixture, main: fileURLToPath(new URL('./fixtures/sync-worker.ts', import.meta.url)) }))
  const workerProcess = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8795', '--inspector-port', '9235', '--persist-to', join(directory, 'state')], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  let output = ''
  workerProcess.stdout.on('data', chunk => { output += chunk })
  workerProcess.stderr.on('data', chunk => { output += chunk })
  async function call<T = WorkerSyncResponse>(input: Record<string, unknown>, status = 200): Promise<T> {
    const response = await fetch('http://127.0.0.1:8795/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const body = await response.json() as T
    assert.equal(response.status, status, JSON.stringify(body))
    assert.ok(!JSON.stringify(body).includes('TEST_FAKE_'))
    return body
  }
  try {
    const deadline = Date.now() + 50_000
    while (!output.includes('Ready on')) {
      if (workerProcess.exitCode !== null || Date.now() > deadline) throw new Error(`Sync Worker startup failed: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await call({ action: 'initialize' })
    await t.test('absent credentials skip all provider requests and record attempts without zero snapshots', async () => {
      const { feed, calls } = await call({ action: 'manual', mode: 'missing' })
      assert.deepEqual(calls, { aws: 0, cloudflare: 0, openai: 0, digitalocean: 0 })
      assert.deepEqual(feed.snapshots, [])
      for (const provider of ['aws', 'cloudflare', 'openai', 'digitalocean'] as const) assert.deepEqual(feed.providers[provider], { status: 'not-configured', lastAttemptAt: '2026-10-08T12:00:00.000Z' })
    })
    await t.test('manual and scheduled attempts share normalization and stable retry IDs', async () => {
      const manual = await call({ action: 'manual', mode: 'success', now: '2026-10-08T13:00:00Z' })
      assert.deepEqual(manual.calls, { aws: 4, cloudflare: 2, openai: 1, digitalocean: 1 })
      assert.equal(manual.feed.snapshots.length, 7)
      assert.equal(manual.feed.snapshots.find(item => item.kind === 'forecast')?.amount, 19)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'cloudflare')?.amount, 2)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'openai')?.amount, 2.25)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'openai')?.currency, 'USD')
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'digitalocean')?.amount, 18.4)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'digitalocean')?.metadata?.scope, 'finalized-invoice-total')
      assert.ok(!JSON.stringify(manual).includes('TEST_DIGITALOCEAN_TOKEN'))
      const registrar = await call<{ registrations: { domainName: string; status: string; expiresAt: string | null; autoRenew: boolean; seenInLatestSync: boolean }[]; sync: { status: string; lastSyncedAt?: string } }>({ action: 'registrar' })
      assert.equal(registrar.sync.status, 'synced')
      assert.equal(registrar.sync.lastSyncedAt, '2026-10-08T13:00:00.000Z')
      assert.deepEqual(registrar.registrations, [{ domainName: 'example.com', status: 'active', expiresAt: '2027-04-02', autoRenew: true, seenInLatestSync: true }])
      assert.ok(!JSON.stringify(registrar).includes('registrant_contact'))
      assert.ok(!JSON.stringify(registrar).includes('private@example.com'))
      const commitments = await call<StoredSubscription[]>({ action: 'subscriptions' })
      const workers = commitments.filter(row => row.provider === 'Cloudflare')
      assert.equal(workers.length, 1)
      assert.deepEqual({ name: workers[0]?.name, amount: workers[0]?.amount, currency: workers[0]?.currency, interval: workers[0]?.recurrenceInterval, unit: workers[0]?.recurrenceUnit, next: workers[0]?.nextRenewalAt, status: workers[0]?.status }, {
        name: 'Workers Paid Plan', amount: 12.34, currency: 'USD', interval: 1, unit: 'month', next: '2026-11-15', status: 'active',
      })
      const scheduled = await call({ action: 'scheduled', mode: 'success', now: '2026-10-08T13:00:00Z' })
      assert.deepEqual(scheduled.feed, manual.feed)
      const repeated = await call<StoredSubscription[]>({ action: 'subscriptions' })
      assert.equal(repeated.filter(row => row.provider === 'Cloudflare').length, 1, 'a repeated automatic sync must not duplicate the fixed plan')
    })
    await t.test('authorization and decryption failures preserve AWS history while Cloudflare succeeds', async () => {
      for (const [mode, hour] of [['aws-error', '14'], ['credential-error', '15']] as const) {
        const { feed, calls } = await call({ action: 'manual', mode, now: `2026-10-08T${hour}:00:00Z` })
        assert.equal(feed.providers.aws.status, 'error')
        assert.equal(feed.providers.aws.lastSyncedAt, '2026-10-08T13:00:00.000Z')
        assert.equal(feed.snapshots.filter(item => item.provider === 'aws').length, 4)
        assert.equal(feed.providers.cloudflare.status, 'synced')
        assert.equal(calls.aws, mode === 'credential-error' ? 0 : 1)
      }
    })
    await t.test('OpenAI authorization failure preserves its last good costs and does not expose the Admin key', async () => {
      const failed = await call({ action: 'manual', mode: 'openai-error', providers: ['openai'], now: '2026-10-08T15:30:00Z' })
      assert.deepEqual(failed.calls, { aws: 0, cloudflare: 0, openai: 1, digitalocean: 0 })
      assert.equal(failed.feed.providers.openai.status, 'error')
      assert.equal(failed.feed.providers.openai.lastSyncedAt, '2026-10-08T15:00:00.000Z')
      assert.equal(failed.feed.snapshots.filter(item => item.provider === 'openai').length, 3)
      assert.equal(latestCostSnapshots(failed.feed.snapshots).filter(item => item.provider === 'openai').length, 1, 'repeated cumulative reports remain revisions, not added charges')
      assert.ok(!JSON.stringify(failed).includes('TEST_OPENAI_ADMIN_KEY'))
    })
    await t.test('DigitalOcean authorization failure preserves final invoice observations and does not expose the token', async () => {
      const failed = await call({ action: 'manual', mode: 'digitalocean-error', providers: ['digitalocean'], now: '2026-10-08T15:45:00Z' })
      assert.deepEqual(failed.calls, { aws: 0, cloudflare: 0, openai: 0, digitalocean: 1 })
      assert.equal(failed.feed.providers.digitalocean.status, 'error')
      assert.equal(failed.feed.providers.digitalocean.lastSyncedAt, '2026-10-08T15:00:00.000Z')
      assert.equal(failed.feed.snapshots.filter((item: { provider: string }) => item.provider === 'digitalocean').length, 3)
      assert.equal(latestCostSnapshots(failed.feed.snapshots).filter(item => item.provider === 'digitalocean')[0]?.amount, 18.4, 'invoice captures are revisions rather than repeated charges')
      assert.ok(!JSON.stringify(failed).includes('TEST_DIGITALOCEAN_TOKEN'))
    })
    await t.test('timeout and malformed money are failures rather than fresh zero totals', async () => {
      const timedOut = await call({ action: 'scheduled', mode: 'timeout', now: '2026-10-08T16:00:00Z' })
      assert.equal(timedOut.feed.providers.aws.status, 'error')
      const malformed = await call({ action: 'manual', mode: 'malformed', now: '2026-10-08T17:00:00Z' })
      assert.equal(malformed.feed.providers.cloudflare.status, 'error')
      assert.equal(malformed.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T16:00:00.000Z')
      assert.equal(malformed.feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
      assert.deepEqual(malformed.diagnostics, [{ event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'billable_usage', kind: 'invalid_response', attemptedAt: '2026-10-08T17:00:00.000Z' }])
      const credentialsFailed = await call({ action: 'manual', mode: 'cloudflare-credential-error', providers: ['cloudflare'], now: '2026-10-08T17:15:00Z' })
      assert.equal(credentialsFailed.feed.providers.cloudflare.status, 'error')
      assert.equal(credentialsFailed.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T16:00:00.000Z')
      assert.deepEqual(credentialsFailed.diagnostics, [{ event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'credentials', kind: 'configuration', attemptedAt: '2026-10-08T17:15:00.000Z' }])
    })
    await t.test('a failed Cloudflare transaction does not block AWS or save partial Cloudflare history', async () => {
      await call({ action: 'sql', sql: "CREATE TRIGGER fail_sync BEFORE INSERT ON provider_sync_status WHEN NEW.provider = 'cloudflare' BEGIN SELECT RAISE(ABORT, 'TEST_FAKE_CLOUDFLARE_TOKEN database error'); END;" })
      await call({ action: 'manual', mode: 'success', now: '2026-10-08T18:00:00Z' }, 503)
      const response = await fetch('http://127.0.0.1:8795/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'costs' }) })
      const feed = await response.json() as CostFeed
      assert.equal(feed.providers.aws.lastSyncedAt, '2026-10-08T18:00:00.000Z')
      assert.equal(feed.providers.cloudflare.lastAttemptAt, '2026-10-08T17:15:00.000Z')
      assert.equal(feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
      await call({ action: 'sql', sql: 'DROP TRIGGER fail_sync;' })
    })
    await t.test('a successful empty collection retains history and advances the successful capture', async () => {
      const { feed } = await call({ action: 'scheduled', mode: 'empty-cloudflare', now: '2026-10-08T19:00:00Z' })
      assert.equal(feed.providers.cloudflare.status, 'synced')
      assert.equal(feed.providers.cloudflare.lastSyncedAt, '2026-10-08T19:00:00.000Z')
      assert.equal(feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
      assert.ok(!feed.snapshots.some(item => item.provider === 'cloudflare' && item.capturedAt === '2026-10-08T19:00:00.000Z'))
      const commitments = await call<StoredSubscription[]>({ action: 'subscriptions' })
      assert.equal(commitments.filter(row => row.provider === 'Cloudflare' && row.status === 'active').length, 1, 'an empty report must retain the last known commitment')
    })
    await t.test('a provider-specific refresh contacts only the newly connected provider', async () => {
      const { feed, calls } = await call({ action: 'manual', mode: 'success', providers: ['cloudflare'], now: '2026-10-08T20:00:00Z' })
      assert.deepEqual(calls, { aws: 0, cloudflare: 2, openai: 0, digitalocean: 0 })
      assert.equal(feed.providers.cloudflare.lastSyncedAt, '2026-10-08T20:00:00.000Z')
      assert.equal(feed.providers.aws.lastSyncedAt, '2026-10-08T19:00:00.000Z')
    })
    await t.test('Cloudflare trial plans stay visible as fixed commitments and subscription failures preserve them', async () => {
      await call({ action: 'manual', mode: 'cloudflare-trial', providers: ['cloudflare'], now: '2026-10-08T21:00:00Z' })
      const trial = (await call<StoredSubscription[]>({ action: 'subscriptions' })).find(row => row.provider === 'Cloudflare')
      assert.equal(trial?.status, 'active')
      const failed = await call({ action: 'manual', mode: 'cloudflare-subscription-error', providers: ['cloudflare'], now: '2026-10-08T22:00:00Z' })
      assert.equal(failed.feed.providers.cloudflare.status, 'error')
      assert.equal(failed.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T21:00:00.000Z')
      assert.equal(failed.feed.snapshots.filter(item => item.provider === 'cloudflare').length, 6)
      assert.deepEqual(failed.diagnostics, [{ event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'subscriptions', kind: 'authorization', attemptedAt: '2026-10-08T22:00:00.000Z' }])
      const commitments = await call<StoredSubscription[]>({ action: 'subscriptions' })
      const workers = commitments.filter(row => row.provider === 'Cloudflare')
      assert.equal(workers.length, 1)
      assert.equal(workers[0]?.amount, 12.34)
      const bothFailed = await call({ action: 'manual', mode: 'cloudflare-both-error', providers: ['cloudflare'], now: '2026-10-08T22:30:00Z' })
      assert.equal(bothFailed.feed.providers.cloudflare.status, 'error')
      assert.equal(bothFailed.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T21:00:00.000Z')
      assert.equal(bothFailed.feed.snapshots.filter(item => item.provider === 'cloudflare').length, 6)
      assert.deepEqual(bothFailed.diagnostics, [
        { event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'billable_usage', kind: 'authorization', attemptedAt: '2026-10-08T22:30:00.000Z' },
        { event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'subscriptions', kind: 'authorization', attemptedAt: '2026-10-08T22:30:00.000Z' },
      ])
      const notFound = await call({ action: 'manual', mode: 'cloudflare-subscription-not-found', providers: ['cloudflare'], now: '2026-10-08T22:45:00Z' })
      assert.equal(notFound.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T21:00:00.000Z')
      assert.equal(notFound.feed.snapshots.filter(item => item.provider === 'cloudflare').length, 6)
      assert.deepEqual(notFound.diagnostics, [{ event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'subscriptions', kind: 'http_404', attemptedAt: '2026-10-08T22:45:00.000Z' }])
      const notFoundCommitments = (await call<StoredSubscription[]>({ action: 'subscriptions' })).filter(row => row.provider === 'Cloudflare')
      assert.equal(notFoundCommitments.length, 1)
      assert.equal(notFoundCommitments[0]?.amount, 12.34)
    })
    await t.test('missing Registrar permission retains prior discoveries without failing billing sync', async () => {
      const failed = await call({ action: 'manual', mode: 'registrar-error', providers: ['cloudflare'], now: '2026-10-09T00:00:00Z' })
      assert.equal(failed.feed.providers.cloudflare.status, 'synced')
      assert.deepEqual(failed.diagnostics, [{ event: 'cloudflare_collection_failed', provider: 'cloudflare', stage: 'registrar', kind: 'authorization', attemptedAt: '2026-10-09T00:00:00.000Z' }])
      const registrar = await call<{ registrations: { domainName: string; seenInLatestSync: boolean }[]; sync: { status: string; lastSyncedAt?: string } }>({ action: 'registrar' })
      assert.equal(registrar.sync.status, 'error')
      assert.equal(registrar.sync.lastSyncedAt, '2026-10-08T22:45:00.000Z')
      assert.deepEqual(registrar.registrations, [{ domainName: 'example.com', status: 'active', expiresAt: '2027-04-02', autoRenew: true, seenInLatestSync: false }])
    })
    await t.test('Cloudflare plan updates apply until a user overrides fields, and deletion survives future syncs', async () => {
      await call({ action: 'manual', mode: 'cloudflare-updated', providers: ['cloudflare'], now: '2026-10-08T23:00:00Z' })
      const before = (await call<StoredSubscription[]>({ action: 'subscriptions' })).find(row => row.provider === 'Cloudflare')!
      assert.equal(before.amount, 14.56)
      assert.equal(before.nextRenewalAt, '2026-12-15')
      const edited = await call<StoredSubscription>({ action: 'edit-subscription', id: before.id, revision: before.revision, subscription: { ...before, amount: 21.23, status: 'paused' } })
      await call({ action: 'manual', mode: 'success', providers: ['cloudflare'], now: '2026-10-09T00:00:00Z' })
      const preserved = (await call<StoredSubscription[]>({ action: 'subscriptions' })).find(row => row.id === before.id)!
      assert.equal(preserved.amount, 21.23)
      assert.equal(preserved.status, 'paused')
      await call({ action: 'delete-subscription', id: edited.id, revision: preserved.revision })
      await call({ action: 'manual', mode: 'success', providers: ['cloudflare'], now: '2026-10-09T01:00:00Z' })
      assert.equal((await call<StoredSubscription[]>({ action: 'subscriptions' })).filter(row => row.provider === 'Cloudflare').length, 0)
    })
  } finally {
    workerProcess.kill('SIGTERM')
    if (workerProcess.exitCode === null) await once(workerProcess, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
