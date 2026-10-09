import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overviewInsights } from '../src/domain/overview-insights.ts'
import type { CostSnapshot } from '../src/domain/usage-costs.ts'

const base: CostSnapshot = {
  id: 'aws-current', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-10-08',
  amount: 24, currency: 'USD', kind: 'actual', capturedAt: '2026-10-08T12:00:00Z',
  metadata: { period: 'current', breakdown: [{ service: 'EC2', amount: 18, currency: 'USD' }, { service: 'S3', amount: 6, currency: 'USD' }] },
}

test('overview insights expose same-currency actual drivers and comparable-period movement', () => {
  const previous: CostSnapshot = { ...base, id: 'aws-previous', periodStart: '2026-09-01', periodEnd: '2026-09-08', amount: 20, capturedAt: '2026-10-08T12:00:00Z', metadata: { period: 'previous-comparable' } }
  assert.deepEqual(overviewInsights([base, previous]), [{
    provider: 'aws', currency: 'USD', actual: 24, previousComparable: 20, changePercent: 20,
    drivers: [{ service: 'EC2', amount: 18 }, { service: 'S3', amount: 6 }],
  }])
})

test('overview insights omit comparisons unless provider, currency, and elapsed periods align', () => {
  const otherCurrency = { ...base, id: 'aws-eur', currency: 'EUR', amount: 7 }
  const mismatched = { ...base, id: 'aws-old', periodStart: '2026-09-01', periodEnd: '2026-09-04', metadata: { period: 'previous-comparable' } }
  const cloudflare = { ...base, id: 'cf-old', provider: 'cloudflare' as const, periodStart: '2026-09-01', periodEnd: '2026-09-08', metadata: { period: 'previous-comparable' } }
  assert.deepEqual(overviewInsights([base, otherCurrency, mismatched, cloudflare]).map(row => [row.provider, row.currency, row.previousComparable]), [['aws', 'EUR', null], ['aws', 'USD', null]])
})

test('overview insights do not pair a current capture with stale comparison history', () => {
  const stale = { ...base, id: 'aws-stale-comparison', periodStart: '2026-09-01', periodEnd: '2026-09-08', capturedAt: '2026-10-01T12:00:00Z', metadata: { period: 'previous-comparable' } }
  assert.equal(overviewInsights([base, stale])[0]?.previousComparable, null)
})

test('overview insights rank positive service charges, retain credits in totals, and tolerate missing history', () => {
  const credit: CostSnapshot = { ...base, id: 'cf', provider: 'cloudflare', amount: -2, metadata: { period: 'current', scope: 'billing-period-to-date', breakdown: [{ service: 'R2', amount: -2, currency: 'USD' }, { service: 'Workers', amount: 4, currency: 'USD' }] } }
  assert.deepEqual(overviewInsights([credit]), [{ provider: 'cloudflare', currency: 'USD', actual: -2, previousComparable: null, changePercent: null, drivers: [{ service: 'Workers', amount: 4 }] }])
})
