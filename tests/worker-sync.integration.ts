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
  async function call(input: Record<string, unknown>, status = 200) {
    const response = await fetch('http://127.0.0.1:8795/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const body = await response.json() as { feed: CostFeed; calls: { aws: number; cloudflare: number }; message?: string }
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
      assert.deepEqual(calls, { aws: 0, cloudflare: 0, openai: 0 })
      assert.deepEqual(feed.snapshots, [])
      for (const provider of ['aws', 'cloudflare', 'openai'] as const) assert.deepEqual(feed.providers[provider], { status: 'not-configured', lastAttemptAt: '2026-10-08T12:00:00.000Z' })
    })
    await t.test('manual and scheduled attempts share normalization and stable retry IDs', async () => {
      const manual = await call({ action: 'manual', mode: 'success', now: '2026-10-08T13:00:00Z' })
      assert.deepEqual(manual.calls, { aws: 4, cloudflare: 1, openai: 1 })
      assert.equal(manual.feed.snapshots.length, 6)
      assert.equal(manual.feed.snapshots.find(item => item.kind === 'forecast')?.amount, 19)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'cloudflare')?.amount, 2)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'openai')?.amount, 2.25)
      assert.equal(manual.feed.snapshots.find(item => item.provider === 'openai')?.currency, 'USD')
      const scheduled = await call({ action: 'scheduled', mode: 'success', now: '2026-10-08T13:00:00Z' })
      assert.deepEqual(scheduled.feed, manual.feed)
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
      assert.deepEqual(failed.calls, { aws: 0, cloudflare: 0, openai: 1 })
      assert.equal(failed.feed.providers.openai.status, 'error')
      assert.equal(failed.feed.providers.openai.lastSyncedAt, '2026-10-08T15:00:00.000Z')
      assert.equal(failed.feed.snapshots.filter(item => item.provider === 'openai').length, 3)
      assert.equal(latestCostSnapshots(failed.feed.snapshots).filter(item => item.provider === 'openai').length, 1, 'repeated cumulative reports remain revisions, not added charges')
      assert.ok(!JSON.stringify(failed).includes('TEST_OPENAI_ADMIN_KEY'))
    })
    await t.test('timeout and malformed money are failures rather than fresh zero totals', async () => {
      const timedOut = await call({ action: 'scheduled', mode: 'timeout', now: '2026-10-08T16:00:00Z' })
      assert.equal(timedOut.feed.providers.aws.status, 'error')
      const malformed = await call({ action: 'manual', mode: 'malformed', now: '2026-10-08T17:00:00Z' })
      assert.equal(malformed.feed.providers.cloudflare.status, 'error')
      assert.equal(malformed.feed.providers.cloudflare.lastSyncedAt, '2026-10-08T16:00:00.000Z')
      assert.equal(malformed.feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
    })
    await t.test('a failed Cloudflare transaction does not block AWS or save partial Cloudflare history', async () => {
      await call({ action: 'sql', sql: "CREATE TRIGGER fail_sync BEFORE INSERT ON provider_sync_status WHEN NEW.provider = 'cloudflare' BEGIN SELECT RAISE(ABORT, 'TEST_FAKE_CLOUDFLARE_TOKEN database error'); END;" })
      await call({ action: 'manual', mode: 'success', now: '2026-10-08T18:00:00Z' }, 503)
      const response = await fetch('http://127.0.0.1:8795/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'costs' }) })
      const feed = await response.json() as CostFeed
      assert.equal(feed.providers.aws.lastSyncedAt, '2026-10-08T18:00:00.000Z')
      assert.equal(feed.providers.cloudflare.lastAttemptAt, '2026-10-08T17:00:00.000Z')
      assert.equal(feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
      await call({ action: 'sql', sql: 'DROP TRIGGER fail_sync;' })
    })
    await t.test('a successful empty collection retains history and advances the successful capture', async () => {
      const { feed } = await call({ action: 'scheduled', mode: 'empty-cloudflare', now: '2026-10-08T19:00:00Z' })
      assert.equal(feed.providers.cloudflare.status, 'synced')
      assert.equal(feed.providers.cloudflare.lastSyncedAt, '2026-10-08T19:00:00.000Z')
      assert.equal(feed.snapshots.filter(item => item.provider === 'cloudflare').length, 4)
      assert.ok(!feed.snapshots.some(item => item.provider === 'cloudflare' && item.capturedAt === '2026-10-08T19:00:00.000Z'))
    })
    await t.test('a provider-specific refresh contacts only the newly connected provider', async () => {
      const { feed, calls } = await call({ action: 'manual', mode: 'success', providers: ['cloudflare'], now: '2026-10-08T20:00:00Z' })
      assert.deepEqual(calls, { aws: 0, cloudflare: 1, openai: 0 })
      assert.equal(feed.providers.cloudflare.lastSyncedAt, '2026-10-08T20:00:00.000Z')
      assert.equal(feed.providers.aws.lastSyncedAt, '2026-10-08T19:00:00.000Z')
    })
  } finally {
    workerProcess.kill('SIGTERM')
    if (workerProcess.exitCode === null) await once(workerProcess, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
