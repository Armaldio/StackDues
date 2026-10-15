import { expect, test, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cloudflare/registrar', route => route.fulfill({ json: { registrations: [], sync: { status: 'not-configured' } } }))
})

const widths = [320, 375, 768, 1366, 1440]
const today = new Date().toISOString().slice(0, 10)
const capturedAt = new Date().toISOString()
const periodStart = `${today.slice(0, 7)}-01`
const nextRenewalAt = `${Number(today.slice(0, 4)) + 1}-10-01`

function subscription(id: string, amount: number, currency: string, recurrenceInterval = 1, recurrenceUnit = 'month') {
  return { id, name: id, billingType: 'fixed', amount, currency, recurrenceInterval, recurrenceUnit, nextRenewalAt, status: 'active', revision: 1 }
}

test('Overview separates this month’s scheduled charges from monthly equivalents and reported usage', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [
    { ...subscription('Monthly EUR renewal', 23, 'EUR'), nextRenewalAt: today },
    { ...subscription('Annual USD renewal', 120, 'USD', 1, 'year'), nextRenewalAt: today },
  ] }))
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: false, revision: 0 }])) }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean'].map(provider => [provider, { status: 'not-configured' }])) } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  await page.goto('/')

  const month = page.locator('.current-month-schedule')
  await expect(month.getByRole('heading')).toContainText('Scheduled fixed charges left in')
  await expect(month).toContainText('EUR 23.00')
  await expect(month).toContainText('USD 120.00')
  await expect(month).not.toContainText('143.00')
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'USD' })).toContainText('USD 10.00')
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'USD' })).toContainText('Monthly comparison only')
  await expect(page.locator('.overview-currency-card').filter({ hasText: 'USD' })).not.toContainText('USD 130.00')
})

async function fixture(page: Page, state: 'mixed' | 'long' | 'manual' | 'unavailable' | 'forecast') {
  const configured = state === 'mixed' || state === 'long' || state === 'unavailable' || state === 'forecast'
  const subscriptions = state === 'long'
    ? [subscription('Long manual service description with a yearly commitment', 9876543.21, 'USD')]
    : state === 'manual'
      ? [subscription('Manual-only service', 23, 'EUR')]
      : [subscription('ChatGPT Plus', 23, 'EUR'), subscription('Hostinger fixed commitment', 359.76, 'EUR', 2, 'year'), subscription('Bitwarden', 17.82, 'USD', 1, 'year')]
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: subscriptions }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  const usageProvider = state === 'forecast' ? 'aws' : 'cloudflare'
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: provider === usageProvider && configured, revision: provider === usageProvider && configured ? 1 : 0 }])) }))
  await page.route('**/api/costs', route => route.fulfill({ json: {
    snapshots: state === 'mixed' || state === 'long' || state === 'forecast' ? [{ id: 'cf-actual', provider: usageProvider, periodStart, periodEnd: today, amount: state === 'long' ? 8765432.1 : 12.8, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } }, ...(state === 'forecast' ? [{ id: 'aws-forecast', provider: 'aws', periodStart, periodEnd: today, amount: 30, currency: 'USD', kind: 'forecast', capturedAt, metadata: { period: 'current' } }] : [])] : [],
    providers: { aws: state === 'forecast' ? { status: 'synced', lastSyncedAt: capturedAt } : { status: 'not-configured' }, cloudflare: { status: state === 'unavailable' ? 'error' : configured && state !== 'forecast' ? 'synced' : 'not-configured', ...(configured && state !== 'unavailable' ? { lastSyncedAt: capturedAt } : {}) } },
  } }))
}

for (const width of widths) {
  for (const state of ['mixed', 'long', 'manual', 'unavailable', 'forecast'] as const) {
    test(`Overview ${state} amounts remain readable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await fixture(page, state)
      await page.goto('/')
      const overview = page.locator('.overview-snapshot')
      await expect(overview.locator('.overview-currency-card').first()).toBeVisible()
      if (state === 'mixed') {
        const eur = overview.locator('.overview-currency-card').filter({ has: page.locator('.overview-currency', { hasText: 'EUR' }) })
        const usd = overview.locator('.overview-currency-card').filter({ has: page.locator('.overview-currency', { hasText: 'USD' }) })
        await expect(eur).toContainText('EUR 37.99')
        await expect(usd).toContainText('USD 1.49')
        await expect(usd).toContainText('USD 12.80')
        await expect(usd).toContainText(`Source and period · Cloudflare · ${periodStart}–${today}`)
        await expect(usd).not.toContainText(/USD 14.29|paid|charged this month/i)
      }
      if (state === 'forecast') await expect(overview.locator('.overview-forecast')).toContainText('USD 30.00')
      if (state === 'manual') { await expect(overview).not.toContainText('Cloud usage reported'); await expect(overview.locator('.overview-currency-card').first()).toContainText('EUR 23.00') }
      if (process.env.STACKDUES_SCREENSHOT_DIR && state === 'mixed') {
        await page.screenshot({ path: `${process.env.STACKDUES_SCREENSHOT_DIR}/${process.env.STACKDUES_SCREENSHOT_PHASE ?? 'after'}-overview-${width}.png`, fullPage: true })
      }
      // Measure rendered text, not just element overflow: a narrow, tall dd can
      // fit its parent while breaking an amount into a column of single glyphs.
      const amounts = await overview.locator('.overview-spend-pair dd, .overview-forecast dd').evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect()
        const card = element.closest('.overview-currency-card')!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(element)
        const text = Array.from(range.getClientRects()).filter(rect => rect.width > 0)
        const style = getComputedStyle(element)
        const siblings = Array.from(element.parentElement!.children).filter(sibling => sibling !== element).map(sibling => sibling.getBoundingClientRect())
        return { value: element.textContent, width: bounds.width, fontSize: parseFloat(style.fontSize), lines: new Set(text.map(rect => rect.y)).size,
          textFits: text.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.left >= card.left && rect.right <= card.right),
          overlaps: text.some(rect => siblings.some(sibling => rect.left < sibling.right && rect.right > sibling.left && rect.top < sibling.bottom && rect.bottom > sibling.top)) }
      }))
      if (process.env.STACKDUES_SCREENSHOT_DIR && state === 'mixed') await writeFile(`${process.env.STACKDUES_SCREENSHOT_DIR}/${process.env.STACKDUES_SCREENSHOT_PHASE ?? 'after'}-overview-${width}-bounds.json`, JSON.stringify(amounts, null, 2))
      await test.info().attach('rendered-amounts', { body: JSON.stringify(amounts, null, 2), contentType: 'application/json' })
      for (const amount of amounts) {
        expect(amount.width, `${amount.value} needs a full row`).toBeGreaterThan(100)
        expect(amount.fontSize).toBeGreaterThanOrEqual(17)
        expect(amount.lines, `${amount.value} must stay on one line`).toBe(1)
        expect(amount.textFits, `${amount.value} must not clip`).toBe(true)
        expect(amount.overlaps, `${amount.value} must not overlap its explanation`).toBe(false)
      }
      const notes = await overview.locator('.overview-spend-pair small').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).fontSize)))
      expect(notes.every(size => size >= 12)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
}
