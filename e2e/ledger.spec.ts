import { expect, test, type Page } from '@playwright/test'

async function mockLedger(page: Page, initial: Record<string, unknown>[] = [], mockCosts = true) {
  let subscriptions = initial
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  if (mockCosts) await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' } } } }))
  await page.route('**/api/subscriptions**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'GET') return route.fulfill({ json: subscriptions })
    const body = request.method() === 'DELETE' ? undefined : request.postDataJSON()
    if (path.endsWith('/import')) {
      const createdIds: string[] = []
      for (const item of body.subscriptions) if (!subscriptions.some(existing => existing.id === item.id)) { subscriptions.push({ ...item, revision: 1 }); createdIds.push(item.id) }
      return route.fulfill({ json: { subscriptions, createdIds } })
    }
    if (request.method() === 'POST') { const item = { ...body, revision: 1 }; subscriptions.push(item); return route.fulfill({ json: item }) }
    const id = decodeURIComponent(path.split('/').at(-1)!)
    const previous = subscriptions.find(item => item.id === id)!
    if (request.method() === 'DELETE') {
      if (request.postData() !== null || request.headers()['if-match'] !== `"${previous.revision}"`) return route.fulfill({ status: 409, json: { error: 'Revision conflict' } })
      subscriptions = subscriptions.filter(item => item.id !== id); return route.fulfill({ json: { deleted: true } })
    }
    const item = { ...body.subscription, revision: Number(previous.revision) + 1 }
    subscriptions = subscriptions.map(existing => existing.id === id ? item : existing)
    return route.fulfill({ json: item })
  })
  let hostingerRows: Record<string, unknown>[] = []
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: hostingerRows, sync: { status: 'not-configured' } } }))
  await page.route('**/api/hostinger/subscriptions/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (path.endsWith('/sync')) { hostingerRows = hostingerRows.map(row => ({ ...row, seenInLatestSync: true })); return route.fulfill({ status: 200, json: { subscriptions: hostingerRows, sync: { status: 'synced' } } }) }
    const externalId = decodeURIComponent(path.split('/').at(-2)!)
    const row = hostingerRows.find(item => item.externalId === externalId)!
    if (path.endsWith('/entry')) row.linkedSubscriptionId = `hostinger-${externalId}`
    else row.linkedSubscriptionId = String(request.postDataJSON().subscriptionId)
    return route.fulfill({ json: { id: row.linkedSubscriptionId, name: row.name, provider: 'Hostinger', billingType: 'fixed', amount: row.renewalPrice, currency: row.currency, recurrenceInterval: row.recurrenceInterval, recurrenceUnit: row.recurrenceUnit, nextRenewalAt: String(row.nextBillingAt).slice(0, 10), status: 'active', revision: 1 } })
  })
  return { addSubscription(item: Record<string, unknown>) { subscriptions.push(item) } }
}

async function add(page: Page, name: string, amount: string, interval: string, unit: string, currency = 'USD') {
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Amount per charge').fill(amount)
  await form.getByLabel('Repeats every').fill(interval)
  await form.getByLabel('Time unit', { exact: true }).selectOption(unit)
  await form.getByLabel('Currency', { exact: true }).fill(currency)
  await form.getByRole('button', { name: 'Save subscription', exact: true }).click()
  await expect(form).not.toBeVisible()
}

