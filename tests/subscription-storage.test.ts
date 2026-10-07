import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadSubscriptions, saveSubscriptions, STORAGE_KEY, type LedgerStorage } from '../src/lib/subscription-storage.ts'
import { createSubscription, type Subscription } from '../src/domain/subscriptions.ts'

function memoryStorage(raw: string | null = null): LedgerStorage {
  const values = new Map(raw === null ? [] : [[STORAGE_KEY, raw]])
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
}
const subscription: Subscription = { id: 'bitwarden', name: 'Bitwarden', billingType: 'fixed', amount: 10, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-10-07', status: 'active' }

test('fresh browser begins with a real empty ledger and changes survive reloads', () => {
  const storage = memoryStorage()
  assert.deepEqual(loadSubscriptions(storage), { subscriptions: [], error: null, blocked: false })
  assert.equal(saveSubscriptions(storage, [subscription]), null)
  assert.deepEqual(loadSubscriptions(storage).subscriptions, [createSubscription(subscription)])
  assert.equal(saveSubscriptions(storage, [{ ...subscription, status: 'paused' }]), null)
  assert.equal(loadSubscriptions(storage).subscriptions[0]?.status, 'paused')
  assert.equal(saveSubscriptions(storage, []), null)
  assert.deepEqual(loadSubscriptions(storage).subscriptions, [])
})
test('corrupted, invalid and duplicate ledgers are preserved and cannot be overwritten', () => {
  for (const raw of ['broken json', '{}', '[null]', JSON.stringify([{ ...subscription, amount: -1 }]), JSON.stringify([subscription, subscription])]) {
    const storage = memoryStorage(raw)
    assert.equal(loadSubscriptions(storage).blocked, true)
    assert.ok(saveSubscriptions(storage, []))
    assert.equal(storage.getItem(STORAGE_KEY), raw)
  }
})
test('failed writes leave the durable ledger unchanged', () => {
  const durable = memoryStorage(JSON.stringify([subscription]))
  const storage = { ...durable, setItem() { throw new Error('Quota exceeded') } }
  assert.ok(saveSubscriptions(storage, []))
  assert.equal(loadSubscriptions(durable).subscriptions[0]?.id, subscription.id)
})
test('unavailable browser storage produces a visible error and blocks writes', () => {
  let writes = 0
  const storage = { getItem() { throw new Error('Access denied') }, setItem() { writes++ }, removeItem() {} }
  assert.equal(loadSubscriptions(storage).blocked, true)
  assert.ok(saveSubscriptions(storage, []))
  assert.equal(writes, 0)
})
test('invalid updates do not overwrite a valid saved ledger', () => {
  const storage = memoryStorage(JSON.stringify([subscription]))
  assert.ok(saveSubscriptions(storage, [{ ...subscription, recurrenceInterval: 0 }]))
  assert.ok(saveSubscriptions(storage, [subscription, subscription]))
  assert.equal(loadSubscriptions(storage).subscriptions.length, 1)
})
