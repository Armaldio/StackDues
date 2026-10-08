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
}

async function add(page: Page, name: string, amount: string, interval: string, unit: string, currency = 'USD') {
  await page.getByRole('button', { name: 'Add subscription', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Amount per charge').fill(amount)
  await form.getByLabel('Repeats every').fill(interval)
  await form.getByLabel('Time unit', { exact: true }).selectOption(unit)
  await form.getByLabel('Currency', { exact: true }).fill(currency)
  await form.getByRole('button', { name: 'Save subscription', exact: true }).click()
  await expect(form).not.toBeVisible()
}

test('fresh ledger supports real recurrence, edits, status changes, deletion, and reload persistence', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await mockLedger(page)
  await page.goto('./')
  await expect(page.getByText('Start with what you pay.')).toBeVisible()
  await add(page, 'Bitwarden', '10', '1', 'year')
  await add(page, 'Hostinger', '192', '4', 'year')
  await add(page, 'VPS', '12', '1', 'month')
  await expect(page.locator('.monthly-value')).toHaveText('USD 16.83/ mo')
  await expect(page.locator('.metric').first()).toContainText('USD 202.00')
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: 'Hostinger' })).toContainText('Every 4 years')
  await page.getByRole('button', { name: 'Pause VPS in ledger', exact: true }).click()
  await expect(page.locator('.monthly-value')).toHaveText('USD 4.83/ mo')
  await page.getByRole('button', { name: 'Resume VPS in ledger', exact: true }).click()
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
  await page.getByRole('button', { name: 'Add subscription', exact: true }).click()
  await expect(page.getByRole('dialog').getByLabel('Name', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(errors).toEqual([])
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
  await page.route('**/api/costs/refresh*', route => { expect(route.request().method()).toBe('POST'); refreshCalls++; return route.fulfill({ status: 204 }) })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Amazon Web Services', exact: true }) })
  await expect(card.getByText('Not configured', { exact: true })).toBeVisible()
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
  await expect(card.getByText('Not configured', { exact: true })).toBeVisible()
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
  await page.route('**/api/costs/refresh*', async route => { expect(new URL(route.request().url()).searchParams.get('provider')).toBe('aws'); synced = true; return route.fulfill({ status: 204 }) })
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

test('connecting Cloudflare shows metered spend in Overview without another refresh action', async ({ page }) => {
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
    { id: 'cf-forecast', provider: 'cloudflare', periodStart: start, periodEnd: endDate, amount: 20, currency: 'USD', kind: 'forecast', capturedAt, metadata: { period: 'current' } },
  ] : [], providers: { aws: { status: 'not-configured' }, cloudflare: synced ? { status: 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt } : { status: 'not-configured' } } } }))
  await page.route('**/api/costs/refresh*', async route => {
    expect(new URL(route.request().url()).searchParams.get('provider')).toBe('cloudflare')
    syncCalls++; synced = true
    return route.fulfill({ status: 204 })
  })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Cloudflare', exact: true }) })
  await card.locator('summary').click()
  await card.getByLabel('Account ID', { exact: true }).fill('test-account')
  await card.getByLabel('API token', { exact: true }).fill('test-token')
  await card.getByRole('button', { name: 'Save Cloudflare connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  const overview = page.locator('.tracked-spending-card')
  await expect(overview).toContainText('USD 40.00')
  await expect(overview).toContainText('USD 8.00')
  await expect(overview).toContainText('USD 20.00')
  await expect(overview).toContainText('USD 60.00')
  await expect(page.locator('#infrastructure .provider-cost strong').first()).toHaveText('$8.00')
  await expect(page.locator('#history')).toContainText('Cloudflare')
  expect(syncCalls).toBe(1)
})