test('first run prioritizes provider connections and preserves a keyboard-friendly manual fallback', async ({ page }) => {
  await mockLedger(page)
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('./')
  await expect(page).toHaveTitle('StackDues — subscriptions & infrastructure')
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/favicon.svg')
  await expect(page.getByRole('link', { name: 'StackDues' })).toBeVisible()
  await expect(page.locator('.app-footer')).toContainText('StackDues')
  const connect = page.getByRole('link', { name: 'Connect a provider' })
  const addManually = page.getByRole('button', { name: 'Add manually', exact: true }).first()
  await expect(connect).toBeVisible()
  await expect(addManually).toBeVisible()
  await expect(page.getByText('Try example subscriptions')).toHaveCount(0)
  await expect(page.getByRole('row')).toHaveCount(0)
  const emptyDownloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download subscriptions JSON' }).click()
  const emptyDownload = await emptyDownloadPromise
  expect(emptyDownload.suggestedFilename()).toBe('stackdues-subscriptions.json')
  const { readFile } = await import('node:fs/promises')
  expect(await readFile((await emptyDownload.path())!, 'utf8')).toBe('[]')
  const nav = page.getByRole('navigation', { name: 'Primary' })
  await expect(nav.getByRole('link')).toHaveCount(4)
  await expect(nav.getByRole('link')).toHaveText(['Overview', 'Subscriptions 0', 'Connections', 'History'])
  await nav.getByRole('link', { name: 'Overview' }).focus()
  await page.keyboard.press('Tab')
  await expect(nav.getByRole('link', { name: /Subscriptions/ })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(nav.getByRole('link', { name: 'Connections' })).toBeFocused()
  await page.keyboard.press('Tab')
  const history = nav.getByRole('link', { name: 'History' })
  await expect(history).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#history$/)
  await expect(history).toHaveAttribute('aria-current', 'location')
  await connect.focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#connections$/)
  await addManually.press('Enter')
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('connector catalog searches and filters supported versus planned providers accessibly', async ({ page }) => {
  await mockLedger(page)
  await page.route('**/api/connections', async route => {
    await new Promise(resolve => setTimeout(resolve, 1_000))
    return route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } })
  })
  await page.setViewportSize({ width: 320, height: 850 })
  await page.goto('./#connections')
  const search = page.getByRole('searchbox', { name: 'Search providers' })
  await expect(search).toBeVisible()
  const firstAvailable = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services' }) })
  await expect(firstAvailable.getByText('Not connected', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Reload connections' }).click()
  await expect(page.getByRole('button', { name: 'Loading…' })).toBeVisible()
  await search.focus()
  await expect(search).toBeFocused()
  await search.fill('DigitalOcean')
  const digitalOcean = page.locator('.coming-soon-card').filter({ hasText: 'DigitalOcean' })
  await expect(digitalOcean).toBeVisible()
  await expect(digitalOcean).toContainText('billing:read')
  await expect(digitalOcean.getByRole('button')).toHaveCount(0)
  const supportedCards = page.locator('.connection-grid:not(.planned-grid) .connection-card')
  await expect(supportedCards).toHaveCount(0)
  await search.fill('no matching provider')
  await expect(page.getByText('No providers match your search.')).toBeVisible()
  await search.fill('')
  await page.getByLabel('Provider availability').selectOption('coming-soon')
  await expect(page.locator('.coming-soon-card')).toHaveCount(2)
  await expect(supportedCards).toHaveCount(0)
  await page.getByLabel('Provider availability').selectOption('available')
  await expect(supportedCards).toHaveCount(4)
  const aws = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services' }) })
  await expect(aws).toContainText('Actual usage, comparable period and full-month forecast when available')
  await expect(aws).toContainText('Cost Explorer read-only')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('connection sync failure offers retry and then reports the latest successful refresh', async ({ page }) => {
  await mockLedger(page)
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let revision = 0
  let attempts = 0
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: revision > 0, revision }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/connections/aws', route => { revision++; return route.fulfill({ json: { configured: true, revision } }) })
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: attempts < 2 ? [] : [{ id: 'aws-actual', provider: 'aws', periodStart: `${capturedAt.slice(0, 7)}-01`, periodEnd: capturedAt.slice(0, 10), amount: 7, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } }], providers: { aws: attempts < 2 ? { status: 'error', lastAttemptAt: capturedAt } : { status: 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt }, cloudflare: { status: 'not-configured' } } } }))
  await page.route('**/api/costs/refresh*', async route => {
    attempts++
    return route.fulfill({ json: { providers: { aws: { status: attempts === 1 ? 'error' : 'synced' } } } })
  })
  await page.goto('./#connections')
  const aws = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services' }) })
  await aws.locator('summary').click()
  await aws.getByLabel('Access key ID').fill('test-key')
  await aws.getByLabel('Secret access key').fill('test-secret')
  await aws.getByRole('button', { name: 'Save Amazon Web Services connection' }).click()
  await expect(aws.getByText('Sync failed', { exact: true })).toBeVisible()
  await aws.getByRole('button', { name: 'Retry Amazon Web Services sync' }).click()
  await expect(aws.getByText('Synced', { exact: true })).toBeVisible()
  await expect(page.locator('.provider-overview-card').filter({ hasText: 'Metered usage' }).first()).toContainText('USD 7.00')
  await expect(aws).toContainText('Last billing sync')
  expect(attempts).toBe(2)
})

