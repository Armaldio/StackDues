import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSubscription,
  normalizeCost,
  normalizedTotals,
  nextRenewalOnOrAfter,
  upcomingRenewals,
  type Subscription,
} from '../src/domain/subscriptions.ts'

const vps: Subscription = {
  id: 'vps', name: 'VPS', provider: 'Example host', billingType: 'fixed',
  amount: 12, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month',
  nextRenewalAt: '2026-01-31', status: 'active',
}

test('yearly Bitwarden, four-year Hostinger and monthly VPS retain their original charges', () => {
  const bitwarden = createSubscription({ ...vps, id: 'bitwarden', name: 'Bitwarden', amount: 10, recurrenceUnit: 'year', nextRenewalAt: '2026-02-01' })
  const hostinger = createSubscription({ ...vps, id: 'hostinger', name: 'Hostinger', amount: 192, recurrenceInterval: 4, recurrenceUnit: 'year', nextRenewalAt: '2026-03-01' })
  assert.deepEqual(normalizeCost(bitwarden), { monthly: 10 / 12, yearly: 10 })
  assert.deepEqual(normalizeCost(hostinger), { monthly: 4, yearly: 48 })
  assert.deepEqual(normalizeCost(vps), { monthly: 12, yearly: 144 })
  assert.equal(hostinger.amount, 192)
  assert.deepEqual(normalizedTotals([bitwarden, hostinger, vps]), [{ currency: 'USD', monthly: 16 + 10 / 12, yearly: 202 }])
  assert.deepEqual(upcomingRenewals([bitwarden, hostinger, vps], '2026-01-01', '2026-03-01').map(({ subscription, date, amount }) => [subscription.id, date, amount]), [
    ['vps', '2026-01-31', 12], ['bitwarden', '2026-02-01', 10], ['vps', '2026-02-28', 12], ['hostinger', '2026-03-01', 192],
  ])
})

test('normalization uses 365 days, 365/7 weeks and 12 months per year', () => {
  assert.deepEqual(normalizeCost({ ...vps, amount: 2, recurrenceInterval: 2, recurrenceUnit: 'day' }), { monthly: 365 / 12, yearly: 365 })
  assert.deepEqual(normalizeCost({ ...vps, amount: 14, recurrenceInterval: 2, recurrenceUnit: 'week' }), { monthly: 365 / 12, yearly: 365 })
  assert.deepEqual(normalizeCost({ ...vps, amount: 30, recurrenceInterval: 3 }), { monthly: 10, yearly: 120 })
  assert.deepEqual(normalizeCost({ ...vps, amount: 24, recurrenceInterval: 2, recurrenceUnit: 'year' }), { monthly: 1, yearly: 12 })
})

test('totals keep currencies separate and exclude paused and cancelled commitments', () => {
  assert.deepEqual(normalizedTotals([
    vps,
    { ...vps, id: 'euro', amount: 8, currency: 'EUR' },
    { ...vps, id: 'paused', amount: 100, status: 'paused' },
    { ...vps, id: 'cancelled', amount: 200, status: 'cancelled' },
  ]), [{ currency: 'EUR', monthly: 8, yearly: 96 }, { currency: 'USD', monthly: 12, yearly: 144 }])
  assert.deepEqual(normalizedTotals([]), [])
})

