import { expect, test, type Page } from '@playwright/test'

async function scheduleFixture(page: Page) {
  const today = new Date().toISOString().slice(0, 10)
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [
    { id: 'navigation-renewal', name: 'Navigation test plan', billingType: 'fixed', amount: 12, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 },
  ] }))
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 }, digitalocean: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 } } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } } } }))
}

test('Overview and Services schedule links focus the real payment schedule at every viewport', async ({ page }) => {
  test.setTimeout(180_000)
  await scheduleFixture(page)
  const sizes = [320, 375, 768, 1366, 1440]
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 850 })
    if (width === 375) {
      await page.goto('/history')
      const heading = page.getByRole('heading', { name: 'Payment schedule', exact: true })
      await expect(heading).toBeInViewport({ ratio: 0.1 })
      const positions = await page.evaluate(() => ({ schedule: document.querySelector('#payment-schedule')!.getBoundingClientRect().top, filters: document.querySelector('.timeline-filters')!.getBoundingClientRect().top }))
      expect(positions.schedule).toBeLessThan(positions.filters)
    }
    for (const source of [
      { path: '/', linkName: 'Full payment schedule' },
      { path: '/services', linkName: 'Payment schedule' },
    ]) {
      await page.goto(source.path)
      const link = page.getByRole('link', { name: source.linkName, exact: true })
      await expect(link).toHaveAttribute('href', '/history#payment-schedule')
      await link.focus()
      await page.keyboard.press('Enter')

      await expect(page).toHaveURL(/\/history#payment-schedule$/)
      const heading = page.getByRole('heading', { name: 'Payment schedule', exact: true })
      await expect(heading).toBeVisible()
      await expect(heading).toBeFocused()
      const firstEvent = page.locator('#payment-schedule .renewal-timeline-list li').first()
      await expect(firstEvent).toContainText('Navigation test plan')
      await expect(firstEvent).toBeInViewport({ ratio: 0.1 })
      const headingBox = await heading.boundingBox()
      expect(headingBox).not.toBeNull()
      expect(headingBox!.y).toBeGreaterThanOrEqual(0)
      expect(headingBox!.y).toBeLessThan(180)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
  }

  await page.goto('/history#timeline')
  await expect(page).toHaveURL(/\/history#timeline$/)
  await expect(page.locator('#timeline')).toBeVisible()
  await expect(page.locator('#payment-schedule')).toBeVisible()
})