test('fresh subscriptions support real recurrence, edits, status changes, deletion, and reload persistence', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await mockLedger(page)
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'No manual subscriptions yet' })).toBeVisible({ timeout: 15_000 })
  await add(page, 'Bitwarden', '10', '1', 'year')
  await add(page, 'Hostinger', '192', '4', 'year')
  await add(page, 'VPS', '12', '1', 'month')
  await expect(page.locator('.monthly-value')).toHaveText('USD 16.83/ mo')
  await expect(page.locator('.metric').first()).toContainText('USD 202.00')
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: 'Hostinger' })).toContainText('Every 4 years')
  await page.getByRole('button', { name: 'Pause VPS in subscriptions', exact: true }).click()
  await expect(page.locator('.monthly-value')).toHaveText('USD 4.83/ mo')
  await page.getByRole('button', { name: 'Resume VPS in subscriptions', exact: true }).click()
  await page.getByRole('button', { name: 'Edit VPS', exact: true }).click()
  await page.getByRole('dialog').getByLabel('Amount per charge').fill('24')
  await page.getByRole('dialog').getByRole('button', { name: 'Save subscription' }).click()
  await expect(page.locator('.monthly-value')).toHaveText('USD 28.83/ mo')
  await add(page, 'Euro domain', '12', '1', 'year', 'EUR')
  await expect(page.locator('.monthly-value')).toHaveText(['EUR 1.00/ mo', 'USD 28.83/ mo'])
  page.on('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Delete Euro domain', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: 'Euro domain' })).toHaveCount(0)
  await page.setViewportSize({ width: 320, height: 850 })
  await expect(page.getByRole('heading', { name: 'Overview.' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(errors).toEqual([])
})

test('subscription export contains importer-compatible account records without server-only fields', async ({ page }) => {
  const subscription = { id: 'hostinger-domain', name: 'Example domain', provider: 'Hostinger', billingType: 'fixed', amount: 12, currency: 'EUR', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2027-10-08', status: 'active', revision: 9, encryptedCredentials: 'private-provider-secret', sessionToken: 'private-session-token' }
  let writes = 0
  await mockLedger(page, [subscription])
  await page.route('**/api/subscriptions**', async route => {
    if (route.request().method() !== 'GET') writes++
    await route.fallback()
  })
  await page.goto('./')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download subscriptions JSON' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('stackdues-subscriptions.json')
  const { readFile } = await import('node:fs/promises')
  const json = await readFile((await download.path())!, 'utf8')
  expect(JSON.parse(json)).toEqual([{ id: 'hostinger-domain', name: 'Example domain', provider: 'Hostinger', billingType: 'fixed', amount: 12, currency: 'EUR', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2027-10-08', status: 'active' }])
  expect(json).not.toMatch(/revision|encryptedCredentials|private-provider-secret|sessionToken|private-session-token/)
  expect(writes).toBe(0)
  await expect(page.getByRole('row').filter({ hasText: 'Example domain' })).toBeVisible()
})

test('subscription export failures stay visible and never mutate the account', async ({ page }) => {
  await page.addInitScript(() => { URL.createObjectURL = () => { throw new Error('browser download blocked') } })
  await mockLedger(page, [{ id: 'keep', name: 'Keep me', billingType: 'fixed', amount: 5, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: '2026-10-08', status: 'active', revision: 1 }])
  await page.goto('./')
  await page.getByRole('button', { name: 'Download subscriptions JSON' }).click()
  await expect(page.getByRole('alert')).toContainText('Your account was not changed')
  await expect(page.getByRole('row').filter({ hasText: 'Keep me' })).toBeVisible()
})

test('subscription export stays disabled when the protected ledger request fails', async ({ page }) => {
  await mockLedger(page)
  await page.route('**/api/subscriptions**', route => route.fulfill({ status: 503, body: 'private-provider-secret' }))
  await page.goto('./')
  const exportButton = page.getByRole('button', { name: 'Download subscriptions JSON' })
  await expect(exportButton).toBeDisabled()
  await expect(page.getByRole('alert')).not.toContainText('private-provider-secret')
})

test('provider observations, incomplete forecasts, failures, stale data, and immutable history render separately', async ({ page }) => {
  const now = new Date()
  const capturedAt = now.toISOString()
  const stale = new Date(now.getTime() - 3 * 86400000).toISOString()
  const periodStart = `${capturedAt.slice(0, 7)}-01`
  const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10)
  const snapshot = { id: 'aws-actual', provider: 'aws', periodStart, periodEnd, amount: 10, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current', breakdown: [{ service: 'EC2', amount: 10, currency: 'USD' }] } }
  const feed = { snapshots: [snapshot, { ...snapshot, id: 'aws-forecast', kind: 'forecast', amount: 30, metadata: { period: 'current' } }, { ...snapshot, id: 'cf-actual', provider: 'cloudflare', amount: 3, capturedAt, metadata: { period: 'current', projectionUnavailable: true, breakdown: [{ service: 'R2 Storage', amount: 3, currency: 'USD' }] } }], providers: { aws: { status: 'synced', lastSyncedAt: capturedAt }, cloudflare: { status: 'error', lastSyncedAt: capturedAt, error: 'raw-provider-secret' } } }
  let fail = false
  await page.route('**/api/costs', route => route.fulfill(fail ? { status: 503, body: 'offline' } : { json: feed }))
  await mockLedger(page, [], false)
  await page.goto('./')
  const infrastructure = page.locator('#infrastructure')
  await expect(infrastructure.getByText('EC2', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText('R2 Storage', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText('Sync failed', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText(/Combined estimate unavailable until every connected provider reports a complete forecast/)).toBeVisible()
  await expect(page.locator('body')).not.toContainText('raw-provider-secret')
  await expect(page.locator('#history')).toContainText('AWS')
  feed.snapshots[2]!.capturedAt = stale
  feed.providers.cloudflare.lastSyncedAt = stale
  await infrastructure.getByRole('button', { name: 'Reload cost data' }).click()
  await expect(infrastructure.getByText(/Data is over 36 hours old/)).toBeVisible()
  fail = true
  await infrastructure.getByRole('button', { name: 'Reload cost data' }).click()
  await expect(infrastructure.getByRole('alert')).toContainText('Previous observations are still displayed')
  await expect(infrastructure.getByText('EC2', { exact: true })).toBeVisible()
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

test('explicit legacy import backs up original JSON, preserves existing account edits and keeps browser records', async ({ page }) => {
  const legacy = { id: 'old-bitwarden', name: 'Bitwarden', billingType: 'fixed', amount: 10, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-10-08', status: 'active' }
  const raw = JSON.stringify([legacy, { ...legacy, id: 'old-vps', name: 'VPS', amount: 12, recurrenceUnit: 'month' }], null, 2)
  await page.addInitScript(raw => localStorage.setItem('ledger.subscriptions.v1', raw), raw)
  await mockLedger(page, [{ ...legacy, amount: 20, revision: 2 }])
  await page.goto('./')
  const panel = page.locator('.legacy-import')
  await panel.locator('summary').click()
  await panel.getByRole('button', { name: 'Use this browser’s ledger' }).click()
  await panel.getByRole('button', { name: 'Preview import' }).click()
  await expect(panel.getByRole('button', { name: 'Import to my account' })).toBeDisabled()
  const downloadPromise = page.waitForEvent('download')
  await panel.getByRole('button', { name: 'Download original backup' }).click()
  const download = await downloadPromise
  const { readFile } = await import('node:fs/promises')
  expect(await readFile((await download.path())!, 'utf8')).toBe(raw)
  await panel.getByRole('button', { name: 'Import to my account' }).click()
  await expect(panel.getByRole('status')).toContainText('1 subscriptions imported and verified')
  await expect(page.getByRole('row').filter({ hasText: 'Bitwarden' })).toContainText('USD 20.00')
  await expect(page.getByRole('row').filter({ hasText: 'VPS' })).toContainText('USD 12.00')
  expect(await page.evaluate(() => localStorage.getItem('ledger.subscriptions.v1'))).toBe(raw)
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: 'VPS' })).toBeVisible()
})


test('connections keep secrets request-only, preserve revisions, and automatically refresh providers', async ({ page }) => {
  await mockLedger(page)
  let revision = 0, configured = false, refreshCalls = 0
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured, revision }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/connections/aws', async route => {
    const request = route.request()
    if (request.method() === 'PUT') {
      expect(request.postDataJSON()).toEqual({ credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' }, revision })
      configured = true; revision++
    } else {
      expect(request.method()).toBe('DELETE'); expect(request.postData()).toBeNull(); expect(request.headers()['if-match']).toBe(`"${revision}"`)
      configured = false; revision++
    }
    return route.fulfill({ json: { configured, revision } })
  })
  await page.route('**/api/costs/refresh*', route => { expect(route.request().method()).toBe('POST'); refreshCalls++; return route.fulfill({ json: { providers: { aws: { status: 'synced' } } } }) })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services', exact: true }) })
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await card.locator('summary').click()
  await card.getByLabel('Access key ID', { exact: true }).fill('test-key')
  await card.getByLabel('Secret access key', { exact: true }).fill('test-secret')
  await card.getByRole('button', { name: 'Save Amazon Web Services connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  expect(refreshCalls).toBe(1)
  await expect(card.getByLabel('Access key ID', { exact: true })).toHaveValue('')
  await expect(card.getByLabel('Secret access key', { exact: true })).toHaveValue('')
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('test-secret')
  await page.locator('#infrastructure').getByRole('button', { name: 'Refresh providers', exact: true }).click()
  await expect(page.locator('#infrastructure').getByRole('button', { name: 'Refresh providers', exact: true })).toBeEnabled()
  expect(refreshCalls).toBe(2)
  page.on('dialog', dialog => dialog.accept())
  await card.getByRole('button', { name: 'Disconnect Amazon Web Services' }).click()
  await expect(card.getByText('Not connected', { exact: true })).toBeVisible()
  await card.getByLabel('Access key ID', { exact: true }).fill('test-key')
  await card.getByLabel('Secret access key', { exact: true }).fill('test-secret')
  await card.getByRole('button', { name: 'Save Amazon Web Services connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  expect(refreshCalls).toBe(4)
  expect(revision).toBe(3)
  await page.setViewportSize({ width: 320, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('connecting AWS automatically updates Overview, Infrastructure and History without double-counting actuals', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10)
  const start = `${today.slice(0, 7)}-01`
  const endDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10)
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const fixed = { id: 'fixed-monthly', name: 'Fixed VPS', billingType: 'fixed', amount: 120, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 }
  await mockLedger(page, [fixed])
  let configured = false, synced = false
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured, revision: configured ? 1 : 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/connections/aws', async route => { configured = true; return route.fulfill({ json: { configured: true, revision: 1 } }) })
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: synced ? [
    { id: 'aws-actual', provider: 'aws', periodStart: start, periodEnd: endDate, amount: 3, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
    { id: 'aws-forecast', provider: 'aws', periodStart: start, periodEnd: endDate, amount: 10, currency: 'USD', kind: 'forecast', capturedAt, metadata: { period: 'current' } },
  ] : [], providers: { aws: synced ? { status: 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt } : { status: 'not-configured' }, cloudflare: { status: 'not-configured' } } } }))
  await page.route('**/api/costs/refresh*', async route => { expect(new URL(route.request().url()).searchParams.get('provider')).toBe('aws'); synced = true; return route.fulfill({ json: { providers: { aws: { status: 'synced' } } } }) })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services', exact: true }) })
  await card.locator('summary').click()
  await card.getByLabel('Access key ID', { exact: true }).fill('test-key')
  await card.getByLabel('Secret access key', { exact: true }).fill('test-secret')
  await card.getByRole('button', { name: 'Save Amazon Web Services connection' }).click()
  await expect(page.locator('.tracked-spending-card')).toContainText('USD 120.00')
  await expect(page.locator('.tracked-spending-card')).toContainText('USD 3.00')
  await expect(page.locator('.tracked-spending-card')).toContainText('USD 10.00')
  await expect(page.locator('.tracked-spending-card')).toContainText('USD 130.00')
  await expect(page.locator('#infrastructure .provider-cost strong').first()).toHaveText('$3.00')
  await expect(page.locator('#history')).toContainText('AWS')
})

test('connecting Cloudflare shows actual spend prominently when no forecast is available', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10)
  const start = `${today.slice(0, 7)}-01`
  const endDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 1)).toISOString().slice(0, 10)
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const fixed = { id: 'fixed-monthly', name: 'Fixed VPS', billingType: 'fixed', amount: 40, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 }
  await mockLedger(page, [fixed])
  let configured = false, synced = false, syncCalls = 0
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured, revision: configured ? 1 : 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/connections/cloudflare', async route => {
    expect(route.request().postDataJSON()).toEqual({ credentials: { accountId: 'test-account', apiToken: 'test-token' }, revision: 0 })
    configured = true
    return route.fulfill({ json: { configured: true, revision: 1 } })
  })
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: synced ? [
    { id: 'cf-actual', provider: 'cloudflare', periodStart: start, periodEnd: endDate, amount: 8, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } },
  ] : [], providers: { aws: { status: 'not-configured' }, cloudflare: synced ? { status: 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt } : { status: 'not-configured' } } } }))
  await page.route('**/api/costs/refresh*', async route => {
    expect(new URL(route.request().url()).searchParams.get('provider')).toBe('cloudflare')
    syncCalls++; synced = true
    return route.fulfill({ json: { providers: { cloudflare: { status: 'synced' } } } })
  })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Cloudflare', exact: true }) })
  await card.locator('summary').click()
  await card.getByLabel('Account ID', { exact: true }).fill('test-account')
  await card.getByLabel('API token', { exact: true }).fill('test-token')
  await card.getByRole('button', { name: 'Save Cloudflare connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage connections' })).toBeVisible()
  await expect(card).toContainText('Next: review current charges in Overview and Infrastructure.')
  const providerOverview = page.locator('.provider-overview-card').filter({ has: page.getByRole('heading', { name: /Cloudflare/ }) })
  await expect(providerOverview).toContainText('USD 8.00')
  await expect(providerOverview).toContainText('Forecast unavailable')
  const overview = page.locator('.tracked-spending-card')
  await expect(overview).toContainText('USD 40.00')
  await expect(overview).toContainText('USD 8.00')
  await expect(overview).toContainText('Combined estimate unavailable')
  await expect(page.locator('#infrastructure .provider-cost strong').first()).toHaveText('$8.00')
  await expect(page.locator('#history')).toContainText('Cloudflare')
  expect(syncCalls).toBe(1)
})

