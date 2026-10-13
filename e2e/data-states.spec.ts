import { expect, test, type Page } from '@playwright/test'

const routes = [
  { path: '/', title: 'Overview' },
  { path: '/services', title: 'Services' },
  { path: '/connections', title: 'Connections' },
  { path: '/history', title: 'History' },
] as const
const emptyFeed = { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } } }
const noConnections = Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: false, revision: 0 }]))
const noHostinger = { subscriptions: [], sync: { status: 'not-configured' } }

async function readyResponses(page: Page) {
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [] }))
  await page.route('**/api/costs', route => route.fulfill({ json: emptyFeed }))
  await page.route('**/api/connections', route => route.fulfill({ json: noConnections }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: noHostinger }))
}

for (const route of routes) for (const width of [375, 1440]) test(`delayed initial reads stay pending on ${route.title} at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/subscriptions**', async request => { await gate; return request.fulfill({ json: [] }) })
  await page.route('**/api/costs', async request => { await gate; return request.fulfill({ json: emptyFeed }) })
  await page.route('**/api/connections', async request => { await gate; return request.fulfill({ json: noConnections }) })
  await page.route('**/api/hostinger/subscriptions', async request => { await gate; return request.fulfill({ json: noHostinger }) })
  const requests = [
    page.waitForRequest('**/api/subscriptions'), page.waitForRequest('**/api/costs'),
    page.waitForRequest('**/api/connections'), page.waitForRequest('**/api/hostinger/subscriptions'),
  ]
  await page.goto(route.path)
  await Promise.all(requests)
  await expect(page.locator('body')).not.toContainText('No cost history yet')
  await expect(page.locator('body')).not.toContainText('No active renewal is scheduled')
  await expect(page.locator('body')).not.toContainText('0 upcoming occurrences')
  if (route.path === '/history') await expect(page.getByRole('heading', { name: 'Checking cost history' })).toBeVisible()
  if (route.path === '/connections') await expect(page.getByRole('status').filter({ hasText: 'Checking saved provider connections' })).toBeVisible()
  release()
  if (route.path === '/history') await expect(page.getByRole('heading', { name: 'No cost history yet' })).toBeVisible()
  if (route.path === '/') await expect(page.locator('.overview-empty')).toContainText('No spending data has arrived yet')
  if (route.path === '/services') await expect(page.locator('.subscriptions-empty')).toContainText('No fixed subscriptions yet')
  if (route.path === '/connections') await expect(page.locator('.connection-card').first()).toContainText('Not connected')
})

test('initial cost-feed 401 is shown as expired access, not empty history', async ({ page }) => {
  await readyResponses(page)
  await page.route('**/api/costs', route => route.fulfill({ status: 401, body: 'expired' }))
  await page.goto('./history')
  await expect(page.locator('.error-message')).toContainText('Your session expired')
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible()
  await expect(page.locator('#history .section-header')).toContainText('Saved observations unavailable')
  await expect(page.locator('#history .section-header')).not.toContainText('0 saved observations')
  await expect(page.getByRole('heading', { name: 'Cost history unavailable' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'No cost history yet' })).toHaveCount(0)
})

test('initial cost-feed 5xx and subscription rejection do not claim an empty report or schedule', async ({ page }) => {
  await readyResponses(page)
  await page.route('**/api/costs', route => route.fulfill({ status: 503, body: 'offline' }))
  await page.route('**/api/subscriptions**', route => route.fulfill({ status: 503, body: 'offline' }))
  await page.goto('./history')
  await expect(page.getByRole('heading', { name: 'Cost history unavailable' })).toBeVisible()
  await expect(page.locator('#timeline')).toContainText('payment schedule coverage is incomplete')
  await expect(page.locator('#timeline')).not.toContainText('No active renewal is scheduled')
  await expect(page.getByRole('heading', { name: 'No cost history yet' })).toHaveCount(0)
})

test('Hostinger read failure keeps an independently saved Hostinger-labeled commitment', async ({ page }) => {
  const manual = { id: 'manual-hosting', name: 'Manual hosting plan', provider: 'Hostinger', billingType: 'fixed', amount: 120, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: '2026-10-20', status: 'active', revision: 1 }
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [manual] }))
  await page.route('**/api/costs', route => route.fulfill({ json: emptyFeed }))
  await page.route('**/api/connections', route => route.fulfill({ json: { ...noConnections, hostinger: { configured: true, revision: 1 } } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ status: 503, body: 'offline' }))
  await page.goto('./history')
  await expect(page.locator('#timeline')).toContainText('Manual hosting plan')
  await expect(page.locator('#timeline')).toContainText('Hostinger renewal coverage is unavailable')
  await expect(page.locator('#timeline')).toContainText('payment schedule coverage is incomplete')
  await expect(page.locator('#timeline')).not.toContainText('No active renewal is scheduled')
})

test('connection status 401 remains distinct from a successful no-provider first run', async ({ page }) => {
  await readyResponses(page)
  await page.route('**/api/connections', route => route.fulfill({ status: 401, body: 'expired' }))
  await page.goto('./connections')
  await expect(page.getByRole('alert').first()).toContainText('Your session expired')
  await expect(page.getByRole('link', { name: 'Sign in' }).first()).toBeVisible()
  await expect(page.locator('.connection-card').first()).toContainText('Unavailable')
})

test('failed refresh keeps older provider observations visible and dates the retained read', async ({ page }) => {
  const capturedAt = new Date().toISOString()
  const feed = { snapshots: [
    { id: 'aws-now', provider: 'aws', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: 12, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
    { id: 'cloudflare-now', provider: 'cloudflare', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: 3, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
  ], providers: { aws: { status: 'synced', lastSyncedAt: capturedAt }, cloudflare: { status: 'synced', lastSyncedAt: capturedAt } } }
  let calls = 0
  await readyResponses(page)
  await page.unroute('**/api/costs')
  await page.route('**/api/costs', route => ++calls === 1 ? route.fulfill({ json: feed }) : route.fulfill({ status: 503, body: 'offline' }))
  await page.goto('./history')
  await expect(page.locator('#history')).toContainText('AWS')
  await expect(page.locator('#history')).toContainText('Cloudflare')
  await page.evaluate(() => {
    const now = Date.now()
    Date.now = () => now + 16 * 60 * 1000
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.locator('body')).toContainText('The latest billing data check failed. Showing observations from the last successful read')
  await expect(page.locator('#history')).toContainText('AWS')
  await expect(page.locator('#history')).toContainText('Cloudflare')
})
