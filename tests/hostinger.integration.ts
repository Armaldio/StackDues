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

test('Hostinger discovery automatically tracks safe fixed commitments and preserves provider data', { timeout: 60_000 }, async t => {
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
      assert.equal(kvm.seenInLatestSync, true); assert.ok(kvm.linkedSubscriptionId); assert.equal(kvm.automaticallyLinked, true)
      const rows = await call({ action: 'subscriptions' })
      assert.equal(rows.length, 1); assert.equal(rows[0].amount, 179.99)
      const domain = result.subscriptions.find((item: any) => item.externalId === nonRenewing.id)
      assert.equal(domain.nextBillingAt, null); assert.equal(domain.upcomingCommitment, null); assert.equal(domain.expiresAt, '2027-10-08T00:00:00.000Z')
      const unsupported = result.subscriptions.find((item: any) => item.externalId === unknown.id)
      assert.equal(unsupported.recurrenceUnit, 'unsupported'); assert.equal(unsupported.renewalAvailable, false)
      const raw = await call({ action: 'raw', externalId: baseRow.id })
      assert.equal(JSON.parse(raw.raw_json).renewal_price, 17999)
    })
    await t.test('new and repeated imports do not duplicate ledger rows; provider updates apply except explicit user overrides', async () => {
      const created = (await call({ action: 'subscriptions' }))[0]
      assert.equal(created.amount, 179.99); assert.equal(created.recurrenceInterval, 12); assert.equal(created.nextRenewalAt, '2026-10-08'); assert.equal(created.provider, 'Hostinger')
      await call({ action: 'add', externalId: baseRow.id }, 409)
      const subscriptions = await call({ action: 'subscriptions' })
      assert.equal(subscriptions.length, 1)
      const repeated = await call({ action: 'sync', now: '2026-10-09T12:00:00.000Z', providerResponse: [baseRow] })
      assert.equal(repeated.subscriptions.find((item: any) => item.externalId === baseRow.id).automaticallyLinked, true)
      assert.ok(repeated.subscriptions.find((item: any) => item.externalId === baseRow.id).linkedSubscriptionId)
      assert.equal((await call({ action: 'subscriptions' })).length, 1)
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
      const matched = await call({ action: 'sync', now: '2026-10-10T12:00:00.000Z', providerResponse: [{ ...baseRow, id: 'match-me', name: source.name }] })
      assert.equal(matched.subscriptions.find((item: any) => item.externalId === 'match-me').linkedSubscriptionId, null)
      assert.deepEqual(matched.subscriptions.find((item: any) => item.externalId === 'match-me').possibleMatches.map((item: any) => item.id), [manual.id])
      assert.equal((await call({ action: 'subscriptions' })).length, 2)
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
    await t.test('unique exact billing matches link under a different label without overwriting manual values', async () => {
      const manual = await call({ action: 'manual', subscription: { id: 'renamed-host', name: 'My VPS', billingType: 'fixed', amount: 179.99, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: '2026-10-08', status: 'active' } })
      const result = await call({ action: 'sync', now: '2026-10-12T12:00:00.000Z', providerResponse: [{ ...baseRow, id: 'renamed-source', name: 'KVM from Hostinger' }] })
      const source = result.subscriptions.find((item: any) => item.externalId === 'renamed-source')
      assert.equal(source.linkedSubscriptionId, manual.id)
      assert.deepEqual(source.possibleMatches.map((item: any) => item.id), [])
      const rows = await call({ action: 'subscriptions' })
      assert.equal(rows.filter((item: any) => item.amount === 179.99 && item.name === 'My VPS').length, 1)
      assert.equal(rows.find((item: any) => item.id === manual.id).name, 'My VPS')
    })
    await t.test('duplicate provider names and ambiguous manual fingerprints require explicit review', async () => {
      const duplicateSource = { ...baseRow, name: 'Shared provider label' }
      const duplicates = await call({ action: 'sync', now: '2026-10-12T12:01:00.000Z', providerResponse: [{ ...duplicateSource, id: 'same-name-a' }, { ...duplicateSource, id: 'same-name-b' }] })
      assert.ok(duplicates.subscriptions.filter((item: any) => item.name === duplicateSource.name).every((item: any) => item.providerNameCollision && !item.linkedSubscriptionId))
      assert.equal((await call({ action: 'subscriptions' })).some((item: any) => item.name === duplicateSource.name), false)
      await call({ action: 'manual', subscription: { id: 'ambiguous-a', name: 'First host', billingType: 'fixed', amount: 179.99, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: '2026-10-08', status: 'active' } })
      await call({ action: 'manual', subscription: { id: 'ambiguous-b', name: 'Second host', billingType: 'fixed', amount: 179.99, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: '2026-10-08', status: 'active' } })
      const ambiguous = await call({ action: 'sync', now: '2026-10-12T12:02:00.000Z', providerResponse: [{ ...baseRow, id: 'ambiguous-source', name: 'Different provider name' }] })
      const source = ambiguous.subscriptions.find((item: any) => item.externalId === 'ambiguous-source')
      assert.equal(source.linkedSubscriptionId, null)
      assert.deepEqual(source.possibleMatches.map((item: any) => item.id).sort(), ['ambiguous-a', 'ambiguous-b', 'renamed-host'])
      assert.equal((await call({ action: 'subscriptions' })).filter((item: any) => item.amount === 179.99 && item.currency === 'USD' && item.nextRenewalAt === '2026-10-08').length, 3)
    })
    await t.test('non-renewing and unknown-period entries are not imported as recurring charges', async () => {
      await call({ action: 'add', externalId: 'domain-no-renew' }, 400)
      await call({ action: 'add', externalId: 'unknown-unit' }, 400)
    })
    await t.test('deleting an automatic commitment creates a persistent exclusion; re-inclusion is explicit', async () => {
      const unique = { ...baseRow, id: 'delete-me', name: 'Delete me automatic service', renewal_price: 27999 }
      const added = await call({ action: 'sync', now: '2027-10-10T12:30:00.000Z', providerResponse: [unique] })
      const item = added.subscriptions.find((row: any) => row.externalId === unique.id)
      const linkedRow = (await call({ action: 'subscriptions' })).find((row: any) => row.id === item.linkedSubscriptionId)
      assert.ok(linkedRow)
      await call({ action: 'delete', id: linkedRow.id, revision: linkedRow.revision })
      const excluded = await call({ action: 'sync', now: '2027-10-11T12:31:00.000Z', providerResponse: [unique] })
      assert.equal(excluded.subscriptions[0].excluded, true)
      assert.equal((await call({ action: 'subscriptions' })).some((row: any) => row.id === linkedRow.id), false)
      await call({ action: 'exclude', externalId: unique.id, excluded: false })
      const included = await call({ action: 'sync', now: '2027-10-11T12:32:00.000Z', providerResponse: [unique] })
      assert.ok(included.subscriptions[0].linkedSubscriptionId)
      assert.equal((await call({ action: 'subscriptions' })).filter((row: any) => row.name === unique.name).length, 1)
    })
    await t.test('provider errors keep prior data, successful empty discovery marks old rows unseen without deleting them', async () => {
      const failed = await call({ action: 'sync', now: '2027-10-12T12:00:00.000Z', failure: 403 }, 502)
      assert.match(failed.message, /previous provider data/i)
      const beforeEmpty = await call({ action: 'list' })
      assert.equal(beforeEmpty.sync.status, 'error'); assert.ok(beforeEmpty.sync.lastSyncedAt)
      const empty = await call({ action: 'sync', now: '2027-10-13T12:00:00.000Z', providerResponse: [] })
      assert.equal(empty.subscriptions.length, beforeEmpty.subscriptions.length)
      assert.ok(empty.subscriptions.every((item: any) => !item.seenInLatestSync))
      assert.ok((await call({ action: 'subscriptions' })).length >= 1)
    })
  } finally {
    worker.kill('SIGTERM')
    if (worker.exitCode === null) await once(worker, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