test('OpenAI organization costs connect with explicit admin scope and update Overview, Infrastructure and History', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10)
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await mockLedger(page)
  let configured = false, synced = false
  await page.route('**/api/connections', route => route.fulfill({ json: {
    aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 },
    openai: { configured, revision: configured ? 1 : 0 },
  } }))
  await page.route('**/api/connections/openai', async route => {
    expect(route.request().postDataJSON()).toEqual({ credentials: { adminApiKey: 'test-admin-key' }, revision: 0 })
    configured = true
    return route.fulfill({ json: { configured: true, revision: 1 } })
  })
  await page.route('**/api/costs', route => route.fulfill({ json: {
    snapshots: synced ? [{
      id: 'openai-actual', provider: 'openai', periodStart: today, periodEnd: new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
      amount: 4.75, currency: 'USD', kind: 'actual', capturedAt,
      metadata: { period: 'current', scope: 'organization-api-costs', reportedThrough: capturedAt, breakdown: [{ service: 'Responses · proj_test', amount: 4.75, currency: 'USD' }] },
    }] : [],
    providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: synced ? { status: 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt } : { status: 'not-configured' } },
  } }))
  await page.route('**/api/costs/refresh*', async route => {
    expect(new URL(route.request().url()).searchParams.get('provider')).toBe('openai')
    synced = true
    return route.fulfill({ json: { providers: { openai: { status: 'synced' } } } })
  })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'OpenAI API', exact: true }) })
  await expect(card).toContainText('Organization Admin API key')
  await expect(card).toContainText('ChatGPT Plus is not included')
  await card.locator('summary').click()
  await card.getByLabel('Organization Admin API key').fill('test-admin-key')
  await card.getByRole('button', { name: 'Save OpenAI API connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  await expect(card.getByLabel('Organization Admin API key')).toHaveValue('')
  const overview = page.locator('.provider-overview-card').filter({ has: page.getByRole('heading', { name: /OpenAI API/ }) })
  await expect(overview).toContainText('USD 4.75')
  await expect(overview).toContainText('Forecast unavailable')
  await expect(page.locator('#infrastructure')).toContainText('Organization-reported API costs')
  await expect(page.locator('#infrastructure')).toContainText('$4.75')
  await expect(page.locator('#history')).toContainText('OpenAI API')
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('test-admin-key')
})

