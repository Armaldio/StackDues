import { createCostSnapshot, normalizeUsageAmount, type CostSnapshot } from '../../src/domain/usage-costs.ts'

const MAX_PAGES = 4
const PAGE_SIZE = 30
const DAY_SECONDS = 86_400

type OpenAiOptions = { adminApiKey: string; now?: Date; fetch?: typeof fetch; timeoutMs?: number }
type CostRow = { amount: number; currency: string; service: string }
type DayCosts = { start: number; end: number; currency: string; amount: number; breakdown: Map<string, number> }

function invalid(): never { throw new Error('OpenAI returned invalid cost data.') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function isoSeconds(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid()
  const date = new Date(value * 1000)
  if (!Number.isFinite(date.getTime())) invalid()
  return date.toISOString()
}
function parseResult(value: unknown): CostRow {
  const row = object(value)
  const amount = object(row.amount)
  const currency = typeof amount.currency === 'string' ? amount.currency.toUpperCase() : ''
  if (!/^[A-Z]{3}$/.test(currency) || (row.line_item !== null && row.line_item !== undefined && typeof row.line_item !== 'string') || (row.project_id !== null && row.project_id !== undefined && typeof row.project_id !== 'string')) invalid()
  let normalizedAmount: number
  try { normalizedAmount = normalizeUsageAmount(amount.value) } catch { return invalid() }
  const lineItem = typeof row.line_item === 'string' && row.line_item.trim() ? row.line_item.trim() : 'Organization API costs'
  const project = typeof row.project_id === 'string' && row.project_id.trim() ? ` · ${row.project_id.trim()}` : ''
  return { amount: normalizedAmount, currency, service: `${lineItem}${project}` }
}

/** Read a bounded 90-day window of organization cost buckets. These are reported API costs, not invoices. */
export async function collectOpenAiCosts(options: OpenAiOptions): Promise<CostSnapshot[]> {
  if (typeof options.adminApiKey !== 'string' || !options.adminApiKey.trim() || /[\s\u0000-\u001f\u007f]/.test(options.adminApiKey)) throw new Error('OpenAI Admin API key configuration is invalid.')
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('OpenAI cost refresh configuration is invalid.')
  const capturedAt = now.toISOString()
  const endTime = Math.floor(now.getTime() / 1000)
  const startTime = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000) - 89 * DAY_SECONDS
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const fetcher = options.fetch ?? fetch
  const buckets = new Map<string, DayCosts>()
  const cursors = new Set<string>()
  const seenRows = new Set<string>()
  let page: string | undefined

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const url = new URL('https://api.openai.com/v1/organization/costs')
    url.searchParams.set('start_time', String(startTime))
    url.searchParams.set('end_time', String(endTime))
    url.searchParams.set('bucket_width', '1d')
    url.searchParams.set('limit', String(PAGE_SIZE))
    url.searchParams.append('group_by[]', 'line_item')
    url.searchParams.append('group_by[]', 'project_id')
    if (page) url.searchParams.set('page', page)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetcher(url, {
        headers: { Authorization: `Bearer ${options.adminApiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      })
    } catch {
      if (controller.signal.aborted) throw new Error('OpenAI cost refresh timed out.')
      throw new Error('OpenAI cost refresh failed. Previous observations are retained.')
    } finally { clearTimeout(timer) }

    if (response.status === 401 || response.status === 403) throw new Error('OpenAI authorization failed. Check the Admin API key and organization costs access.')
    if (response.status === 429) throw new Error('OpenAI rate limit reached. Wait before retrying the cost refresh.')
    if (!response.ok) throw new Error('OpenAI cost refresh failed. Previous observations are retained.')
    let payload: unknown
    try { payload = await response.json() } catch { return invalid() }
    const envelope = object(payload)
    if (!Array.isArray(envelope.data) || typeof envelope.has_more !== 'boolean') invalid()

    for (const rawBucket of envelope.data) {
      const raw = object(rawBucket)
      const startIso = isoSeconds(raw.start_time)
      isoSeconds(raw.end_time)
      const start = Number(raw.start_time)
      const end = Number(raw.end_time)
      const latestBucketEnd = Math.ceil(endTime / DAY_SECONDS) * DAY_SECONDS
      if (start < startTime || end > latestBucketEnd || end <= start || end - start > DAY_SECONDS) invalid()
      if (!Array.isArray(raw.results)) invalid()
      const day = startIso.slice(0, 10)
      for (const rawResult of raw.results) {
        const result = parseResult(rawResult)
        const rowKey = `${start}:${end}:${result.currency}:${result.service}`
        if (seenRows.has(rowKey)) throw new Error('OpenAI returned overlapping paginated cost data. Previous observations are retained.')
        seenRows.add(rowKey)
        const key = `${day}:${result.currency}`
        const target = buckets.get(key) ?? { start, end, currency: result.currency, amount: 0, breakdown: new Map<string, number>() }
        target.start = Math.min(target.start, start)
        target.end = Math.max(target.end, end)
        target.amount = normalizeUsageAmount(target.amount + result.amount)
        target.breakdown.set(result.service, normalizeUsageAmount((target.breakdown.get(result.service) ?? 0) + result.amount))
        buckets.set(key, target)
      }
    }

    if (!envelope.has_more) break
    if (typeof envelope.next_page !== 'string' || !envelope.next_page || cursors.has(envelope.next_page) || pageNumber === MAX_PAGES - 1) throw new Error('OpenAI returned incomplete paginated cost data. Previous observations are retained.')
    page = envelope.next_page
    cursors.add(page)
  }

  return [...buckets.values()].map((bucket) => {
    const startDate = isoSeconds(bucket.start).slice(0, 10)
    const endDate = new Date(bucket.end * 1000).toISOString().slice(0, 10)
    const periodEnd = endDate > startDate ? endDate : new Date((bucket.start + DAY_SECONDS) * 1000).toISOString().slice(0, 10)
    if (periodEnd <= startDate) invalid()
    return createCostSnapshot({
      id: `openai:actual:${startDate}:${bucket.currency}:${capturedAt}`,
      provider: 'openai', periodStart: startDate, periodEnd, amount: bucket.amount,
      currency: bucket.currency, kind: 'actual', capturedAt,
      metadata: {
        period: startDate.slice(0, 7) === capturedAt.slice(0, 7) ? 'current' : 'historical',
        scope: 'organization-api-costs', reportedThrough: new Date(Math.min(bucket.end, endTime) * 1000).toISOString(),
        breakdown: [...bucket.breakdown.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([service, amount]) => ({ service, amount, currency: bucket.currency })),
      },
    })
  })
}
