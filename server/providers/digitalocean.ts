import { createCostSnapshot, normalizeUsageAmount, type CostSnapshot } from '../../src/domain/usage-costs.ts'

const PAGE_SIZE = 200
const MAX_PAGES = 6

type DigitalOceanOptions = { apiToken: string; now?: Date; fetch?: typeof fetch; timeoutMs?: number }
type Invoice = { invoiceUUID: string; invoiceID: string; period: string; amount: number }

function invalid(): never { throw new Error('DigitalOcean returned invalid invoice data.') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function monthBounds(period: string): [string, string] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return invalid()
  const start = `${period}-01`
  const date = new Date(`${start}T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return [start, date.toISOString().slice(0, 10)]
}
function parseInvoice(value: unknown): Invoice {
  const row = object(value)
  if (typeof row.invoice_uuid !== 'string' || !row.invoice_uuid.trim() || row.invoice_uuid.length > 256
    || typeof row.invoice_id !== 'string' || !row.invoice_id.trim() || row.invoice_id.length > 256
    || typeof row.invoice_period !== 'string') return invalid()
  monthBounds(row.invoice_period)
  let amount: number
  try { amount = normalizeUsageAmount(row.amount) } catch { return invalid() }
  return { invoiceUUID: row.invoice_uuid, invoiceID: row.invoice_id, period: row.invoice_period, amount }
}

/** Import finalized invoice totals only. Previews, balance snapshots, usage estimates, and cash events are separate data. */
export async function collectDigitalOceanInvoices(options: DigitalOceanOptions): Promise<CostSnapshot[]> {
  if (typeof options.apiToken !== 'string' || !options.apiToken.trim() || /[\s\u0000-\u001f\u007f]/.test(options.apiToken)) throw new Error('DigitalOcean API token configuration is invalid.')
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('DigitalOcean invoice refresh configuration is invalid.')
  const capturedAt = now.toISOString()
  const fetcher = options.fetch ?? fetch
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const invoices: Invoice[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL('https://api.digitalocean.com/v2/customers/my/invoices')
    url.searchParams.set('per_page', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetcher(url, { headers: { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json' }, signal: controller.signal })
    } catch {
      if (controller.signal.aborted) throw new Error('DigitalOcean invoice refresh timed out.')
      throw new Error('DigitalOcean invoice refresh failed. Previous observations are retained.')
    } finally { clearTimeout(timer) }

    if (response.status === 401 || response.status === 403) throw new Error('DigitalOcean authorization failed. Check the token and billing:read access.')
    if (response.status === 429) throw new Error('DigitalOcean rate limit reached. Wait before retrying the invoice refresh.')
    if (!response.ok) throw new Error('DigitalOcean invoice refresh failed. Previous observations are retained.')
    let payload: unknown
    try { payload = await response.json() } catch { return invalid() }
    const envelope = object(payload)
    if (!Array.isArray(envelope.invoices)) invalid()
    const pageRows = envelope.invoices.map(parseInvoice)
    for (const invoice of pageRows) {
      if (seen.has(invoice.invoiceUUID)) throw new Error('DigitalOcean returned duplicate invoices. Previous observations are retained.')
      seen.add(invoice.invoiceUUID)
      invoices.push(invoice)
    }
    if (pageRows.length < PAGE_SIZE) break
    if (page === MAX_PAGES) throw new Error('DigitalOcean returned incomplete invoice history. Previous observations are retained.')
  }

  const months = new Map<string, Invoice[]>()
  for (const invoice of invoices) months.set(invoice.period, [...(months.get(invoice.period) ?? []), invoice])
  return [...months.entries()].map(([period, rows]) => {
    const [periodStart, periodEnd] = monthBounds(period)
    const amount = rows.reduce((sum, row) => normalizeUsageAmount(sum + row.amount), 0)
    return createCostSnapshot({
      id: `digitalocean:invoice:${period}:${capturedAt}`,
      provider: 'digitalocean', periodStart, periodEnd, amount, currency: 'USD', kind: 'actual', capturedAt,
      metadata: {
        period: 'invoice',
        scope: 'finalized-invoice-total',
        invoiceCount: rows.length,
        breakdown: rows.map(row => ({ service: `Finalized invoice ${row.invoiceID}`, amount: row.amount, currency: 'USD' })),
      },
    })
  })
}
