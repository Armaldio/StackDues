import { expect, test, type Page } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'

const routes = [
  { path: '/', name: 'overview' },
  { path: '/services', name: 'services' },
  { path: '/connections', name: 'connections' },
  { path: '/history', name: 'history' },
] as const
const widths = [320, 375, 768, 1366, 1440]
const today = new Date().toISOString().slice(0, 10)
const capturedAt = new Date().toISOString()
const periodStart = `${today.slice(0, 7)}-01`
const nextRenewalAt = `${Number(today.slice(0, 4)) + 1}-10-01`
const phase = process.env.DUES31_EVIDENCE_PHASE ?? 'after'

const subscriptions = [
  { id: 'svc-long', name: 'A Very Long Provider Name for Responsive Layout and Assistive Technology Review', provider: 'Billing account ending in 98765432109876543210', billingType: 'fixed', amount: 9876543.21, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt, status: 'active', revision: 1 },
  { id: 'svc-eur', name: 'Design Tool', provider: 'Example provider', billingType: 'fixed', amount: 23, currency: 'EUR', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt, status: 'active', revision: 1 },
]
const emptyConnections = Object.fromEntries(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger'].map(provider => [provider, { configured: false, revision: 0 }]))

async function fixture(page: Page) {
  await page.route('**/api/subscriptions**', route => route.fulfill({ json: subscriptions }))
  await page.route('**/api/hostinger/subscriptions', route => route.fulfill({ json: { subscriptions: [], sync: { status: 'not-configured' } } }))
  await page.route('**/api/connections', route => route.fulfill({ json: emptyConnections }))
  await page.route('**/api/costs', route => route.fulfill({ json: {
    snapshots: [{ id: 'cf-long', provider: 'cloudflare', periodStart, periodEnd: today, amount: 8765432.1, currency: 'USD', kind: 'actual', capturedAt, metadata: { period: 'current' } }],
    providers: { aws: { status: 'not-configured' }, cloudflare: { status: 'synced', lastSyncedAt: capturedAt }, openai: { status: 'not-configured' }, digitalocean: { status: 'not-configured' } },
  } }))
}

type TextMeasurement = { text: string; fontSize: number; foreground: string; background: string; contrast: number; bounds: Array<{ x: number; y: number; width: number; height: number }> }
type ViewMeasurement = { viewport: number; documentWidth: number; horizontalOverflow: number; overflowNodes: Array<{ element: string; right: number; width: number }>; tinyText: TextMeasurement[]; lowContrast: TextMeasurement[]; shortControls: Array<{ name: string; width: number; height: number }>; texts: TextMeasurement[] }

async function measure(page: Page): Promise<ViewMeasurement> {
  return page.evaluate(() => {
    const luminance = (color: string) => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0]
      const channels = values.map(value => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
    }
    const backgroundOf = (element: Element) => {
      let current: Element | null = element
      while (current) {
        const color = getComputedStyle(current).backgroundColor
        const alpha = Number(color.match(/rgba?\([^/]*[, ]\s*([\d.]+)\s*\)$/)?.[1] ?? 1)
        if (color !== 'rgba(0, 0, 0, 0)' && (color.startsWith('rgb(') || alpha > 0)) return color
        current = current.parentElement
      }
      return 'rgb(255, 255, 255)'
    }
    const texts: TextMeasurement[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      if (!node.textContent?.trim()) continue
      const element = node.parentElement
      if (!element || element.closest('.sr-only,[aria-hidden="true"]')) continue
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const bounds = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }))
      if (!bounds.length) continue
      const foreground = style.color
      const background = backgroundOf(element)
      const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x)
      texts.push({ text: node.textContent.trim().replace(/\s+/g, ' ').slice(0, 100), fontSize: Number.parseFloat(style.fontSize), foreground, background, contrast: (a + .05) / (b + .05), bounds })
    }
    const shortControls = Array.from(document.querySelectorAll('button,a[href],input,select,[role="button"]')).map(control => {
      const rect = control.getBoundingClientRect()
      return { name: (control.getAttribute('aria-label') || control.textContent || (control as HTMLInputElement).placeholder || control.tagName).trim().replace(/\s+/g, ' ').slice(0, 80), width: rect.width, height: rect.height }
    }).filter(control => control.width > 0 && (control.width < 44 || control.height < 44))
    const overflowNodes = Array.from(document.body.querySelectorAll('*')).map(element => {
      const rect = element.getBoundingClientRect()
      return { element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className && typeof element.className === 'string' ? `.${element.className.trim().replace(/\s+/g, '.')}` : ''}`, right: rect.right, width: rect.width }
    }).filter(element => element.width > 0 && element.right > innerWidth + 1).sort((a, b) => b.right - a.right).slice(0, 12)
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth - innerWidth, overflowNodes,
      tinyText: texts.filter(text => text.fontSize < 12), lowContrast: texts.filter(text => text.contrast < (text.fontSize >= 24 ? 3 : 4.5)), shortControls, texts }
  })
}

for (const route of routes) for (const width of widths) {
  test(`${route.name} typography and reflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await fixture(page)
    await page.goto(route.path)
    await expect(page.locator('main')).toBeVisible()
    await expect(page.locator('main h1')).toBeVisible()
    const measurement = await measure(page)
    const screenshot = test.info().outputPath(`${phase}-${route.name}-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await test.info().attach('rendered-screenshot', { path: screenshot, contentType: 'image/png' })
    await test.info().attach('rendered-text-diagnostics', { body: JSON.stringify(measurement, null, 2), contentType: 'application/json' })
    if (phase === 'after') {
      expect(measurement.horizontalOverflow, `${route.name} should reflow at ${width}px`).toBeLessThanOrEqual(0)
      expect(measurement.tinyText, `${route.name} has text below the 12px dense-note floor`).toEqual([])
      expect(measurement.lowContrast, `${route.name} has text below WCAG AA normal-text contrast`).toEqual([])
      expect(measurement.shortControls, `${route.name} has interactive targets below 44×44px at ${width}px`).toEqual([])
    }
  })
}

for (const route of routes) {
  test(`${route.name} remains readable at 200% zoom-equivalent width`, async ({ page }) => {
    // 640 CSS pixels is half of a 1280px layout viewport. The 320px matrix
    // above covers its 400% zoom-equivalent width.
    await page.setViewportSize({ width: 640, height: 900 })
    await fixture(page)
    await page.goto(route.path)
    await expect(page.locator('main h1')).toBeVisible()
    const measurement = await measure(page)
    const screenshot = test.info().outputPath(`${phase}-${route.name}-zoom-200-equivalent-640.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await test.info().attach('rendered-screenshot', { path: screenshot, contentType: 'image/png' })
    if (phase === 'after') {
      expect(measurement.horizontalOverflow, `${route.name} should reflow at 200%-equivalent width`).toBeLessThanOrEqual(0)
      expect(measurement.tinyText).toEqual([])
      expect(measurement.lowContrast).toEqual([])
      expect(measurement.shortControls, `${route.name} has interactive targets below 44×44px at 640px`).toEqual([])
    }
  })
}

for (const route of routes) {
  test(`${route.name} passes axe WCAG 2.2 AA checks`, async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 })
    await fixture(page)
    await page.goto(route.path)
    await expect(page.locator('main h1')).toBeVisible()
    const result = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
    await test.info().attach('axe-accessibility-results', { body: JSON.stringify(result.violations.map(({ id, impact, description, help, nodes }) => ({ id, impact, description, help, nodes: nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })), null, 2), contentType: 'application/json' })
    expect(result.violations, `${route.path} axe violations`).toEqual([])
  })
}

test('subscription dialog supports keyboard open, focus, escape and focus restoration', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 })
  await fixture(page)
  await page.goto('/services')
  const trigger = page.getByRole('button', { name: 'Add manually' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Add a subscription' })
  await expect(dialog).toBeVisible()
  await expect(page.locator('#subscription-name')).toBeFocused()
  const scan = await new AxeBuilder({ page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"] }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze()
  expect(scan.violations, 'subscription dialog Axe violations').toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})
