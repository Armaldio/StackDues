import { expect, test, type Page } from '@playwright/test'

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
  await page.route('**/data/costs.json', route => route.fulfill(fail ? { status: 503, body: 'offline' } : { json: feed }))
  await page.goto('./')
  const infrastructure = page.locator('#infrastructure')
  await expect(infrastructure.getByText('EC2', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText('R2 Storage', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText('Sync failed', { exact: true })).toBeVisible()
  await expect(infrastructure.getByText(/Forecast covers only some providers/)).toBeVisible()
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
