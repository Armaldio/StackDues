import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cloudflare/registrar', route => route.fulfill({ json: { registrations: [], sync: { status: 'not-configured' } } }))
})

const fixed = [
  { id: 'euro-plan', name: 'Euro Plan', provider: 'Hostinger', billingType: 'fixed', amount: 37.99, currency: 'EUR', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: '2026-11-12', status: 'active', revision: 1 },
  { id: 'paused-domain', name: 'Paused Domain', provider: 'Manual', billingType: 'fixed', amount: 18, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2027-01-12', status: 'paused', revision: 1 },
]
const hostingerRows = [
  { externalId: 'linked-1', name: 'Linked Hosting', status: 'active', recurrenceInterval: 1, recurrenceUnit: 'year', currency: 'USD', totalPrice: 100, renewalPrice: 40, isAutoRenewed: true, createdAt: '2025-01-01', expiresAt: null, nextBillingAt: '2027-01-01', linkedSubscriptionId: 'euro-plan', seenInLatestSync: true, automaticallyLinked: false, excluded: false, possibleMatches: [], providerNameCollision: false, renewalAvailable: true, upcomingCommitment: 40 },
  { externalId: 'candidate-1', name: 'Candidate Hosting', status: 'active', recurrenceInterval: 1, recurrenceUnit: 'year', currency: 'EUR', totalPrice: 60, renewalPrice: 25, isAutoRenewed: true, createdAt: '2025-01-01', expiresAt: null, nextBillingAt: '2027-01-01', linkedSubscriptionId: null, seenInLatestSync: true, automaticallyLinked: false, excluded: false, possibleMatches: [], providerNameCollision: false, renewalAvailable: true, upcomingCommitment: 25 },
  { externalId: 'unavailable-1', name: 'Unavailable Hosting', status: 'active', recurrenceInterval: null, recurrenceUnit: null, currency: 'USD', totalPrice: null, renewalPrice: null, isAutoRenewed: false, createdAt: '2025-01-01', expiresAt: null, nextBillingAt: null, linkedSubscriptionId: null, seenInLatestSync: true, automaticallyLinked: false, excluded: false, possibleMatches: [], providerNameCollision: false, renewalAvailable: false, upcomingCommitment: null },
]

test('Services inventory searches fixed and provider entries, marks discoveries uncounted, and fits narrow screens', async ({ page }) => {
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: fixed }))
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 }, digitalocean: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } } } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: hostingerRows, sync: { status: 'synced', lastSyncedAt: '2026-10-12T10:00:00Z' } } }))
  await page.route('**/api/cloudflare/registrar', route => route.fulfill({ json: { registrations: [{ domainName: 'example.com', status: 'active', expiresAt: '2027-04-02', autoRenew: true, seenInLatestSync: true }], sync: { status: 'synced', lastSyncedAt: '2026-10-12T10:00:00Z' } } }))
  await page.goto('/services')
  const inventory = page.locator('.service-inventory')
  await expect(inventory.getByRole('heading', { name: 'Services 10 entries' })).toBeVisible()
  const counts = inventory.getByLabel('Matching entry counts')
  await expect(counts.locator('li').nth(0)).toHaveText('Fixed subscriptions 2')
  await expect(counts.locator('li').nth(1)).toHaveText('Provider entries 5')
  await expect(counts.locator('li').nth(2)).toHaveText('Uncounted discoveries 3')
  await expect(inventory.getByRole('button', { name: 'Cloudflare', exact: true })).toBeVisible()
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Euro Plan' })).toContainText('EUR 37.99')
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Euro Plan' })).toContainText('Monthly equivalent')
  await expect(inventory.getByRole('heading', { name: /Fixed subscriptions 2/ })).toBeVisible()
  await expect(inventory.getByRole('heading', { name: /Provider accounts 5/ })).toBeVisible()
  await expect(inventory.locator('.subscription-inventory-card').filter({ hasText: 'Euro Plan' })).toContainText('Manually saved subscription · linked to this Hostinger service.')
  await expect(inventory.locator('.subscription-inventory-card').filter({ hasText: 'Euro Plan' })).toHaveCount(1)
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Candidate Hosting' })).toContainText('Needs review')
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Candidate Hosting' })).toContainText('not included in fixed commitments')
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Unavailable Hosting' })).toContainText('Unavailable')
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Linked Hosting' })).toHaveCount(0)
  const registrarDomain = inventory.locator('.inventory-card').filter({ hasText: 'example.com' })
  await expect(registrarDomain).toContainText('Auto-renews')
  await expect(registrarDomain).toContainText('2027-04-02')
  await expect(registrarDomain).toContainText('Unavailable from Cloudflare API')
  await expect(inventory.getByRole('heading', { name: /Fixed subscriptions 2/ })).toBeVisible()

  const search = page.getByRole('searchbox', { name: 'Search services' })
  await search.fill('Cloudflare')
  await expect(counts.locator('li').nth(0)).toHaveText('Fixed subscriptions 0')
  await expect(counts.locator('li').nth(1)).toHaveText('Provider entries 1')
  await expect(counts.locator('li').nth(2)).toHaveText('Uncounted discoveries 1')
  await expect(inventory.locator('.inventory-card')).toHaveCount(2)
  await expect(inventory.locator('.provider-inventory-card').filter({ hasText: 'Cloudflare' })).toContainText('Not connected')
  await page.getByLabel('Filter service entries by type').selectOption('fixed')
  await expect(inventory.getByRole('status')).toContainText('No entries match')
  await page.getByLabel('Filter service entries by type').selectOption('all')
  await search.fill('Candidate Hosting')
  await page.getByLabel('Filter service entries by type').selectOption('discovered')
  await expect(inventory.locator('.inventory-card')).toHaveCount(1)
  await expect(counts.locator('li').nth(0)).toHaveText('Fixed subscriptions 0')
  await expect(counts.locator('li').nth(1)).toHaveText('Provider entries 0')
  await expect(counts.locator('li').nth(2)).toHaveText('Uncounted discoveries 1')
  await page.getByLabel('Filter service entries by type').selectOption('all')
  await search.clear()
  await page.getByLabel('Filter fixed subscriptions by status').selectOption('active')
  await expect(counts.locator('li').nth(0)).toHaveText('Fixed subscriptions 1')
  await expect(counts.locator('li').nth(1)).toHaveText('Provider entries 5')
  await expect(counts.locator('li').nth(2)).toHaveText('Uncounted discoveries 3')
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Paused Domain' })).toHaveCount(0)
  await expect(inventory.locator('.inventory-card').filter({ hasText: 'Euro Plan' })).toBeVisible()
  await expect(inventory.locator('.provider-inventory-card').filter({ hasText: 'Cloudflare' })).toBeVisible()
  await search.fill('not-a-service')
  await expect(inventory.getByRole('status')).toContainText('No entries match')
  await search.clear()

  for (const width of [320, 375, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Services should fit at ${width}px`).toBe(true)
    await expect(inventory.locator('.inventory-card').first()).toBeVisible()
  }
  await search.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Filter service entries by type')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Filter fixed subscriptions by status')).toBeFocused()
  await inventory.locator('.discovered-inventory-card').filter({ hasText: 'Candidate Hosting' }).getByRole('button', { name: 'Review Hostinger matches and actions' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#hostinger-discovery')).toBeFocused()
  await expect(page.locator('#hostinger-discovery')).toBeInViewport()
})

test('Services keeps the Hostinger hash target and redirects the genuine root legacy path', async ({ page }) => {
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [] }))
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 }, digitalocean: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } } } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  await page.goto('/services#hostinger-discovery')
  await expect(page).toHaveURL(/\/services#hostinger-discovery$/)
  await expect(page.locator('#hostinger-discovery')).toBeFocused()
  await page.goto('/#hostinger-discovery')
  await expect(page).toHaveURL(/\/services#hostinger-discovery$/)
  await expect(page.locator('#hostinger-discovery')).toBeFocused()
})
