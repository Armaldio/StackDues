import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostingerCoverage, hostingerFreshness, hostingerRowStatus, type HostingerCoverageDiscovery, type HostingerCoverageRow } from '../src/domain/hostinger-coverage.ts'
import { normalizedTotals, type Subscription } from '../src/domain/subscriptions.ts'

const now = new Date('2026-10-12T12:00:00Z')
const sync = { status: 'synced', lastSyncedAt: now.toISOString(), lastAttemptAt: now.toISOString() }
const row: HostingerCoverageRow = { status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', isAutoRenewed: true, linkedSubscriptionId: 'saved', seenInLatestSync: true, automaticallyLinked: true, excluded: false, possibleMatches: [], providerNameCollision: false, renewalAvailable: true }
const saved: Subscription = { id: 'saved', name: 'Hosting', provider: 'Hostinger', billingType: 'fixed', amount: 120, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: '2026-10-15', status: 'active' }

test('failed Hostinger coverage explains omissions without changing retained commitment totals', () => {
  const discovery: HostingerCoverageDiscovery = { subscriptions: [{ ...row, seenInLatestSync: false }], sync: { ...sync, status: 'error', lastAttemptAt: now.toISOString(), lastSyncedAt: '2026-10-05T12:00:00Z' } }
  const before = JSON.stringify(discovery)
  const warning = hostingerCoverage(discovery, true, now)
  assert.match(warning, /sync failed/)
  assert.match(warning, /remain in monthly averages/)
  assert.match(warning, /omitted from upcoming charges/)
  assert.equal(hostingerRowStatus(discovery.subscriptions[0]!, discovery.sync, now), 'Unconfirmed · last sync failed')
  assert.deepEqual(normalizedTotals([saved]), [{ currency: 'USD', monthly: 10, yearly: 120 }])
  assert.equal(JSON.stringify(discovery), before)
  assert.doesNotMatch(warning, /120|2026-10-15/)
})

test('week-old sync is stale while recent success and unconfigured empty coverage are quiet', () => {
  const stale = { ...sync, lastSyncedAt: '2026-10-05T12:00:00Z' }
  assert.equal(hostingerFreshness(stale, now), 'stale')
  assert.match(hostingerCoverage({ subscriptions: [row], sync: stale }, true, now), /last known values/)
  assert.match(hostingerRowStatus(row, stale, now), /Stale/)
  assert.equal(hostingerCoverage({ subscriptions: [row], sync }, true, now), '')
  assert.equal(hostingerCoverage(undefined, false, now), '')
  assert.match(hostingerCoverage(undefined, true, now), /no successful sync/)
})

test('partial coverage distinguishes missing, ambiguous, excluded and unsupported renewals', () => {
  const rows = [
    { ...row, seenInLatestSync: false },
    { ...row, externalId: 'review', linkedSubscriptionId: null, possibleMatches: [{ id: 'manual', name: 'Hosting' }] },
    { ...row, externalId: 'excluded', linkedSubscriptionId: null, excluded: true },
    { ...row, externalId: 'unsupported', linkedSubscriptionId: null, renewalAvailable: false, recurrenceUnit: 'unsupported' },
    { ...row, externalId: 'not-renewing', linkedSubscriptionId: null, renewalAvailable: false, isAutoRenewed: false },
    { ...row, externalId: 'no-date', linkedSubscriptionId: null, renewalAvailable: false, nextBillingAt: null },
  ]
  const warning = hostingerCoverage({ subscriptions: rows, sync }, true, now)
  assert.match(warning, /1 Hostinger service is missing/)
  assert.match(warning, /1 possible renewal needs review/)
  assert.match(warning, /1 service is excluded/)
  assert.match(warning, /1 service is not renewing/)
  assert.match(warning, /1 service has an unsupported billing period/)
  assert.match(warning, /1 service is unconfirmed because the renewal price or date was not reported/)
  assert.match(hostingerRowStatus(rows[0]!, sync, now), /Missing/)
  assert.match(hostingerRowStatus(rows[1]!, sync, now), /needs review/)
  assert.match(hostingerRowStatus(rows[2]!, sync, now), /Excluded/)
  assert.match(hostingerRowStatus(rows[3]!, sync, now), /Unsupported/)
  assert.equal(hostingerRowStatus(rows[4]!, sync, now), 'Not renewing')
  assert.match(hostingerRowStatus(rows[5]!, sync, now), /price or date not reported/)
})
