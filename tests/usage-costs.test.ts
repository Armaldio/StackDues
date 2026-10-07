import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCostSnapshot, latestCostSnapshots, normalizeUsageAmount, usageTotals, type CostSnapshot } from '../src/domain/usage-costs.ts'

const base: CostSnapshot = { id: 'aws-1', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-10-07', amount: 12.5, currency: 'USD', kind: 'actual', capturedAt: '2026-10-07T12:00:00Z', metadata: { period: 'current' } }

test('usage decimal normalization retains precision and billing credits', () => {
  assert.equal(normalizeUsageAmount('12.123456789'), 12.123456789)
  assert.equal(normalizeUsageAmount('-2.5'), -2.5)
  assert.equal(normalizeUsageAmount(0), 0)
  for (const value of ['', ' ', 'NaN', 'Infinity', '1USD', '0x10', true, null, undefined, NaN, Infinity, {}, '1e3']) assert.throws(() => normalizeUsageAmount(value), /finite decimal/i)
})

test('snapshot validation rejects invalid dates, amounts, currency and discriminators', () => {
  for (const patch of [{ amount: NaN }, { amount: Infinity }, { amount: '12' }, { currency: 'usd' }, { currency: 'US' }, { periodStart: '2026-02-30' }, { periodEnd: '2026-10-01' }, { capturedAt: 'invalid' }, { capturedAt: '2026-02-30T12:00:00Z' }, { capturedAt: '2026-10-07T24:00:00Z' }, { capturedAt: '0000-01-01T12:00:00Z' }, { provider: 'other' }, { kind: 'other' }]) assert.throws(() => createCostSnapshot({ ...base, ...patch } as CostSnapshot))
})

test('snapshots clone and deeply freeze metadata so later response mutation cannot rewrite history', () => {
  const input = { ...base, metadata: { period: 'current', breakdown: [{ service: 'S3', amount: 12.5, currency: 'USD' }] } }
  const snapshot = createCostSnapshot(input)
  input.metadata.breakdown[0]!.amount = 99
  assert.equal((snapshot.metadata?.breakdown as { amount: number }[])[0]?.amount, 12.5)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.metadata?.breakdown), true)
})

test('latest captures deduplicate only identical provider periods kinds and currencies', () => {
  const newest = { ...base, id: 'aws-2', capturedAt: '2026-10-07T13:00:00Z', amount: 20 }
  const forecast = { ...newest, id: 'forecast', kind: 'forecast' as const, periodEnd: '2026-11-01', amount: 60 }
  assert.deepEqual(latestCostSnapshots([base, newest, forecast]).map(item => item.id).sort(), ['aws-2', 'forecast'])
})

test('current usage excludes comparisons and obsolete captures without double-counting forecasts', () => {
  const newer = { ...base, id: 'aws-2', capturedAt: '2026-10-08T12:00:00Z', periodEnd: '2026-10-08', amount: 15 }
  const forecast = { ...newer, id: 'forecast', kind: 'forecast' as const, periodEnd: '2026-11-01', amount: 60 }
  const previous = { ...base, id: 'previous', metadata: { period: 'previous-comparable' }, amount: 99 }
  assert.deepEqual(usageTotals([base, newer, forecast, previous], '2026-10-08'), [{ currency: 'USD', actual: 15, estimatedMonthly: 60, estimatedYearly: 720, hasActual: true, hasForecast: true, estimationComplete: true }])
})

test('usage currencies remain separate and unavailable projections are explicitly incomplete', () => {
  const cf = { ...base, id: 'cf', provider: 'cloudflare' as const, currency: 'EUR', amount: 4, metadata: { period: 'current', projectionUnavailable: true } }
  assert.deepEqual(usageTotals([base, cf], '2026-10-07'), [
    { currency: 'EUR', actual: 4, estimatedMonthly: 0, estimatedYearly: 0, hasActual: true, hasForecast: false, estimationComplete: false },
    { currency: 'USD', actual: 12.5, estimatedMonthly: 0, estimatedYearly: 0, hasActual: true, hasForecast: false, estimationComplete: false },
  ])
  assert.deepEqual(usageTotals([base], '2026-11-01'), [])
  assert.throws(() => usageTotals([], '2026-02-30'), /date/i)
})

test('multiple current billing periods sum within only the latest Cloudflare capture', () => {
  const cf = { ...base, id: 'cf1', provider: 'cloudflare' as const, amount: 4 }
  const cf2 = { ...cf, id: 'cf2', periodStart: '2026-09-21', amount: 7 }
  const old = { ...cf, id: 'old', periodEnd: '2026-10-06', capturedAt: '2026-10-06T12:00:00Z', amount: 100 }
  assert.equal(usageTotals([cf, cf2, old], '2026-10-07')[0]?.actual, 11)
})

test('a new provider capture suppresses stale forecasts and currencies omitted by the provider', () => {
  const oldForecast = { ...base, id: 'forecast', kind: 'forecast' as const, periodEnd: '2026-11-01', amount: 60 }
  const oldEur = { ...base, id: 'euro', currency: 'EUR', amount: 3 }
  const newer = { ...base, id: 'new', capturedAt: '2026-10-08T12:00:00Z', periodEnd: '2026-10-08', amount: 15, metadata: { period: 'current', forecastUnavailable: true } }
  assert.deepEqual(usageTotals([base, oldForecast, oldEur, newer], '2026-10-08'), [{ currency: 'USD', actual: 15, estimatedMonthly: 0, estimatedYearly: 0, hasActual: true, hasForecast: false, estimationComplete: false }])
})

test('forecast-only first-day data does not imply an observed zero-dollar actual', () => {
  const forecast = { ...base, kind: 'forecast' as const, periodEnd: '2026-11-01', capturedAt: '2026-10-01T01:00:00Z', amount: 60 }
  const result = usageTotals([forecast], '2026-10-01')[0]
  assert.equal(result?.hasActual, false)
  assert.equal(result?.hasForecast, true)
})

test('finite individual values cannot overflow aggregates or annual projections', () => {
  const huge = { ...base, amount: Number.MAX_VALUE }
  assert.throws(() => usageTotals([huge, { ...huge, id: 'cf', provider: 'cloudflare' as const }], '2026-10-07'), /finite/i)
  assert.throws(() => usageTotals([{ ...huge, kind: 'forecast', periodEnd: '2026-11-01' }], '2026-10-07'), /finite/i)
})