test('monthly renewals clamp short months but remain anchored to January 31', () => {
  assert.equal(nextRenewalOnOrAfter(vps, '2026-02-01'), '2026-02-28')
  assert.equal(nextRenewalOnOrAfter(vps, '2026-03-01'), '2026-03-31')
  assert.deepEqual(upcomingRenewals([vps], '2026-01-31', '2026-04-30').map(({ date }) => date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
})

test('quarterly renewals preserve the original month-end anchor', () => {
  const quarterly = { ...vps, recurrenceInterval: 3 }
  assert.deepEqual(upcomingRenewals([quarterly], '2026-01-01', '2026-10-31').map(({ date }) => date), ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31'])
})

test('leap-day yearly renewals return to February 29 in a leap year', () => {
  const leap = { ...vps, recurrenceUnit: 'year' as const, nextRenewalAt: '2024-02-29' }
  assert.deepEqual(upcomingRenewals([leap], '2024-02-29', '2028-02-29').map(({ date }) => date), ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'])
})

test('day and week recurrence uses UTC calendar days across daylight-saving dates', () => {
  assert.equal(nextRenewalOnOrAfter({ ...vps, recurrenceUnit: 'day', nextRenewalAt: '2026-03-07' }, '2026-03-09'), '2026-03-09')
  assert.equal(nextRenewalOnOrAfter({ ...vps, recurrenceUnit: 'week', recurrenceInterval: 2, nextRenewalAt: '2026-03-01' }, '2026-03-02'), '2026-03-15')
})

test('renewal windows include both boundaries, retain future anchors and omit inactive subscriptions', () => {
  assert.equal(nextRenewalOnOrAfter(vps, '2025-01-01'), '2026-01-31')
  assert.equal(nextRenewalOnOrAfter(vps, '2026-01-31'), '2026-01-31')
  assert.deepEqual(upcomingRenewals([vps], '2026-02-28', '2026-02-28').map(({ date }) => date), ['2026-02-28'])
  assert.deepEqual(upcomingRenewals([vps], '2026-02-01', '2026-02-27'), [])
  for (const status of ['paused', 'cancelled'] as const) {
    assert.equal(nextRenewalOnOrAfter({ ...vps, status }, '2026-01-31'), null)
    assert.deepEqual(upcomingRenewals([{ ...vps, status }], '2026-01-01', '2027-01-01'), [])
  }
})

test('far-past anchors advance directly without mutating subscription dates', () => {
  const old = { ...vps, recurrenceUnit: 'day' as const, nextRenewalAt: '1900-01-01' }
  assert.equal(nextRenewalOnOrAfter(old, '2026-10-07'), '2026-10-07')
  assert.equal(old.nextRenewalAt, '1900-01-01')
})

test('dates before year 100 and recurrence past the supported date range are handled', () => {
  assert.equal(nextRenewalOnOrAfter({ ...vps, nextRenewalAt: '0001-01-31' }, '0001-02-01'), '0001-02-28')
  assert.equal(nextRenewalOnOrAfter({ ...vps, nextRenewalAt: '9999-12-31', recurrenceUnit: 'year' }, '9999-12-31'), '9999-12-31')
  assert.deepEqual(upcomingRenewals([{ ...vps, nextRenewalAt: '9999-12-31', recurrenceUnit: 'year' }], '9999-12-31', '9999-12-31').map(({ date }) => date), ['9999-12-31'])
})

test('huge valid recurrence intervals stop cleanly outside the supported calendar range', () => {
  for (const recurrenceUnit of ['day', 'week', 'month', 'year'] as const) {
    const subscription = createSubscription({ ...vps, recurrenceUnit, recurrenceInterval: Number.MAX_SAFE_INTEGER })
    assert.equal(nextRenewalOnOrAfter(subscription, '2026-02-01'), null)
    assert.deepEqual(upcomingRenewals([subscription], '2026-01-01', '9999-12-31').map(({ date }) => date), ['2026-01-31'])
  }
})

test('creation trims text, allows zero costs and returns a separate fixed subscription', () => {
  const input = { ...vps, id: ' vps ', name: ' VPS ', provider: ' Example host ', amount: 0 }
  assert.deepEqual(createSubscription(input), { ...vps, amount: 0 })
  assert.equal(input.name, ' VPS ')
  assert.equal(createSubscription({ ...vps, provider: undefined }).provider, undefined)
})

test('invalid monetary inputs are rejected', () => {
  for (const amount of [-1, NaN, Infinity, -Infinity]) assert.throws(() => createSubscription({ ...vps, amount }), /amount/i)
  for (const currency of ['', 'US', 'USDD', 'usd', 'U$D']) assert.throws(() => createSubscription({ ...vps, currency }), /currency/i)
})

test('invalid recurrence intervals and calendar dates are rejected', () => {
  for (const recurrenceInterval of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createSubscription({ ...vps, recurrenceInterval }), /interval/i)
  for (const nextRenewalAt of ['0000-01-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', 'not a date', '2026-01-01T00:00:00Z']) assert.throws(() => createSubscription({ ...vps, nextRenewalAt }), /date/i)
  assert.equal(createSubscription({ ...vps, nextRenewalAt: '2024-02-29' }).nextRenewalAt, '2024-02-29')
})

test('invalid text and domain discriminators are rejected at runtime', () => {
  for (const field of ['id', 'name'] as const) assert.throws(() => createSubscription({ ...vps, [field]: '  ' }), new RegExp(field, 'i'))
  assert.throws(() => createSubscription({ ...vps, provider: ' ' }), /provider/i)
  assert.throws(() => createSubscription({ ...vps, billingType: 'variable' } as unknown as Subscription), /fixed/i)
  assert.throws(() => createSubscription({ ...vps, status: 'unknown' } as unknown as Subscription), /status/i)
  assert.throws(() => createSubscription({ ...vps, recurrenceUnit: 'quarter' } as unknown as Subscription), /unit/i)
})

test('invalid query dates and inverted renewal windows are rejected', () => {
  assert.throws(() => nextRenewalOnOrAfter(vps, '2026-02-30'), /date/i)
  assert.throws(() => upcomingRenewals([], '2026-02-30', '2026-03-01'), /date/i)
  assert.throws(() => upcomingRenewals([], '2026-03-01', '2026-02-01'), /window/i)
})