test('connecting Hostinger automatically discovers subscriptions without pressing Sync', async ({ page }) => {
  await mockLedger(page)
  let configured = false, syncCalls = 0
  const row = { externalId: 'host-kvm', name: 'KVM from Hostinger', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 89.99, renewalPrice: 179.99, isAutoRenewed: true, createdAt: '2025-10-08T00:00:00.000Z', expiresAt: null, nextBillingAt: '2026-11-08T00:00:00.000Z', linkedSubscriptionId: null, seenInLatestSync: true, renewalAvailable: true, upcomingCommitment: 179.99 }
  const syncedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured, revision: configured ? 1 : 0 } } }))
  await page.route('**/api/connections/hostinger', async route => { configured = true; return route.fulfill({ json: { configured: true, revision: 1 } }) })
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: configured && syncCalls ? [row] : [], sync: configured && syncCalls ? { status: 'synced', lastAttemptAt: syncedAt, lastSyncedAt: syncedAt } : { status: 'not-configured' } } }))
  await page.route('**/api/hostinger/subscriptions/sync', async route => { syncCalls++; return route.fulfill({ json: { subscriptions: [row], sync: { status: 'synced', lastAttemptAt: syncedAt, lastSyncedAt: syncedAt } } }) })
  await page.goto('./')
  const card = page.locator('.connection-card').filter({ has: page.getByRole('heading', { name: 'Hostinger', exact: true }) })
  await card.locator('summary').click()
  await card.getByLabel('API token', { exact: true }).fill('hostinger-test-token')
  await card.getByRole('button', { name: 'Save Hostinger connection' }).click()
  await expect(card.getByText('Synced', { exact: true })).toBeVisible()
  await expect(page.locator('#hostinger-discovery')).toContainText('KVM from Hostinger')
  expect(syncCalls).toBe(1)
})

test('Hostinger renewal discovery stays out of totals until linked or added and preserves existing values', async ({ page }) => {
  const legacy = { id: 'manual-hostinger', name: 'Existing VPS', billingType: 'fixed', amount: 25, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-12-01', status: 'active', revision: 1 }
  await mockLedger(page, [legacy])
  let linked = false, added = false
  const source = { externalId: 'provider-kvm-1', name: 'Existing VPS', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'USD', totalPrice: 89.99, renewalPrice: 179.99, isAutoRenewed: true, createdAt: '2025-10-08T11:54:22.000Z', expiresAt: null, nextBillingAt: '2026-10-08T11:54:22.000Z', linkedSubscriptionId: null, seenInLatestSync: true, renewalAvailable: true, upcomingCommitment: 179.99 }
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...source, linkedSubscriptionId: linked ? legacy.id : added ? 'new-entry' : null }], sync: { status: 'synced', lastSyncedAt: '2026-10-08T12:00:00Z' } } }))
  await page.route('**/api/hostinger/subscriptions/provider-kvm-1/link', async route => {
    expect(route.request().postDataJSON()).toEqual({ subscriptionId: legacy.id, revision: 1, mode: 'keep-current' }); linked = true
    return route.fulfill({ json: { ...legacy, provider: 'Hostinger', revision: 2 } })
  })
  await page.route('**/api/hostinger/subscriptions/provider-kvm-1/entry', async route => { added = true; return route.fulfill({ json: { ...legacy, id: 'new-entry', name: source.name, amount: source.renewalPrice, revision: 1 } }) })
  await page.goto('./')
  const panel = page.locator('#hostinger-discovery')
  await expect(panel.getByText('USD 179.99', { exact: true })).toBeVisible()
  await panel.getByText('Link an existing entry').click()
  await panel.getByLabel('Ledger entry').selectOption(legacy.id)
  await panel.getByRole('button', { name: 'Link without a duplicate' }).click()
  await expect(panel.getByText('Linked to ledger', { exact: true })).toBeVisible()
  await expect(panel.getByText(/Connected to Existing VPS/)).toBeVisible()
  await expect(page.locator('#subscriptions')).toContainText('USD 25.00')
  expect(linked).toBe(true)
  expect(added).toBe(false)
  await page.setViewportSize({ width: 320, height: 1000 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
