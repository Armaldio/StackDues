import { createSubscription, type RecurrenceUnit } from '../../src/domain/subscriptions.ts'

export type CloudflareCommitment = {
  name: string
  amount: number
  currency: string
  recurrenceInterval: number
  recurrenceUnit: RecurrenceUnit
  nextRenewalAt: string
  status: 'active' | 'cancelled'
}

export type CloudflareSubscription = {
  externalId: string
  state: string
  commitment: CloudflareCommitment | null
}

type CloudflareSubscriptionOptions = {
  accountId: string
  apiToken: string
  fetch?: typeof fetch
  timeoutMs?: number
}

const PAGE_SIZE = 100
const MAX_PAGES = 10
const frequencies: Record<string, { interval: number; unit: RecurrenceUnit }> = {
  weekly: { interval: 1, unit: 'week' },
  monthly: { interval: 1, unit: 'month' },
  quarterly: { interval: 3, unit: 'month' },
  yearly: { interval: 1, unit: 'year' },
}
const states = new Set(['Trial', 'Provisioned', 'Paid', 'AwaitingPayment', 'Cancelled', 'Failed', 'Expired'])

function invalidData(): never {
  throw new Error('Cloudflare returned invalid subscription data.')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidData()
  return value as Record<string, unknown>
}

function timestampDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalidData()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) invalidData()
  return parsed.toISOString().slice(0, 10)
}

function frequency(value: unknown): { interval: number; unit: RecurrenceUnit } | null {
  if (typeof value !== 'string') return null
  return frequencies[value] ?? null
}

/** Normalize only Workers account plans; other account and zone subscriptions stay separate. */
export function normalizeCloudflareSubscription(input: unknown): CloudflareSubscription | null {
  const raw = object(input)
  const plan = raw.rate_plan === undefined || raw.rate_plan === null ? {} : object(raw.rate_plan)
  const publicName = typeof plan.public_name === 'string' ? plan.public_name.trim() : ''
  const planId = typeof plan.id === 'string' ? plan.id.trim() : ''
  const sets = plan.sets === undefined || plan.sets === null ? [] : plan.sets
  if (!Array.isArray(sets) || sets.some(value => typeof value !== 'string')) invalidData()
  const appliesToWorkers = /workers?/i.test(publicName) || /workers?/i.test(planId)
    || (sets as string[]).some(value => /workers?/i.test(value))
  if (!appliesToWorkers) return null

  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.id)
    || typeof raw.state !== 'string' || !states.has(raw.state)) invalidData()

  const active = !['Cancelled', 'Failed', 'Expired'].includes(raw.state)
  const recurrence = frequency(raw.frequency)
  const price = raw.price
  // Cloudflare documents `price` as the billed amount in US dollars; the
  // response's optional `currency` is display metadata and must not relabel it.
  const currency = 'USD'
  if (active && (!recurrence || typeof price !== 'number' || !Number.isFinite(price) || price < 0 || !raw.current_period_end)) invalidData()

  if (!recurrence || typeof price !== 'number' || !Number.isFinite(price) || price < 0
    || !raw.current_period_end) {
    return { externalId: raw.id, state: raw.state, commitment: null }
  }

  const baseName = publicName || 'Cloudflare Workers'
  const name = /workers?/i.test(baseName) ? baseName : `Cloudflare Workers · ${baseName}`
  const status: CloudflareCommitment['status'] = active ? 'active' : 'cancelled'
  let commitment: CloudflareCommitment
  try {
    const valid = createSubscription({
      id: raw.id,
      provider: 'Cloudflare',
      billingType: 'fixed',
      name,
      amount: price,
      currency: currency.toUpperCase(),
      recurrenceInterval: recurrence.interval,
      recurrenceUnit: recurrence.unit,
      nextRenewalAt: timestampDate(raw.current_period_end),
      status,
    })
    commitment = {
      name: valid.name,
      amount: valid.amount,
      currency: valid.currency,
      recurrenceInterval: valid.recurrenceInterval,
      recurrenceUnit: valid.recurrenceUnit,
      nextRenewalAt: valid.nextRenewalAt,
      status,
    }
  } catch { invalidData() }
  return { externalId: raw.id, state: raw.state, commitment }
}

/** Uses Cloudflare's read-only account subscriptions endpoint for fixed plan commitments. */
export async function fetchCloudflareSubscriptions(options: CloudflareSubscriptionOptions): Promise<CloudflareSubscription[]> {
  if (!/^[a-f\d]{32}$/i.test(options.accountId) || !options.apiToken?.trim()) {
    throw new Error('Cloudflare configuration is invalid.')
  }

  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetcher = options.fetch ?? fetch
  const records: unknown[] = []
  let expectedCount: number | null = null
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/subscriptions?page=${page}&per_page=${PAGE_SIZE}`
      let payload: unknown
      try {
        const response = await fetcher(url, {
          headers: { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json' },
          signal: controller.signal,
        })
        if (response.status === 401 || response.status === 403) throw new Error('Cloudflare authorization failed. Check the server token and Billing Read permission.')
        if (!response.ok) throw new Error('Cloudflare request failed.')
        payload = await response.json()
      } catch (error) {
        if (error instanceof Error && ['Cloudflare authorization failed. Check the server token and Billing Read permission.', 'Cloudflare request failed.'].includes(error.message)) throw error
        throw new Error('Cloudflare request failed.')
      }

      const envelope = object(payload)
      if (envelope.success !== true || !Array.isArray(envelope.result)) throw new Error('Cloudflare request failed.')
      const pageRows = envelope.result
      const info = envelope.result_info === undefined ? null : object(envelope.result_info)
      if (info) {
        if (info.count !== undefined && info.count !== pageRows.length) throw new Error('Cloudflare returned incomplete subscription data.')
        if (info.total_count !== undefined) {
          if (!Number.isSafeInteger(info.total_count) || (info.total_count as number) < 0) invalidData()
          if (expectedCount !== null && expectedCount !== info.total_count) throw new Error('Cloudflare returned incomplete subscription data.')
          expectedCount = info.total_count as number
        }
        if (info.page !== undefined && info.page !== page) throw new Error('Cloudflare returned incomplete subscription data.')
      }
      records.push(...pageRows)
      if (records.length > 1000) throw new Error('Cloudflare returned incomplete subscription data.')
      if (expectedCount !== null && records.length > expectedCount) throw new Error('Cloudflare returned incomplete subscription data.')
      if (expectedCount !== null ? records.length === expectedCount : pageRows.length < (typeof info?.per_page === 'number' ? info.per_page : PAGE_SIZE)) return normalizeSubscriptions(records)
      if (pageRows.length === 0) throw new Error('Cloudflare returned incomplete subscription data.')
      if (page === MAX_PAGES) throw new Error('Cloudflare returned incomplete subscription data.')
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Cloudflare request timed out.')
    if (error instanceof Error && (error.message.startsWith('Cloudflare authorization failed.') || error.message.startsWith('Cloudflare request failed.')
      || error.message.startsWith('Cloudflare returned invalid subscription data.') || error.message.startsWith('Cloudflare returned incomplete subscription data.'))) throw error
    throw new Error('Cloudflare request failed.')
  } finally {
    clearTimeout(timer)
  }
  throw new Error('Cloudflare returned incomplete subscription data.')
}

function normalizeSubscriptions(records: unknown[]): CloudflareSubscription[] {
  const subscriptions = records.map(normalizeCloudflareSubscription).filter((value): value is CloudflareSubscription => value !== null)
  if (new Set(subscriptions.map(item => item.externalId)).size !== subscriptions.length) invalidData()
  return subscriptions
}