test('cost history defaults to latest observations, filters currencies and periods, and reveals older captures on demand', async ({ page }) => {
  const capturedAt = new Date().toISOString()
  const snapshots: Array<{ id: string; provider: string; periodStart: string; periodEnd: string; amount: number; currency: string; kind: string; capturedAt: string; metadata: Record<string, string> }> = Array.from({ length: 31 }, (_, index) => {
    const month = String(index % 12 + 1).padStart(2, '0')
    const year = String(2024 + Math.floor(index / 12))
    return { id: `aws-${index}`, provider: 'aws', periodStart: `${year}-${month}-01`, periodEnd: `${year}-${month}-28`, amount: index + 1, currency: 'USD', kind: 'actual', capturedAt: new Date(Date.UTC(Number(year), Number(month) - 1, 28)).toISOString(), metadata: { period: 'current' } }
  })
  snapshots.push(
    { ...snapshots[0]!, id: 'aws-revised-old', amount: 4, capturedAt: '2026-01-01T10:00:00Z' },
    { ...snapshots[0]!, id: 'aws-revised-new', amount: 5, capturedAt: '2026-01-02T10:00:00Z' },
    { id: 'cf-credit-old', provider: 'cloudflare', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: -3, currency: 'EUR', kind: 'actual', capturedAt: '2026-10-07T10:00:00Z', metadata: { scope: 'billing-period-to-date', reportedThrough: '2026-10-07' } },
    { id: 'cf-credit-new', provider: 'cloudflare', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: -2, currency: 'EUR', kind: 'actual', capturedAt: '2026-10-08T10:00:00Z', metadata: { scope: 'billing-period-to-date', reportedThrough: '2026-10-08' } },
    { id: 'cf-forecast', provider: 'cloudflare', periodStart: '2026-10-01', periodEnd: '2026-11-01', amount: 8, currency: 'EUR', kind: 'forecast', capturedAt, metadata: { scope: 'billing-period-to-date' } },
  )
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots, providers: { aws: { status: 'synced' }, cloudflare: { status: 'synced' } } } }))
  await mockLedger(page, [], false)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('./#history')
  const history = page.locator('#history')
  await expect(history.locator('tbody tr')).toHaveCount(30)
  await expect(history).toContainText('latest observations')
  await expect(history).toContainText('These observations are not separate payments')
  await history.getByRole('combobox', { name: 'Currency' }).selectOption('EUR')
  await expect(history.locator('tbody tr')).toHaveCount(2)
  await expect(history).toContainText('Billing period to date · through 2026-10-08')
  await expect(history.locator('tbody tr').filter({ hasText: 'Actual · to date' })).toContainText(/-EUR\s*2\.00/)
  await expect(history).toContainText('Forecast · full month, includes actuals')
  await history.getByRole('combobox', { name: 'Type' }).selectOption('forecast')
  await expect(history.locator('tbody tr')).toHaveCount(1)
  await history.getByRole('combobox', { name: 'Type' }).selectOption('actual')
  await expect(history.locator('tbody tr')).toHaveCount(1)
  await expect(history.locator('tbody tr').filter({ hasText: 'Actual · to date' })).toContainText(/-EUR\s*2\.00/)
  await history.getByRole('button', { name: 'Show previous captures' }).click()
  await expect(history.locator('tbody tr')).toHaveCount(2)
  await expect(history).toContainText('through 2026-10-07')
  await history.getByRole('combobox', { name: 'Provider' }).selectOption('aws')
  await expect(history.getByText('No observations match these filters.')).toBeVisible()
  await history.getByRole('combobox', { name: 'Currency' }).selectOption('all')
  await expect(history.locator('tbody tr')).toHaveCount(30)
  await history.getByRole('button', { name: 'Show more older entries' }).click()
  await expect(history.locator('tbody tr')).toHaveCount(33)
  await page.setViewportSize({ width: 1440, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('overview shows comparable provider trends, cost drivers, billing periods and freshness on mobile', async ({ page }) => {
  const capturedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const now = new Date()
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const priorStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const date = (value: Date) => value.toISOString().slice(0, 10)
  const currentEnd = new Date(currentStart); currentEnd.setUTCDate(currentEnd.getUTCDate() + 7)
  const priorEnd = new Date(priorStart); priorEnd.setUTCDate(priorEnd.getUTCDate() + 7)
  const snapshots = [
    { id: 'aws-current', provider: 'aws', periodStart: date(currentStart), periodEnd: date(currentEnd), amount: 24, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current', breakdown: [{ service: 'EC2', amount: 18, currency: 'USD' }, { service: 'S3', amount: 6, currency: 'USD' }] } },
    { id: 'aws-prior', provider: 'aws', periodStart: date(priorStart), periodEnd: date(priorEnd), amount: 20, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'previous-comparable' } },
  ]
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots, providers: { aws: { status: 'synced', lastSyncedAt: capturedAt }, cloudflare: { status: 'not-configured' } } } }))
  await mockLedger(page, [], false)
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto('./')
  await expect(page.getByRole('heading', { name: 'Overview.' })).toBeVisible()
  const insights = page.getByRole('region', { name: 'Cost drivers & trend' })
  await expect(insights).toContainText('AWS')
  await expect(insights).toContainText('+20.0%')
  await expect(insights).toContainText('EC2')
  await expect(insights).toContainText('USD 18.00')
  await expect(page.locator('.provider-overview-card').filter({ hasText: 'Metered usage' }).first()).toContainText(`${date(currentStart)}–${date(currentEnd)}`)
  await expect(page.locator('.provider-overview-card').filter({ hasText: 'Metered usage' }).first()).toContainText('Last successful sync')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('connecting Hostinger automatically discovers subscriptions without pressing Sync', async ({ page }) => {
  const ledger = await mockLedger(page)
  let configured = false, syncCalls = 0
  const renewal = new Date(); renewal.setUTCDate(renewal.getUTCDate() + 10)
  const renewalDate = renewal.toISOString().slice(0, 10)
  const row = { externalId: 'host-kvm', name: 'KVM from Hostinger', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 89.99, renewalPrice: 179.99, isAutoRenewed: true, createdAt: '2025-10-08T00:00:00.000Z', expiresAt: null, nextBillingAt: `${renewalDate}T00:00:00.000Z`, linkedSubscriptionId: 'auto-host-kvm', automaticallyLinked: true, excluded: false, possibleMatches: [], seenInLatestSync: true, renewalAvailable: true, upcomingCommitment: 179.99 }
  const syncedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured, revision: configured ? 1 : 0 } } }))
  await page.route('**/api/connections/hostinger', async route => { configured = true; return route.fulfill({ json: { configured: true, revision: 1 } }) })
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: configured && syncCalls ? [row] : [], sync: configured && syncCalls ? { status: 'synced', lastAttemptAt: syncedAt, lastSyncedAt: syncedAt } : { status: 'not-configured' } } }))
  await page.route('**/api/hostinger/subscriptions/sync', async route => { syncCalls++; ledger.addSubscription({ id: 'auto-host-kvm', name: row.name, provider: 'Hostinger', billingType: 'fixed', amount: row.renewalPrice, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: renewalDate, status: 'active', revision: 1 }); return route.fulfill({ json: { subscriptions: [row], sync: { status: 'synced', lastAttemptAt: syncedAt, lastSyncedAt: syncedAt } } }) })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Hostinger', exact: true }) })
  await card.locator('summary').click()
  await card.getByLabel('API token', { exact: true }).fill('hostinger-test-token')
  await card.getByRole('button', { name: 'Save Hostinger connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  await expect(card).toContainText('Next: review eligible fixed renewals in Hostinger subscriptions below.')
  await expect(page.locator('#hostinger-discovery')).toContainText('KVM from Hostinger')
  await expect(page.locator('#subscriptions')).toContainText('KVM from Hostinger')
  await expect(page.locator('.renewal-list')).toContainText('KVM from Hostinger')
  await expect(page.locator('.provider-overview-card').filter({ has: page.getByRole('heading', { name: /Hostinger/ }) })).toContainText('USD 15.00')
  expect(syncCalls).toBe(1)
})

