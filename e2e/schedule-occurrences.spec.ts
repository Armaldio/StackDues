import { expect, test, type Page } from '@playwright/test'

async function scheduleFixture(page: Page, empty = false) {
  const today = new Date().toISOString().slice(0, 10)
  const capturedAt = new Date().toISOString()
  const subscriptions = [
    { id: 'monthly-a', name: 'Monthly A', amount: 10, currency: 'USD', recurrenceUnit: 'month' },
    { id: 'monthly-b', name: 'Monthly B', amount: 20, currency: 'USD', recurrenceUnit: 'month' },
    { id: 'annual-eur', name: 'Annual EUR', amount: 30, currency: 'EUR', recurrenceUnit: 'year' },
    { id: 'annual-usd', name: 'Annual USD', amount: 40, currency: 'USD', recurrenceUnit: 'year' },
    { id: 'hostinger-linked', name: 'Hostinger annual', provider: 'Hostinger', amount: 50, currency: 'EUR', recurrenceUnit: 'year' },
  ].map(row => ({ ...row, billingType: 'fixed', recurrenceInterval: 1, nextRenewalAt: today, status: 'active', revision: 1 }))
  const hostinger = { externalId: 'host-annual', name: 'Hostinger annual', status: 'active', recurrenceInterval: 12, recurrenceUnit: 'month', currency: 'EUR', totalPrice: 50, renewalPrice: 50, isAutoRenewed: true, createdAt: '2025-01-01T00:00:00.000Z', expiresAt: null, nextBillingAt: `${today}T00:00:00.000Z`, linkedSubscriptionId: 'hostinger-linked', automaticallyLinked: true, excluded: false, possibleMatches: [], providerNameCollision: false, seenInLatestSync: true, renewalAvailable: true, upcomingCommitment: 50 }
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: empty ? [] : subscriptions }))
  await page.route('**/api/connections', route => route.fulfill({ json: { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 }, digitalocean: { configured: false, revision: 0 }, hostinger: { configured: !empty, revision: empty ? 0 : 1 } } }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: empty ? [] : [hostinger], sync: { status: empty ? 'not-configured' : 'synced', lastAttemptAt: capturedAt, lastSyncedAt: capturedAt } } }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } } } }))
  await page.goto('/history')
}

for (const width of [320, 375, 768, 1366, 1440]) {
  test(`all 27 and 81 counted occurrences can be browsed and reconcile at ${width}px`, async ({ page }) => {
    test.setTimeout(180_000)
    await page.setViewportSize({ width, height: 900 })
    await scheduleFixture(page)
    const timeline = page.locator('#timeline')
    const schedule = timeline.locator('.timeline-lane').first()
    const details = page.locator('#scheduled-occurrences')
    for (const [horizon, count, usd, eur, years] of [['12 months', 27, 400, 80, 1], ['3 years', 81, 1200, 240, 3]] as const) {
      await schedule.getByRole('button', { name: horizon, exact: true }).click()
      await expect(schedule.locator('.renewal-timeline-list li')).toHaveCount(5)
      await expect(schedule.locator('.schedule-total')).toContainText(`USD ${usd.toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
      await expect(schedule.locator('.schedule-total')).toContainText(`EUR ${eur.toFixed(2)}`)
      const browse = timeline.getByRole('link', { name: `Browse all ${count} occurrences`, exact: true })
      await browse.focus()
      await page.keyboard.press('Enter')
      await expect(details).toHaveAttribute('open', '')
      await expect(details.getByRole('heading')).toBeFocused()
      const entries: { date: string; service: string; amount: string }[] = []
      while (true) {
        entries.push(...await details.locator('.occurrence-list li').evaluateAll(rows => rows.map(row => ({ date: row.querySelector('time')!.getAttribute('datetime')!, service: row.querySelector('button strong')!.textContent!, amount: row.querySelector('.amount')!.textContent! }))))
        const next = details.getByRole('button', { name: 'Next occurrences' })
        if (await next.isDisabled()) break
        await next.focus()
        await page.keyboard.press('Enter')
        await expect(details.getByRole('heading')).toBeFocused()
      }
      expect(entries).toHaveLength(count)
      expect(new Set(entries.map(row => `${row.date}/${row.service}`)).size).toBe(count)
      expect(entries.filter(row => row.service === 'Monthly A')).toHaveLength(12 * years)
      expect(entries.filter(row => row.service === 'Hostinger annual')).toHaveLength(years)
      const totals = { USD: 0, EUR: 0 }
      for (const row of entries) {
        const [currency, amount] = row.amount.split(/\s+/)
        totals[currency as keyof typeof totals] += Number(amount!.replaceAll(',', ''))
      }
      expect(totals).toEqual({ USD: usd, EUR: eur })
      expect(entries.map(row => row.date)).toEqual(entries.map(row => row.date).sort())
      await expect(details.getByRole('status')).toContainText(`of ${count} occurrences`)
      await expect(details.getByRole('button', { name: 'Next occurrences' })).toBeDisabled()
      await details.getByRole('button', { name: 'Previous occurrences' }).focus()
      await page.keyboard.press('Enter')
      await expect(details.getByRole('status')).toContainText(`Page ${Math.ceil(count / 10) - 1}`)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    }
    // Changing a filter while on a later page starts at the first matching occurrence.
    await timeline.locator('.timeline-filters select').nth(2).selectOption('EUR')
    await expect(details.getByRole('status')).toContainText('Showing 1–6 of 6 occurrences · Page 1 of 1')
    await expect(details.locator('.occurrence-list li')).toHaveCount(6)
    await expect(details.getByRole('navigation')).toHaveCount(0)
    await expect(schedule).toContainText('Scheduled charges are not confirmed payments')
    await schedule.screenshot({ path: test.info().outputPath(`schedule-${width}.png`) })
  })
}

test('empty schedule explains no occurrences and does not expose pagination', async ({ page }) => {
  await scheduleFixture(page, true)
  const schedule = page.locator('#timeline .timeline-lane').first()
  await expect(schedule.getByRole('status')).toContainText('No active renewal is scheduled')
  await expect(page.locator('#scheduled-occurrences')).toHaveCount(0)
  await expect(schedule.getByRole('navigation')).toHaveCount(0)
})
