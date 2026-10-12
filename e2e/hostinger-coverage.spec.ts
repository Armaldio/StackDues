import { expect, test, type Page } from '@playwright/test'

async function fixture(page: Page, status: 'synced' | 'error', stale = false, partial = false) {
  const now = new Date(), today = now.toISOString().slice(0, 10)
  const lastSyncedAt = new Date(now.getTime() - (stale ? 7 * 86400000 : 0)).toISOString()
  const saved = { id: 'hosting-saved', name: 'Saved Hosting', provider: 'Hostinger', billingType: 'fixed', amount: 120, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 }
  const row = { externalId: 'hosting-provider', name: 'Saved Hosting', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 60, renewalPrice: 120, isAutoRenewed: true, createdAt: '2025-01-01T00:00:00Z', expiresAt: null, nextBillingAt: `${today}T00:00:00Z`, linkedSubscriptionId: saved.id, seenInLatestSync: status === 'synced', automaticallyLinked: true, excluded: false, possibleMatches: [], providerNameCollision: false, renewalAvailable: true, upcomingCommitment: 120 }
  const subscriptions = partial ? [row, { ...row, name: 'Possible duplicate', externalId: 'ambiguous', linkedSubscriptionId: null, automaticallyLinked: false, possibleMatches: [{ id: 'manual-match', name: 'Manual hosting' }] }, { ...row, name: 'Excluded Hosting', externalId: 'excluded', linkedSubscriptionId: null, excluded: true }, { ...row, name: 'Non-renewing Hosting', externalId: 'unsupported', linkedSubscriptionId: null, renewalAvailable: false, isAutoRenewed: false, upcomingCommitment: null }] : [row]
  await page.route('**/api/subscriptions', route => route.fulfill({ json: [saved] }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean'].map(provider => [provider, { status: 'not-configured' }])) } }))
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: provider === 'hostinger', revision: 1 }])) }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions, sync: { status, lastSyncedAt, lastAttemptAt: now.toISOString() } } }))
}

for (const width of [320, 375, 768, 1366, 1440]) test(`failed Hostinger sync warns beside retained totals and omitted schedule at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 })
  await fixture(page, 'error')
  await page.goto('/')
  const summary = page.locator('.overview-snapshot')
  await expect(summary).toContainText('USD 10.00')
  await expect(summary.locator('.hostinger-coverage-warning')).toContainText('Saved fixed commitments remain in monthly averages')
  await expect(page.locator('.overview-next-charges .hostinger-coverage-warning')).toContainText('omitted from upcoming charges')
  await expect(page.locator('.overview-renewal-list')).toHaveCount(0)
  await page.goto('/history')
  const schedule = page.locator('.timeline-lane').filter({ has: page.getByRole('heading', { name: 'Payment schedule', exact: true }) })
  await expect(schedule.locator('.hostinger-coverage-warning')).toBeVisible()
  await expect(schedule.locator('.hostinger-coverage-warning')).toContainText('Hostinger sync failed')
  await expect(schedule.getByRole('link', { name: 'Review Hostinger services' })).toHaveAttribute('href', '/services#hostinger-discovery')
  await expect(schedule.locator('.renewal-list li')).toHaveCount(0)
  expect(await schedule.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('week-old Hostinger renewal remains last known and partial coverage is explicit', async ({ page }) => {
  await fixture(page, 'synced', true, true)
  await page.goto('/')
  await expect(page.locator('.overview-snapshot .hostinger-coverage-warning')).toContainText('Hostinger data is stale')
  await expect(page.locator('.overview-snapshot .hostinger-coverage-warning')).toContainText('1 possible renewal needs review')
  await expect(page.locator('.overview-snapshot .hostinger-coverage-warning')).toContainText('1 service is excluded by you')
  await expect(page.locator('.overview-snapshot')).toContainText('USD 10.00')
  await page.goto('/history')
  await expect(page.locator('.hostinger-coverage-warning')).toContainText('last known values')
  await expect(page.locator('.renewal-list li')).toHaveCount(1)
  await expect(page.locator('.schedule-total')).toContainText('USD 120.00')
  await page.goto('/services')
  const discovery = page.locator('#hostinger-discovery')
  await expect(discovery).toContainText('Last successful Hostinger sync')
  await expect(discovery).toContainText('Latest Hostinger sync attempt')
  await expect(discovery).toContainText('Stale (over 36 hours old)')
  await expect(discovery.locator('.hostinger-coverage-warning')).toContainText('no extra commitment is added')
})


test('a manually named Hostinger subscription without a connected account does not imply missing provider coverage', async ({ page }) => {
  await fixture(page, 'synced')
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: false, revision: 0 }])) }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  await page.goto('/')
  await expect(page.locator('.overview-snapshot')).toContainText('USD 10.00')
  await expect(page.locator('.hostinger-coverage-warning')).toHaveCount(0)
  await expect(page.locator('.overview-renewal-list li')).toHaveCount(1)
})