test('stale Hostinger commitments remain visible but are omitted from upcoming charges', async ({ page }) => {
  const renewal = new Date(); renewal.setUTCDate(renewal.getUTCDate() + 10)
  const renewalDate = renewal.toISOString().slice(0, 10)
  const subscription = { id: 'stale-hostinger', name: 'Stale VPS', provider: 'Hostinger', billingType: 'fixed', amount: 120, currency: 'USD', recurrenceInterval: 12, recurrenceUnit: 'month', nextRenewalAt: renewalDate, status: 'active', revision: 1 }
  await mockLedger(page, [subscription])
  const source = { externalId: 'stale-vps', name: 'Stale VPS', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 90, renewalPrice: 120, isAutoRenewed: true, createdAt: '2025-10-08T00:00:00.000Z', expiresAt: null, nextBillingAt: `${renewalDate}T00:00:00.000Z`, linkedSubscriptionId: subscription.id, automaticallyLinked: true, excluded: false, possibleMatches: [], providerNameCollision: false, seenInLatestSync: false, renewalAvailable: true, upcomingCommitment: 120 }
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [source], sync: { status: 'error', lastAttemptAt: new Date().toISOString(), lastSyncedAt: '2026-10-01T00:00:00Z' } } }))
  await page.goto('./')
  await expect(page.locator('.provider-overview-card').filter({ has: page.getByRole('heading', { name: /Hostinger/ }) })).toContainText('USD 10.00')
  await expect(page.locator('.provider-overview')).toContainText('omitted from upcoming-charge totals')
  await expect(page.locator('.renewals-panel')).toContainText('Nothing coming up')
})

