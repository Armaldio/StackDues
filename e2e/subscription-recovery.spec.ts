import { expect, test, type Page, type Route } from '@playwright/test'

type Row = { id: string; name: string; provider?: string; billingType: 'fixed'; amount: number; currency: string; recurrenceInterval: number; recurrenceUnit: string; nextRenewalAt: string; status: string; revision: number }
const today = new Date().toISOString().slice(0, 10)
const row: Row = { id: 'subscription-1', name: 'Password Vault', billingType: 'fixed', amount: 12, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: today, status: 'active', revision: 1 }

async function routeNonLedger(page: Page) {
  await page.route('**/api/costs', route => route.fulfill({ json: { snapshots: [], providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'not-configured' } } } }))
  await page.route('**/api/connections', route => route.fulfill({ json: Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: false, revision: 0 }])) }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
}

async function openEdit(page: Page, width = 1440, routeLedger?: (route: Route) => Promise<void>) {
  await page.setViewportSize({ width, height: 900 })
  await routeNonLedger(page)
  if (routeLedger) await page.route('**/api/subscriptions**', routeLedger)
  await page.goto('/services')
  await expect(page.getByRole('button', { name: 'Edit Password Vault' })).toBeVisible()
  const trigger = page.getByRole('button', { name: 'Edit Password Vault' })
  await trigger.click()
  const form = page.getByRole('dialog')
  await expect(form.getByLabel('Name', { exact: true })).toBeFocused()
  return { form, trigger }
}

test('409 reloads the latest revision in-dialog, preserves the draft, and requires review before overwrite', async ({ page }) => {
  let latest = { ...row }
  let patchCalls = 0
  const routeLedger = async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (request.method() === 'GET') return route.fulfill({ json: [latest] })
    if (request.method() === 'PATCH') {
      patchCalls++
      const body = request.postDataJSON()
      if (patchCalls === 1) {
        latest = { ...latest, amount: 24, revision: 2 }
        return route.fulfill({ status: 409, json: { error: 'revision conflict' } })
      }
      expect(body.revision).toBe(2)
      expect(body.subscription.amount).toBe(35)
      latest = { ...body.subscription, revision: 3 }
      return route.fulfill({ json: latest })
    }
    throw new Error(`Unexpected ${request.method()} ${path}`)
  }
  const { form, trigger } = await openEdit(page, 320, routeLedger)
  await form.getByLabel('Amount per charge').fill('35')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('alert')).toContainText('changed on another device')
  await expect(form.getByRole('button', { name: 'Save subscription' })).toBeDisabled()
  await form.getByRole('button', { name: 'Reload latest and review' }).click()
  await expect(form.getByRole('heading', { name: 'Latest saved version · revision 2' })).toBeVisible()
  await expect(form.getByLabel('Amount per charge')).toHaveValue('35')
  await expect(form.getByRole('list')).toContainText('latest “24”; your draft “35”')
  await expect(form.getByRole('button', { name: 'Save subscription' })).toBeDisabled()
  await form.getByRole('button', { name: 'I reviewed this; save my draft on the latest version' }).click()
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form).not.toBeVisible()
  await expect(trigger).toBeFocused()
  expect(patchCalls).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('401 keeps the same dialog draft available while signing in in another tab', async ({ page }) => {
  let records: Row[] = []
  let postCalls = 0
  await page.setViewportSize({ width: 375, height: 900 })
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: records })
    if (request.method() === 'POST') {
      postCalls++
      if (postCalls === 1) return route.fulfill({ status: 401, json: { error: 'Unauthorized' } })
      const body = request.postDataJSON()
      records = [{ ...body, revision: 1 }]
      return route.fulfill({ json: records[0] })
    }
    throw new Error(`Unexpected ${request.method()}`)
  })
  await page.context().route('**/login', route => route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' }))
  await page.goto('/services')
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('Kept draft')
  await form.getByLabel('Amount per charge').fill('19.5')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('alert')).toContainText('session expired')
  await expect(form.getByRole('button', { name: 'Save subscription' })).toBeDisabled()
  const authPagePromise = page.context().waitForEvent('page')
  await form.getByRole('link', { name: 'Sign in in a new tab' }).click()
  const authPage = await authPagePromise
  await expect(authPage.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await authPage.close()
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Kept draft')
  await form.getByRole('button', { name: 'Check save status' }).click()
  await expect(form.getByRole('status')).toContainText('No saved copy was found')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form).not.toBeVisible()
  expect(postCalls).toBe(2)
})

test('ambiguous 503 checks the stable draft ID before retry and recognizes the saved record', async ({ page }) => {
  let records: Row[] = []
  let postCalls = 0
  await page.setViewportSize({ width: 1440, height: 900 })
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: records })
    if (request.method() === 'POST') {
      postCalls++
      records = [{ ...request.postDataJSON(), revision: 1 }]
      return route.fulfill({ status: 503, json: { error: 'temporary storage failure' } })
    }
    throw new Error(`Unexpected ${request.method()}`)
  })
  await page.goto('/services')
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('Maybe saved')
  await form.getByLabel('Amount per charge').fill('7.25')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('alert')).toContainText('could not be confirmed')
  await form.getByRole('button', { name: 'Check save status' }).click()
  await expect(form).not.toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'Maybe saved' })).toBeVisible()
  expect(postCalls).toBe(1)
})

