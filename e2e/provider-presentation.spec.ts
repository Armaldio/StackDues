import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cloudflare/registrar', route => route.fulfill({ json: { registrations: [], sync: { status: 'not-configured' } } }))
})

const today = new Date().toISOString().slice(0, 10)
const capturedAt = new Date().toISOString()
const periodStart = `${today.slice(0, 7)}-01`
const periodEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10)
const providers = ['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger']
const noConnections = Object.fromEntries(providers.map(provider => [provider, { configured: false, revision: 0 }]))
const emptyFeed = { snapshots: [], providers: Object.fromEntries(providers.slice(0, 4).map(provider => [provider, { status: 'not-configured' }])) }
const noHostinger = { subscriptions: [], sync: { status: 'not-configured' } }

async function fixture(page: Page, options: { subscriptions?: object[]; feed?: object; connections?: Record<string, object>; hostinger?: object } = {}) {
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: options.subscriptions ?? [] }))
  const feed = options.feed ? { ...options.feed, providers: { ...emptyFeed.providers, ...((options.feed as { providers?: object }).providers ?? {}) } } : emptyFeed
  await page.route('**/api/costs', route => route.fulfill({ json: feed }))
  await page.route('**/api/connections', route => route.fulfill({ json: options.connections ?? noConnections }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: options.hostinger ?? noHostinger }))
}

function subscription(id: string, amount: number, currency: string) {
  return { id, name: id, provider: undefined, billingType: 'fixed', amount, currency, recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 }
}

test('manual EUR stays separate from USD-only cloud usage while explicit zero and actual spend remain visible', async ({ page }) => {
  const connections = { ...noConnections, cloudflare: { configured: true, revision: 1 }, aws: { configured: true, revision: 1 } }
  const snapshots = [
    { id: 'cf-zero', provider: 'cloudflare', periodStart, periodEnd, amount: 0, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
    { id: 'aws-actual', provider: 'aws', periodStart, periodEnd, amount: 18.75, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
  ]
  const feed = { snapshots, providers: { aws: { status: 'synced', lastSyncedAt: capturedAt }, cloudflare: { status: 'synced', lastSyncedAt: capturedAt } } }
  await fixture(page, { subscriptions: [subscription('Manual EUR service', 23, 'EUR')], connections, feed })
  await page.goto('/')
  const eur = page.locator('.overview-currency-card').filter({ hasText: 'EUR' })
  const usd = page.locator('.overview-currency-card').filter({ hasText: 'USD' })
  await expect(eur).toContainText('EUR 23.00')
  await expect(eur).not.toContainText('Cloud usage reported')
  await expect(usd).toContainText('USD 18.75')
  await expect(usd).toContainText('Provider-reported costs · current period')
  await page.goto('/services')
  const infrastructure = page.locator('#infrastructure')
  await expect(infrastructure.locator('.provider-panel').filter({ hasText: 'Cloudflare' })).toContainText('$0.00')
  await expect(infrastructure).toContainText('$18.75')
})

test('connection status stays checking when connections are pending and an empty feed has already loaded', async ({ page }) => {
  await fixture(page, { subscriptions: [subscription('Manual EUR service', 23, 'EUR')] })
  await page.unroute('**/api/connections')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/connections', async route => { await gate; return route.fulfill({ json: noConnections }) })
  await page.goto('/')
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'EUR' })).toContainText('Checking saved provider data')
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'EUR' })).not.toContainText('Not connected')
  release()
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'EUR' })).not.toContainText('Cloud usage reported')
})

test('saved credentials await the first report and unsupported forecasts stay quiet', async ({ page }) => {
  const connections = { ...noConnections, cloudflare: { configured: true, revision: 1 } }
  const feed = { snapshots: [{ id: 'cf-actual', provider: 'cloudflare', periodStart, periodEnd, amount: 5.25, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } }], providers: { cloudflare: { status: 'synced', lastSyncedAt: capturedAt } } }
  await fixture(page, { connections, feed })
  await page.goto('/services')
  const cloudflareCard = page.locator('.provider-inventory-card').filter({ hasText: 'Cloudflare' })
  await expect(cloudflareCard).toContainText('Synced')
  await expect(cloudflareCard).toContainText('Last successful sync')
  await expect(cloudflareCard).toContainText(new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(capturedAt)))
  await expect(page.locator('#infrastructure')).toContainText('Not provided by this provider')
  await fixture(page, { connections, feed: { snapshots: [], providers: { cloudflare: { status: 'not-configured' } } } })
  await page.reload()
  await expect(page.locator('.provider-inventory-card').filter({ hasText: 'Cloudflare' })).toContainText('Credentials saved · awaiting first report')
})

test('stale Hostinger credentials and data share the 36-hour freshness status', async ({ page }) => {
  const connections = { ...noConnections, hostinger: { configured: true, revision: 1 } }
  const lastSyncedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  await fixture(page, { connections, hostinger: { subscriptions: [], sync: { status: 'synced', lastSyncedAt } } })
  await page.goto('/connections')
  const hostinger = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Hostinger', exact: true }) })
  await expect(hostinger.locator('.status-pill')).toContainText('Stale')
})
