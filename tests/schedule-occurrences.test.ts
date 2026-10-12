import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubscription, nextDistinctRenewals, renewalChargeTotals, upcomingRenewals } from '../src/domain/subscriptions.ts'

test('complete schedule fixtures reconcile 27 annual-window and 81 three-year occurrences without collapsing repeats', () => {
  const subscriptions = [
    { id: 'monthly-a', amount: 10, currency: 'USD', recurrenceUnit: 'month' as const },
    { id: 'monthly-b', amount: 20, currency: 'USD', recurrenceUnit: 'month' as const },
    { id: 'annual-eur', amount: 30, currency: 'EUR', recurrenceUnit: 'year' as const },
    { id: 'annual-usd', amount: 40, currency: 'USD', recurrenceUnit: 'year' as const },
    { id: 'hostinger', provider: 'Hostinger', amount: 50, currency: 'EUR', recurrenceUnit: 'year' as const },
  ].map(row => createSubscription({ ...row, name: row.id, billingType: 'fixed', recurrenceInterval: 1, nextRenewalAt: '2026-10-12', status: 'active' }))
  for (const [end, count, multiplier] of [['2027-10-11', 27, 1], ['2029-10-11', 81, 3]] as const) {
    const occurrences = upcomingRenewals(subscriptions, '2026-10-12', end)
    assert.equal(occurrences.length, count)
    assert.equal(nextDistinctRenewals(occurrences).length, 5)
    assert.equal(new Set(occurrences.map(row => `${row.subscription.id}/${row.date}`)).size, count)
    assert.deepEqual(renewalChargeTotals(occurrences), [{ currency: 'EUR', amount: 80 * multiplier }, { currency: 'USD', amount: 400 * multiplier }])
  }
})