test('invalid edited fields do not block draft copy or the save-status check', async ({ page }) => {
  let records: Row[] = []
  let postCalls = 0
  await page.setViewportSize({ width: 320, height: 900 })
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: records })
    if (request.method() === 'POST') {
      postCalls++
      return route.fulfill({ status: 503, json: { error: 'temporary storage failure' } })
    }
    throw new Error(`Unexpected ${request.method()}`)
  })
  await page.goto('/services')
  const trigger = page.getByRole('button', { name: 'Add manually', exact: true }).first()
  await trigger.click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('Draft with unfinished amount')
  await form.getByLabel('Amount per charge').fill('7.25')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('alert')).toBeVisible()
  await form.getByLabel('Amount per charge').fill('')
  await form.getByRole('button', { name: 'Copy draft' }).click()
  await expect(form.getByRole('button', { name: /Draft copied|Copy draft/ })).toBeVisible()
  await form.getByRole('button', { name: 'Check save status' }).click()
  await expect(form.getByRole('status')).toContainText('No saved copy was found')
  await expect(form.getByLabel('Amount per charge')).toHaveValue('')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByLabel('Amount per charge')).toBeFocused()
  expect(postCalls).toBe(1)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})

test('503 with no saved copy enables a verified retry using the same record ID', async ({ page }) => {
  let records: Row[] = []
  const submittedIds: string[] = []
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: records })
    if (request.method() === 'POST') {
      const body = request.postDataJSON()
      submittedIds.push(body.id)
      if (submittedIds.length === 1) return route.fulfill({ status: 503, json: { error: 'temporary storage failure' } })
      records = [{ ...body, revision: 1 }]
      return route.fulfill({ json: records[0] })
    }
    throw new Error(`Unexpected ${request.method()}`)
  })
  await page.goto('/services')
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('Safe retry')
  await form.getByLabel('Amount per charge').fill('6.5')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await form.getByRole('button', { name: 'Check save status' }).click()
  await expect(form.getByRole('status')).toContainText('No saved copy was found')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form).not.toBeVisible()
  expect(submittedIds).toHaveLength(2)
  expect(submittedIds[1]).toBe(submittedIds[0])
  expect(records).toHaveLength(1)
})

test('the dialog stays open while a save is in flight so a later failure cannot lose the draft', async ({ page }) => {
  let releasePost!: () => void
  const postPending = new Promise<void>(resolve => { releasePost = resolve })
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: [] })
    await postPending
    return route.fulfill({ status: 503, json: { error: 'temporary storage failure' } })
  })
  await page.goto('/services')
  await page.getByRole('button', { name: 'Add manually', exact: true }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('Pending draft')
  await form.getByLabel('Amount per charge').fill('9')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('button', { name: 'Saving…' })).toBeDisabled()
  await expect(form.getByRole('button', { name: 'Close subscription form' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(form).toBeVisible()
  releasePost()
  await expect(form.getByRole('alert')).toContainText('could not be confirmed')
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('Pending draft')
})

test('Escape closes a recovered save error and returns focus to the trigger', async ({ page }) => {
  const routeLedger = async (route: Route) => route.request().method() === 'GET'
    ? route.fulfill({ json: [row] })
    : route.fulfill({ status: 503, json: { error: 'unavailable' } })
  const { form, trigger } = await openEdit(page, 1440, routeLedger)
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await expect(form.getByRole('alert')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(form).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test('a late save-status response cannot close or overwrite a newly opened draft', async ({ page }) => {
  let saved: Row | undefined
  let checking = false
  let releaseCheck!: () => void
  const pendingCheck = new Promise<void>(resolve => { releaseCheck = resolve })
  await routeNonLedger(page)
  await page.route('**/api/subscriptions**', async route => {
    if (route.request().method() === 'POST') {
      saved = { ...route.request().postDataJSON(), revision: 1 }
      return route.fulfill({ status: 503, json: { error: 'response uncertain' } })
    }
    if (saved) { checking = true; await pendingCheck }
    return route.fulfill({ json: saved ? [saved] : [] })
  })
  await page.goto('/services')
  const add = page.getByRole('button', { name: 'Add manually', exact: true }).first()
  await add.click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Name', { exact: true }).fill('First draft')
  await form.getByLabel('Amount per charge').fill('9')
  await form.getByRole('button', { name: 'Save subscription' }).click()
  await form.getByRole('button', { name: 'Check save status' }).click()
  await expect.poll(() => checking).toBe(true)
  await form.getByRole('button', { name: 'Close subscription form' }).click()
  await add.click()
  await form.getByLabel('Name', { exact: true }).fill('New draft stays here')
  const response = page.waitForResponse(response => response.url().includes('/api/subscriptions') && response.request().method() === 'GET')
  releaseCheck()
  await (await response).finished()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await expect(form.getByLabel('Name', { exact: true })).toHaveValue('New draft stays here')
  await expect(form.getByRole('button', { name: 'Save subscription' })).toBeEnabled()
})