test('Hostinger renewal discovery stays out of totals until linked or added and preserves existing values', async ({ page }) => {
  const legacy = { id: 'manual-hostinger', name: 'Existing VPS', billingType: 'fixed', amount: 25, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-12-01', status: 'active', revision: 1 }
  await mockLedger(page, [legacy])
  let linked = false, added = false
  const source = { externalId: 'provider-kvm-1', name: 'Existing VPS', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 89.99, renewalPrice: 179.99, isAutoRenewed: true, createdAt: '2025-10-08T11:54:22.000Z', expiresAt: null, nextBillingAt: '2026-10-08T11:54:22.000Z', linkedSubscriptionId: null, automaticallyLinked: false, excluded: false, possibleMatches: [{ id: legacy.id, name: legacy.name }], seenInLatestSync: true, renewalAvailable: true, upcomingCommitment: 179.99 }
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...source, linkedSubscriptionId: linked ? legacy.id : added ? 'new-entry' : null }], sync: { status: 'synced', lastSyncedAt: '2026-10-08T12:00:00Z' } } }))
  await page.route('**/api/hostinger/subscriptions/provider-kvm-1/link', async route => {
    expect(route.request().postDataJSON()).toEqual({ subscriptionId: legacy.id, revision: 1, mode: 'keep-current' }); linked = true
    return route.fulfill({ json: { ...legacy, provider: 'Hostinger', revision: 2 } })
  })
  await page.route('**/api/hostinger/subscriptions/provider-kvm-1/entry', async route => { added = true; return route.fulfill({ json: { ...legacy, id: 'new-entry', name: source.name, amount: source.renewalPrice, revision: 1 } }) })
  await page.goto('./')
  const panel = page.locator('#hostinger-discovery')
  await expect(panel.getByText('USD 179.99', { exact: true })).toBeVisible()
  await panel.getByText('Link an existing subscription').click()
  await panel.getByLabel('Subscription to link').selectOption(legacy.id)
  await panel.getByRole('button', { name: 'Link without a duplicate' }).click()
  await expect(panel.getByText('Linked subscription', { exact: true })).toBeVisible()
  await expect(panel.getByText(/Connected to Existing VPS/)).toBeVisible()
  await expect(page.locator('#subscriptions')).toContainText('USD 25.00')
  expect(linked).toBe(true)
  expect(added).toBe(false)
  await page.setViewportSize({ width: 320, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
