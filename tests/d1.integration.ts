import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Subscription } from '../src/domain/subscriptions.ts'
import type { CostSnapshot } from '../src/domain/usage-costs.ts'

const subscription: Subscription = { id: 'bitwarden', name: 'Bitwarden', billingType: 'fixed', amount: 10, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-10-08', status: 'active' }
const observation: CostSnapshot = { id: 'aws:first', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-10-08', amount: -2, currency: 'USD', kind: 'actual', capturedAt: '2026-10-08T12:00:00.000Z', metadata: { period: 'current', secret: 'never-store' } }

test('D1 ledger uses real workerd transactions, imports and immutable observations', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-d1-'))
  const fixture = JSON.parse(await readFile(new URL('./fixtures/d1-worker.wrangler.jsonc', import.meta.url), 'utf8'))
  const configPath = join(directory, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify({ ...fixture, main: fileURLToPath(new URL('./fixtures/d1-worker.ts', import.meta.url)) }))
  const workerProcess = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8796', '--inspector-port', '9236', '--persist-to', join(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''
  workerProcess.stdout.on('data', chunk => { output += chunk })
  workerProcess.stderr.on('data', chunk => { output += chunk })
  async function call(action: string, input: Record<string, unknown> = {}, status = 200) {
    const response = await fetch('http://127.0.0.1:8796/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...input }) })
    const body = await response.json() as any
    assert.equal(response.status, status, JSON.stringify(body))
    return body
  }
  try {
    const deadline = Date.now() + 50_000
    while (!output.includes('Ready on')) {
      if (workerProcess.exitCode !== null || Date.now() > deadline) throw new Error(`D1 Worker startup failed: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await t.test('missing migrations fail visibly rather than returning an empty ledger', async () => {
      const error = await call('list', {}, 503)
      assert.equal(error.message, 'Private storage is unavailable. Try again later.')
      await call('costs', {}, 503)
    })
    await call('initialize')
    await t.test('arbitrary recurrence, status, currency and revisions round trip', async () => {
      const created = await call('create', { subscription })
      assert.deepEqual(created, { ...subscription, revision: 1 })
      const updated = { ...subscription, recurrenceInterval: 4, recurrenceUnit: 'year', amount: 192, currency: 'EUR', provider: 'Hostinger', status: 'paused' }
      assert.deepEqual(await call('patch', { id: subscription.id, subscription: updated, revision: 1 }), { ...updated, revision: 2 })
      await call('patch', { id: subscription.id, subscription, revision: 1 }, 409)
      await call('delete', { id: subscription.id, revision: 1 }, 409)
      await call('create', { subscription }, 409)
      assert.deepEqual(await call('list'), [{ ...updated, revision: 2 }])
      assert.deepEqual(await call('delete', { id: subscription.id, revision: 2 }), { deleted: true })
      assert.deepEqual(await call('list'), [])
      await call('patch', { id: subscription.id, subscription, revision: 2 }, 404)
    })
    await t.test('imports are atomic, repeatable, preserve existing server edits and expose verification values', async () => {
      const result = await call('import', { subscriptions: [subscription, { ...subscription, id: 'vps', name: 'VPS', amount: 12, recurrenceUnit: 'month' }] })
      assert.deepEqual(result.createdIds, ['bitwarden', 'vps'])
      assert.equal(result.subscriptions.length, 2)
      const edited = { ...subscription, amount: 20 }
      await call('patch', { id: subscription.id, subscription: edited, revision: 1 })
      const repeated = await call('import', { subscriptions: [subscription] })
      assert.deepEqual(repeated.createdIds, [])
      assert.equal(repeated.subscriptions.find((item: any) => item.id === 'bitwarden').amount, 20)
      assert.equal(repeated.subscriptions.find((item: any) => item.id === 'bitwarden').revision, 2)
      await call('import', { subscriptions: [{ ...subscription, id: 'never-insert' }, { ...subscription, id: 'broken', nextRenewalAt: '2026-02-30' }] }, 400)
      await call('import', { subscriptions: [subscription, subscription] }, 400)
      assert.equal((await call('list')).length, 2)
      await call('sql', { sql: "CREATE TRIGGER fail_import BEFORE INSERT ON manual_subscriptions WHEN NEW.id = 'fail-late' BEGIN SELECT RAISE(ABORT, 'test failure'); END;" })
      await call('import', { subscriptions: [{ ...subscription, id: 'rolled-back' }, { ...subscription, id: 'fail-late' }] }, 503)
      assert.equal((await call('list')).length, 2)
      await call('sql', { sql: 'DROP TRIGGER fail_import;' })
    })
    await t.test('server writes reject invalid revisions, mismatched IDs and aggregate numeric overflow', async () => {
      await call('patch', { id: 'bitwarden', subscription: { ...subscription, id: 'wrong' }, revision: 2 }, 400)
      await call('delete', { id: 'bitwarden', revision: 0 }, 400)
      await call('create', { subscription: { ...subscription, id: 'huge-1', amount: 1e308 } })
      await call('create', { subscription: { ...subscription, id: 'huge-2', amount: 1e308 } }, 400)
      assert.ok(!(await call('list')).some((item: any) => item.id === 'huge-2'))
    })
    await t.test('concurrent writes cannot bypass the aggregate overflow guard', async () => {
      const responses = await Promise.all(['race-1', 'race-2'].map(id => fetch('http://127.0.0.1:8796/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', subscription: { ...subscription, id, currency: 'EUR', amount: 1e308 } }) })))
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 400])
      assert.equal((await call('list')).filter((item: any) => item.id.startsWith('race-')).length, 1)
    })
    await t.test('observations are sanitized, immutable, duplicate-safe and preserve history on errors', async () => {
      const synced = { status: 'synced', lastAttemptAt: observation.capturedAt, lastSyncedAt: observation.capturedAt }
      const first = await call('persist', { provider: 'aws', snapshots: [observation], status: synced })
      assert.equal(first.snapshots.length, 1)
      assert.equal(first.snapshots[0].amount, -2)
      assert.ok(!JSON.stringify(first).includes('never-store'))
      assert.equal((await call('persist', { provider: 'aws', snapshots: [observation], status: synced })).snapshots.length, 1)
      await call('persist', { provider: 'aws', snapshots: [{ ...observation, id: 'rolled-back-cost' }, { ...observation, amount: 999 }], status: { status: 'synced', lastAttemptAt: '2026-10-08T13:00:00.000Z', lastSyncedAt: '2026-10-08T13:00:00.000Z' } }, 409)
      assert.equal((await call('costs')).snapshots.length, 1)
      const failed = await call('persist', { provider: 'aws', snapshots: [], status: { status: 'error', lastAttemptAt: '2026-10-08T14:00:00.000Z', error: 'secret-token' } })
      assert.equal(failed.snapshots.length, 1)
      assert.equal(failed.providers.aws.lastSyncedAt, observation.capturedAt)
      assert.ok(!JSON.stringify(failed).includes('secret-token'))
      await call('persist', { provider: 'aws', snapshots: [], status: { status: 'synced', lastAttemptAt: '2026-10-08T13:00:00.000Z', lastSyncedAt: '2026-10-08T13:00:00.000Z' } })
      assert.equal((await call('costs')).providers.aws.status, 'error')
      await call('sql', { sql: "UPDATE cost_observations SET amount = 999 WHERE id = 'aws:first';" }, 500)
      await call('sql', { sql: "DELETE FROM cost_observations WHERE id = 'aws:first';" }, 500)
      assert.equal((await call('costs')).snapshots[0].amount, -2)
    })
    await t.test('invalid provider collections and failed status transactions cannot publish partial history', async () => {
      await call('persist', { provider: 'cloudflare', snapshots: [observation], status: { status: 'synced', lastAttemptAt: observation.capturedAt, lastSyncedAt: observation.capturedAt } }, 400)
      await call('sql', { sql: "CREATE TRIGGER fail_status BEFORE INSERT ON provider_sync_status WHEN NEW.provider = 'cloudflare' BEGIN SELECT RAISE(ABORT, 'test failure'); END;" })
      await call('persist', { provider: 'cloudflare', snapshots: [{ ...observation, id: 'cf-rollback', provider: 'cloudflare' }], status: { status: 'synced', lastAttemptAt: observation.capturedAt, lastSyncedAt: observation.capturedAt } }, 503)
      const costs = await call('costs')
      assert.equal(costs.snapshots.length, 1)
      assert.equal(costs.providers.cloudflare.status, 'not-configured')
      await call('sql', { sql: 'DROP TRIGGER fail_status;' })
      const empty = await call('persist', { provider: 'aws', snapshots: [], status: { status: 'synced', lastAttemptAt: '2026-10-08T15:00:00.000Z', lastSyncedAt: '2026-10-08T15:00:00.000Z' } })
      assert.equal(empty.snapshots.length, 1)
      assert.equal(empty.providers.aws.lastSyncedAt, '2026-10-08T15:00:00.000Z')
    })
    await t.test('the supported 1000-row import remains atomic and replayable', async () => {
      const items = Array.from({ length: 1000 }, (_, index) => ({ ...subscription, id: `bulk-${index}`, amount: 0 }))
      assert.equal((await call('import', { subscriptions: items })).createdIds.length, 1000)
      assert.equal((await call('import', { subscriptions: items })).createdIds.length, 0)
      await call('import', { subscriptions: [...items, { ...subscription, id: 'over-limit' }] }, 400)
    })
  } finally {
    workerProcess.kill('SIGTERM')
    if (workerProcess.exitCode === null) await once(workerProcess, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
