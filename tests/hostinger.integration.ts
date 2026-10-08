import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const baseRow = { id: 'kvm-plan-1', name: 'KVM 1', status: 'active', billing_period: 12, billing_period_unit: 'month', currency_code: 'USD', total_price: 8999, renewal_price: 17999, is_auto_renewed: true, created_at: '2025-10-08T11:54:22Z', expires_at: null, next_billing_at: '2026-10-08T11:54:22Z' }
const now = '2026-10-08T12:00:00.000Z'

test('Hostinger discovery preserves provider data and only linked fixed commitments affect totals', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-hostinger-'))
  const fixture = JSON.parse(await readFile(new URL('./fixtures/hostinger-worker.wrangler.jsonc', import.meta.url), 'utf8'))
  const configPath = join(directory, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify({ ...fixture, main: fileURLToPath(new URL('./fixtures/hostinger-worker.ts', import.meta.url)) }))
  const worker = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8796', '--inspector-port', '9236', '--persist-to', join(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''
  worker.stdout.on('data', chunk => { output += chunk }); worker.stderr.on('data', chunk => { output += chunk })
  async function call(input: Record<string, unknown>, status = 200) {
    const response = await fetch('http://127.0.0.1:8796/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    const body = await response.json() as any
    assert.equal(response.status, status, JSON.stringify(body))
    assert.ok(!JSON.stringify(body).includes('TEST_FAKE_HOSTINGER_TOKEN'))
    return body
  }
  try {
    const deadline = Date.now() + 40_000
    while (!output.includes('Ready on')) { if (worker.exitCode !== null || Date.now() > deadline) throw new Error(`Hostinger Worker startup failed: ${output}`); await new Promise(resolve => setTimeout(resolve, 100)) }
    await call({ action: 'initialize' })
    await t.test('missing Hostinger credentials create status only and never make provider calls', async () => {
      const result = await call({ action: 'sync', now, providerResponse: [baseRow] })
      assert.equal(result.sync.status, 'not-configured')
      assert.equal(result.subscriptions.length, 0)
    })
    await call({ action: 'save' })
    await t.test('discovery keeps raw data private and exposes upcoming renewal cents separately from first price', async () => {
      const nonRenewing = { ...baseRow, id: 'domain-no-renew', name: 'Domain', status: 'not_renewing', billing_period_unit: 'year', is_auto_renewed: false, renewal_price: 1000, expires_at: '2027-10-08T00:00:00Z', next_billing_at: null }
      const unknown = { ...baseRow, id: 'unknown-unit', name: 'Unsupported plan', billing_period_unit: 'fortnight', next_billing_at: null }
      const result = await call({ action: 'sync', now, providerResponse: [baseRow, nonRenewing, unknown] })
      assert.equal(result.sync.status, 'synced')
      const kvm = result.subscriptions.find((item: any) => item.externalId === baseRow.id)
      assert.equal(kvm.totalPrice, 89.99); assert.equal(kvm.renewalPrice, 179.99)
      assert.equal(kvm.upcomingCommitment, 179.99); assert.equal(kvm.renewalAvailable, true)
      assert.equal(kvm.seenInLatestSync, true); assert.equal(kvm.linkedSubscriptionId, null)
      const domain = result.subscriptions.find((item: any) => item.externalId === nonRenewing.id)
      assert.equal(domain.nextBillingAt, null); assert.equal(domain.upcomingCommitment, null); assert.equal(domain.expiresAt, '2027-10-08T00:00:00.000Z')
      const unsupported = result.subscriptions.find((item: any) => item.externalId === unknown.id)
      assert.equal(unsupported.recurrenceUnit, 'unsupported'); assert.equal(unsupported.renewalAvailable, false)
      const raw = await call({ action: 'raw', externalId: baseRow.id })
      assert.equal(JSON.parse(raw.raw_json).renewal_price, 17999)
    })
    await t.test('new and repeated imports do not duplicate ledger rows; provider updates apply except explicit user overrides', async () => {
      const created = await call({ action: 'add', externalId: baseRow.id })
      assert.equal(created.amount, 179.99); assert.equal(created.recurrenceInterval, 12); assert.equal(created.nextRenewalAt, '2026-10-08'); assert.equal(created.provider, 'Hostinger')
      await call({ action: 'add', externalId: baseRow.id }, 409)
      const subscriptions = await call({ action: 'subscriptions' })
      assert.equal(subscriptions.length, 1)
      await call({ action: 'edit', id: created.id, revision: created.revision, subscription: { ...created, amount: 209.99, name: 'My KVM' } })
      const refreshed = await call({ action: 'sync', now: '2027-10-08T12:00:00.000Z', providerResponse: [{ ...baseRow, name: 'KVM 1 Pro', renewal_price: 22999, next_billing_at: '2027-10-08T11:54:22Z' }] })
      const after = (await call({ action: 'subscriptions' })).find((row: any) => row.id === created.id)
      assert.equal(after.amount, 209.99); assert.equal(after.name, 'My KVM'); assert.equal(after.nextRenewalAt, '2027-10-08')
      assert.equal(refreshed.subscriptions.find((item: any) => item.externalId === baseRow.id).renewalPrice, 229.99)
      assert.equal(refreshed.subscriptions.find((item: any) => item.externalId === baseRow.id).name, 'KVM 1 Pro')
      await call({ action: 'sync', now: '2027-10-09T12:00:00.000Z', providerResponse: [{ ...baseRow, status: 'not_renewing', is_auto_renewed: false, next_billing_at: null }] })
      const ended = (await call({ action: 'subscriptions' })).find((row: any) => row.id === created.id)
      assert.equal(ended.status, 'cancelled')
      await call({ action: 'sync', now: '2027-10-09T12:00:00.000Z', providerResponse: [baseRow] })
      const active = (await call({ action: 'subscriptions' })).find((row: any) => row.id === created.id)
      assert.equal(active.status, 'active')
      await call({ action: 'sync', now: '2027-10-10T12:00:00.000Z', providerResponse: [{ ...baseRow, billing_period_unit: 'fortnight' }] })
      const unsupported = (await call({ action: 'subscriptions' })).find((row: any) => row.id === created.id)
      assert.equal(unsupported.status, 'cancelled')
    })
    await t.test('matching an existing manual row avoids a duplicate and preserves its chosen values across refresh', async () => {
      const source = { id: 'manual-hostinger', name: 'My existing host', billingType: 'fixed', amount: 25, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-12-01', status: 'active' }
      const manual = await call({ action: 'manual', subscription: source })
      await call({ action: 'sync', now: '2026-10-10T12:00:00.000Z', providerResponse: [{ ...baseRow, id: 'match-me', name: source.name }] })
      await call({ action: 'add', externalId: 'match-me' }, 409)
      const linked = await call({ action: 'link', externalId: 'match-me', subscriptionId: manual.id, revision: manual.revision, mode: 'keep-current' })
      assert.equal(linked.amount, 25); assert.equal(linked.name, source.name)
      const refreshed = await call({ action: 'sync', now: '2026-10-11T12:00:00.000Z', providerResponse: [{ ...baseRow, id: 'match-me', name: 'Provider name changed', renewal_price: 30000 }] })
      assert.equal(refreshed.subscriptions.find((item: any) => item.externalId === 'match-me').linkedSubscriptionId, manual.id)
      const rows = await call({ action: 'subscriptions' })
      assert.equal(rows.filter((item: any) => item.id === manual.id).length, 1)
      assert.equal(rows.find((item: any) => item.id === manual.id).amount, 25)
      assert.equal(rows.find((item: any) => item.id === manual.id).name, source.name)
      await call({ action: 'link', externalId: 'match-me', subscriptionId: manual.id, revision: linked.revision, mode: 'keep-current' }, 409)
    })
    await t.test('non-renewing and unknown-period entries are not imported as recurring charges', async () => {
      await call({ action: 'add', externalId: 'domain-no-renew' }, 400)
      await call({ action: 'add', externalId: 'unknown-unit' }, 400)
    })
    await t.test('provider errors keep prior data, successful empty discovery marks old rows unseen without deleting them', async () => {
      const failed = await call({ action: 'sync', now: '2027-10-12T12:00:00.000Z', failure: 403 }, 502)
      assert.match(failed.message, /previous provider data/i)
      const beforeEmpty = await call({ action: 'list' })
      assert.equal(beforeEmpty.sync.status, 'error'); assert.ok(beforeEmpty.sync.lastSyncedAt)
      const empty = await call({ action: 'sync', now: '2027-10-13T12:00:00.000Z', providerResponse: [] })
      assert.equal(empty.subscriptions.length, 4)
      assert.ok(empty.subscriptions.every((item: any) => !item.seenInLatestSync))
      assert.ok((await call({ action: 'subscriptions' })).length >= 2)
    })
  } finally {
    worker.kill('SIGTERM')
    if (worker.exitCode === null) await once(worker, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
