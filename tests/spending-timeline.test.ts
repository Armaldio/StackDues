import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSubscription } from '../src/domain/subscriptions.ts'
import { spendingTimeline } from '../src/domain/spending-timeline.ts'
import { createCostSnapshot } from '../src/domain/usage-costs.ts'

function subscription(id: string, overrides: Partial<Parameters<typeof createSubscription>[0]> = {}) {
  return createSubscription({ id, name: id, billingType: 'fixed', amount: 12, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: '2026-10-09', status: 'active', ...overrides })
}
function snapshot(input: Partial<Parameters<typeof createCostSnapshot>[0]> & Pick<Parameters<typeof createCostSnapshot>[0], 'id' | 'provider' | 'periodStart' | 'periodEnd' | 'amount' | 'currency' | 'kind' | 'capturedAt'>) {
  return createCostSnapshot({ ...input })
}

test('timeline windows are inclusive UTC calendar windows across month and year boundaries', () => {
  const monthly = spendingTimeline([subscription('month-end', { nextRenewalAt: '2027-01-31' })], [], '2027-01-31', 30)
  assert.equal(monthly.windowStart, '2027-01-02')
  assert.equal(monthly.windowEnd, '2027-03-01')
  assert.deepEqual(monthly.renewals.map(row => row.date), ['2027-01-31', '2027-02-28'])

  const annual = spendingTimeline([subscription('yearly', { recurrenceUnit: 'year', nextRenewalAt: '2028-02-29' })], [], '2028-02-29', 365)
  assert.equal(annual.windowStart, '2027-03-02')
  assert.equal(annual.windowEnd, '2029-02-27')
  assert.deepEqual(annual.renewals.map(row => row.date), ['2028-02-29'])
})

test('timeline keeps currencies and renewal versus actual versus forecast entries separate', () => {
  const rows = [
    subscription('usd', { currency: 'USD' }),
    subscription('eur', { currency: 'EUR', recurrenceUnit: 'year', nextRenewalAt: '2026-10-20', amount: 80 }),
    subscription('paused', { status: 'paused' }),
    subscription('cancelled', { status: 'cancelled' }),
  ]
  const reports = [
    snapshot({ id: 'cf-usd', provider: 'cloudflare', periodStart: '2026-09-15', periodEnd: '2026-10-15', amount: 12, currency: 'USD', kind: 'actual', capturedAt: '2026-10-08T00:00:00Z' }),
    snapshot({ id: 'aws-eur', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: 9, currency: 'EUR', kind: 'forecast', capturedAt: '2026-10-08T00:00:00Z' }),
  ]
  const data = spendingTimeline(rows, reports, '2026-10-09', 30)
  assert.deepEqual(data.renewals.map(row => [row.subscription.id, row.currency]), [['usd', 'USD'], ['eur', 'EUR']])
  assert.deepEqual(data.actuals.map(row => [row.provider, row.currency, row.amount]), [['cloudflare', 'USD', 12]])
  assert.deepEqual(data.forecasts.map(row => [row.provider, row.currency, row.amount]), [['aws', 'EUR', 9]])
})

test('late captures remain visible, capture revisions deduplicate, and signed credits are retained', () => {
  const previous = snapshot({ id: 'old', provider: 'openai', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: 42, currency: 'USD', kind: 'actual', capturedAt: '2026-10-02T00:00:00Z' })
  const latest = snapshot({ id: 'credit-revision', provider: 'openai', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: -2, currency: 'USD', kind: 'actual', capturedAt: '2026-10-08T00:00:00Z' })
  const timeline = spendingTimeline([], [previous, latest], '2026-10-09', 30)
  assert.equal(timeline.actuals.length, 1)
  assert.equal(timeline.actuals[0]?.id, 'credit-revision')
  assert.equal(timeline.actuals[0]?.amount, -2)
})

test('timeline window type rejects unsupported ranges instead of silently approximating', () => {
  assert.throws(() => spendingTimeline([], [], '2026-10-09', 60 as 30), /30, 90, or 365/)
})
