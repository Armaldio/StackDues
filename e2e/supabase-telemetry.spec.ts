import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/cloudflare/registrar', route => route.fulfill({ json: { registrations: [], sync: { status: 'not-configured' } } }))
})

const observation = {
  id: 'supabase-usage-1', organizationSlug: 'team-stackdues', projectRef: 'abcdefghijklmnopqrst', projectName: 'Main app', interval: '1day',
  observedAt: '2026-10-12T00:00:00.000Z', capturedAt: '2026-10-13T12:00:00.000Z',
  authRequests: 1234, realtimeRequests: 56, restRequests: 7890, storageRequests: 12,
}
const status = { configured: true, revision: 1, updatedAt: '2026-10-13T12:00:00.000Z' }

async function mockOtherProviders(page: Page) {
  const providers = ['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger']
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(providers.map(provider => [provider, { configured: false, revision: 0 }])) }))
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean'].map(provider => [provider, { status: 'not-configured' }])) } }))
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: [] }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
}

test('Supabase connects with a scoped PAT and keeps request counts separate from financial totals', async ({ page }) => {
  await mockOtherProviders(page)
  let savedCredentials: unknown
  await page.route('**/api/supabase/connection', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { credentials: unknown; revision: number }
      savedCredentials = body.credentials
      return route.fulfill({ json: status })
    }
    return route.fulfill({ json: { configured: false, revision: 0 } })
  })
  await page.route('**/api/supabase/usage', route => route.fulfill({ json: { configured: false, status: { configured: false, revision: 0 }, observations: [] } }))
  await page.route('**/api/supabase/usage/refresh', route => route.fulfill({ json: { configured: true, status, observations: [observation] } }))
  await page.goto('/connections')

  const supabase = page.locator('.supabase-telemetry-card')
  await expect(supabase).toContainText('Telemetry only; no billable amounts')
  await expect(supabase).toContainText('Invoices: Not imported')
  await supabase.getByLabel('Organization slug').fill('team-stackdues')
  await supabase.getByLabel('Scoped personal access token').fill('TEST_SUPABASE_SCOPED_PAT')
  await supabase.getByRole('button', { name: 'Connect Supabase' }).click()

  await expect(supabase).toContainText('Connected')
  await expect(supabase).toContainText('Main app')
  await expect(supabase).toContainText('1,234')
  await expect(supabase).toContainText('7,890')
  await expect(supabase.getByLabel('Request counts only; no billing amounts')).toBeVisible()
  await expect(supabase).not.toContainText('EUR')
  await expect(supabase).not.toContainText('USD')
  await expect(supabase.locator('input[type="password"]')).toHaveCount(0)
  expect(savedCredentials).toEqual({ apiToken: 'TEST_SUPABASE_SCOPED_PAT', organizationSlug: 'team-stackdues' })
})
