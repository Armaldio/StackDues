import { randomUUID } from 'node:crypto'
import { createCostSnapshot, type CostSnapshot } from '../../src/domain/usage-costs.ts'

type CloudflareOptions = {
  accountId: string
  apiToken: string
  now?: Date
  fetch?: typeof fetch
  timeoutMs?: number
}

function invalidData(): never {
  throw new Error('Cloudflare returned invalid billing data.')
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidData()
  return value as Record<string, unknown>
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) invalidData()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) invalidData()
  return parsed.toISOString()
}

// PayGo v1 exposes priced charge rows; v2 currently exposes unpriced consumption.
// Sum ContractedCost, never the repeated CumulatedContractedCost running totals.
export async function collectCloudflareCosts(options: CloudflareOptions): Promise<CostSnapshot[]> {
  if (!/^[a-f\d]{32}$/i.test(options.accountId) || !options.apiToken?.trim()) {
    throw new Error('Cloudflare configuration is invalid.')
  }
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime())) throw new Error('Cloudflare configuration is invalid.')
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let payload: unknown
  try {
    const response = await (options.fetch ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/billable-usage`,
      { headers: { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json' }, signal: controller.signal },
    )
    if (response.status === 401 || response.status === 403) throw new Error('Cloudflare authorization failed. Check the server token and Billing Read permission.')
    if (!response.ok) throw new Error('Cloudflare request failed.')
    payload = await response.json()
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Cloudflare request timed out.')
    if (error instanceof Error && ['Cloudflare authorization failed. Check the server token and Billing Read permission.', 'Cloudflare request failed.'].includes(error.message)) throw error
    throw new Error('Cloudflare request failed.')
  } finally {
    clearTimeout(timer)
  }

  const envelope = object(payload)
  if (envelope.success !== true) throw new Error('Cloudflare request failed.')
  if (!Array.isArray(envelope.result)) invalidData()
  // This endpoint has no documented pagination. Do not publish partial money totals
  // if Cloudflare starts sending pagination metadata in a future response.
  if (envelope.result_info !== undefined) {
    const info = object(envelope.result_info)
    if ((typeof info.total_pages === 'number' && info.total_pages > 1)
      || (typeof info.total_count === 'number' && info.total_count > envelope.result.length)
      || info.next_cursor || info.has_more) {
      throw new Error('Cloudflare returned incomplete billing data.')
    }
  }

  const groups = new Map<string, {
    periodStart: string, periodEnd: string, reportedThrough: string, currency: string,
    amount: number, services: Map<string, number>,
  }>()
  for (const raw of envelope.result) {
    const row = object(raw)
    const start = timestamp(row.BillingPeriodStart)
    const chargeStart = timestamp(row.ChargePeriodStart)
    const chargeEnd = timestamp(row.ChargePeriodEnd)
    if (start > chargeStart || chargeStart >= chargeEnd) invalidData()
    if (typeof row.ContractedCost !== 'number' || !Number.isFinite(row.ContractedCost)
      || typeof row.BillingCurrency !== 'string' || !/^[A-Z]{3}$/.test(row.BillingCurrency)
      || typeof row.ServiceName !== 'string' || !row.ServiceName.trim()) invalidData()
    const periodStart = start.slice(0, 10)
    // Retain the reported charge interval. The API has no full billing-cycle end.
    // A non-midnight charge end rounds up to preserve the exclusive date interval.
    const endDate = new Date(chargeEnd)
    const periodEnd = chargeEnd.endsWith('T00:00:00.000Z')
      ? chargeEnd.slice(0, 10)
      : new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate() + 1)).toISOString().slice(0, 10)
    const key = `${periodStart}:${row.BillingCurrency}`
    const group = groups.get(key) ?? {
      periodStart, periodEnd, reportedThrough: chargeEnd, currency: row.BillingCurrency,
      amount: 0, services: new Map<string, number>(),
    }
    group.periodEnd = group.periodEnd > periodEnd ? group.periodEnd : periodEnd
    group.reportedThrough = group.reportedThrough > chargeEnd ? group.reportedThrough : chargeEnd
    group.amount += row.ContractedCost
    group.services.set(row.ServiceName, (group.services.get(row.ServiceName) ?? 0) + row.ContractedCost)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => createCostSnapshot({
    id: randomUUID(), provider: 'cloudflare', periodStart: group.periodStart, periodEnd: group.periodEnd,
    amount: group.amount, currency: group.currency, kind: 'actual', capturedAt: now.toISOString(),
    metadata: {
      period: 'current', scope: 'billing-period-to-date', reportedThrough: group.reportedThrough,
      projectionUnavailable: true,
      breakdown: [...group.services.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([service, amount]) => ({ service, amount, currency: group.currency })),
    },
  }))
}
