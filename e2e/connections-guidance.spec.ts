import { expect, test, type Page } from '@playwright/test'

async function mockProviders(page: Page) {
  const providers = ['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger']
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(providers.map(provider => [provider, { configured: false, revision: 0 }])) }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean'].map(provider => [provider, { status: 'not-configured' }])) } }))
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [] }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
}

test('DUES-32 provider credential guidance is actionable and fits common viewport widths', async ({ page }) => {
  await mockProviders(page)
  await page.setViewportSize({ width: 1366, height: 900 })
  await page.goto('/connections')

  const cards = page.locator('.connection-card:not(.coming-soon-card)')
  await expect(cards).toHaveCount(5)
  const guidance = [
    ['Amazon Web Services', 'dedicated IAM principal', 'ce:GetCostAndUsage', 'Cost Explorer API permissions', 'https://docs.aws.amazon.com/cost-management/latest/userguide/ce-api.html'],
    ['Cloudflare', 'Account → Billing → Read', 'billing permissions', 'https://developers.cloudflare.com/billing/understand/billing-permissions/'],
    ['OpenAI API', 'organization Admin API key', 'OpenAI organization costs API', 'https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs'],
    ['DigitalOcean', 'billing:read', 'finalized monthly invoices', 'DigitalOcean billing API and scopes', 'https://docs.digitalocean.com/platform/billing/reference/api/'],
    ['Hostinger', 'inherit their owner’s permissions', 'Manage Hostinger renewals', 'Hostinger API reference', 'https://developers.hostinger.com/'],
  ]
  for (const [name, ...rest] of guidance) {
    const docHref = rest.pop()!
    const phrases = rest
    const card = cards.filter({ has: page.getByRole('heading', { name, exact: true }) })
    await expect(card).toHaveCount(1)
    for (const phrase of phrases) await expect(card).toContainText(phrase)
    await expect(card.locator('.connection-guidance a').first()).toHaveAttribute('href', docHref)
    const editor = card.locator('details.connection-editor')
    await expect(editor).not.toHaveAttribute('open', '')
    await expect(editor.getByRole('textbox')).toHaveCount(0)
    await editor.locator('summary').click()
    await expect(editor).toHaveAttribute('open', '')
    await expect(editor.locator('input[type="password"]')).toHaveCount(name === 'Amazon Web Services' ? 3 : name === 'Cloudflare' ? 2 : 1)
    await editor.locator('summary').click()
    await expect(editor).not.toHaveAttribute('open', '')
  }

  for (const width of [320, 375, 768, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.connection-guidance').first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('heading', { name: 'Amazon Web Services' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Hostinger', exact: true })).toBeVisible()
  }

  const hostinger = cards.filter({ has: page.getByRole('heading', { name: 'Hostinger', exact: true }) })
  await expect(hostinger.getByRole('link', { name: 'Manage Hostinger renewals' })).toHaveAttribute('href', '/services#hostinger-discovery')
  await hostinger.getByRole('link', { name: 'Manage Hostinger renewals' }).click()
  await expect(page).toHaveURL(/\/services#hostinger-discovery$/)
  await expect(page.locator('#hostinger-discovery')).toBeVisible()
})

test('DUES-32 provider catalog search and availability filters remain accurate', async ({ page }) => {
  await mockProviders(page)
  await page.goto('/connections')
  await expect(page.locator('.connection-card:not(.coming-soon-card)')).toHaveCount(5)
  await page.getByLabel('Search providers').fill('billing:read')
  await expect(page.locator('.connection-card:not(.coming-soon-card)')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'DigitalOcean' })).toBeVisible()
  await page.getByLabel('Search providers').fill('')
  await page.getByLabel('Provider availability').selectOption('coming-soon')
  await expect(page.getByRole('heading', { name: 'GitHub' })).toBeVisible()
  await expect(page.locator('.connection-card:not(.coming-soon-card)')).toHaveCount(0)
})
