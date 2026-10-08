import type { RecurrenceUnit } from '../../src/domain/subscriptions.ts'

export type HostingerBillingUnit = RecurrenceUnit | 'unsupported'
export type HostingerSubscription = {
  externalId: string
  name: string
  status: 'active' | 'paused' | 'cancelled' | 'not_renewing' | 'transferred' | 'in_trial' | 'future'
  recurrenceInterval: number | null
  recurrenceUnit: HostingerBillingUnit | null
  currency: string
  totalPrice: number | null
  renewalPrice: number | null
  isAutoRenewed: boolean
  createdAt: string
  expiresAt: string | null
  nextBillingAt: string | null
  nextBillingDate: string | null
  raw: Record<string, unknown>
}

export class HostingerError extends Error {
  constructor(message = 'Hostinger subscription discovery failed. Check the saved API token and retry.') { super(message); this.name = 'HostingerError' }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostingerError('Hostinger returned invalid subscription data.')
  return value as Record<string, unknown>
}
function date(value: unknown, nullable = false): string | null {
  if (nullable && value == null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new HostingerError('Hostinger returned invalid subscription dates.')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new HostingerError('Hostinger returned invalid subscription dates.')
  return parsed.toISOString()
}
function money(value: unknown): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HostingerError('Hostinger returned invalid subscription prices.')
  const amount = (value as number) / 100
  if (!Number.isFinite(amount)) throw new HostingerError('Hostinger returned invalid subscription prices.')
  return amount
}

export function normalizeHostingerSubscription(input: unknown): HostingerSubscription {
  const raw = object(input)
  const statuses = ['active', 'paused', 'cancelled', 'not_renewing', 'transferred', 'in_trial', 'future'] as const
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.id)
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 256
    || !statuses.includes(raw.status as typeof statuses[number])
    || !Number.isSafeInteger(raw.billing_period) || (raw.billing_period as number) < 1
    || typeof raw.billing_period_unit !== 'string'
    || typeof raw.currency_code !== 'string' || !/^[A-Z]{3}$/i.test(raw.currency_code)
    || typeof raw.is_auto_renewed !== 'boolean') throw new HostingerError('Hostinger returned invalid subscription details.')
  const createdAt = date(raw.created_at)!
  const expiresAt = date(raw.expires_at, true)
  // Hostinger documents next_billing_at only for auto-renewing subscriptions.
  const nextBillingDate = raw.is_auto_renewed && typeof raw.next_billing_at === 'string' ? raw.next_billing_at.slice(0, 10) : null
  const nextBillingAt = raw.is_auto_renewed ? date(raw.next_billing_at, true) : null
  const unit = ['day', 'week', 'month', 'year'].includes(raw.billing_period_unit) ? raw.billing_period_unit as RecurrenceUnit : null
  return {
    externalId: raw.id,
    name: raw.name.trim(),
    status: raw.status as HostingerSubscription['status'],
    recurrenceInterval: unit ? raw.billing_period as number : null,
    recurrenceUnit: unit ?? (raw.billing_period_unit === 'none' ? null : 'unsupported'),
    currency: raw.currency_code.toUpperCase(),
    totalPrice: money(raw.total_price),
    renewalPrice: money(raw.renewal_price),
    isAutoRenewed: raw.is_auto_renewed,
    createdAt,
    expiresAt,
    nextBillingAt,
    nextBillingDate,
    raw,
  }
}

async function jsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new HostingerError('Hostinger subscription data is too large to import.')
  const reader = response.body?.getReader()
  if (!reader) throw new HostingerError('Hostinger returned an empty subscription list.')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw new HostingerError('Hostinger subscription data is too large to import.') }
      chunks.push(value)
    }
    const content = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
  } catch (error) {
    if (error instanceof HostingerError) throw error
    throw new HostingerError('Hostinger returned invalid subscription data.')
  }
}

/** Read-only billing discovery; provider tokens and error response bodies never escape. */
export async function fetchHostingerSubscriptions(apiToken: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<HostingerSubscription[]> {
  if (typeof apiToken !== 'string' || !apiToken.trim() || apiToken.length > 4096 || /\s/.test(apiToken)) throw new HostingerError('Hostinger API token is invalid.')
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetch ?? fetch)('https://developers.hostinger.com/api/billing/v1/subscriptions', {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' }, signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) throw new HostingerError('Hostinger authorization failed. Check the saved API token and retry.')
    if (response.status === 429) throw new HostingerError('Hostinger rate limit reached. Wait before retrying.')
    if (!response.ok) throw new HostingerError()
    const payload = await jsonBounded(response, 1024 * 1024)
    if (!Array.isArray(payload) || payload.length > 1000) throw new HostingerError('Hostinger returned an invalid or oversized subscription list.')
    const subscriptions = payload.map(normalizeHostingerSubscription)
    if (new Set(subscriptions.map(item => item.externalId)).size !== subscriptions.length) throw new HostingerError('Hostinger returned duplicate subscription IDs.')
    return subscriptions
  } catch (error) {
    if (error instanceof HostingerError) throw error
    throw new HostingerError(controller.signal.aborted ? 'Hostinger subscription discovery timed out.' : undefined)
  } finally { clearTimeout(timer) }
}
