export type CloudflareRegistrationStatus = 'active' | 'registration_pending' | 'transfer_pending' | 'expired' | 'suspended' | 'redemption_period' | 'pending_delete'
export type CloudflareRegistration = { domainName: string; status: CloudflareRegistrationStatus; expiresAt: string | null; autoRenew: boolean }

export type CloudflareRegistrarOptions = { accountId: string; apiToken: string; fetch?: typeof fetch; timeoutMs?: number }

const MAX_RESULTS = 1000
const MAX_PAGES = 20
const PAGE_SIZE = 50
const statuses = new Set<CloudflareRegistrationStatus>(['active', 'registration_pending', 'transfer_pending', 'expired', 'suspended', 'redemption_period', 'pending_delete'])

function invalid(): never { throw new Error('Cloudflare returned invalid Registrar data.') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function domainName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 253) invalid()
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(normalized)) invalid()
  return normalized
}
function date(value: unknown): string | null {
  if (value === null) return null
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const day = new Date(`${value}T00:00:00.000Z`)
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) invalid()
    return value
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid()
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) invalid()
  return parsed.toISOString().slice(0, 10)
}
export function normalizeCloudflareRegistration(value: unknown): CloudflareRegistration {
  const raw = object(value)
  if (typeof raw.status !== 'string' || !statuses.has(raw.status as CloudflareRegistrationStatus) || typeof raw.auto_renew !== 'boolean') invalid()
  return { domainName: domainName(raw.domain_name), status: raw.status as CloudflareRegistrationStatus, expiresAt: date(raw.expires_at), autoRenew: raw.auto_renew }
}

/** Read only Cloudflare Registrar registration fields; registrant contacts and other PII are discarded. */
export async function fetchCloudflareRegistrations(options: CloudflareRegistrarOptions): Promise<CloudflareRegistration[]> {
  if (!/^[a-f\d]{32}$/i.test(options.accountId) || !options.apiToken?.trim()) throw new Error('Cloudflare configuration is invalid.')
  const controller = new AbortController()
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 1), 30_000)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetcher = options.fetch ?? fetch
  const registrations: CloudflareRegistration[] = []
  const seenCursors = new Set<string>()
  const seenDomains = new Set<string>()
  let cursor = ''
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/registrar/registrations`)
      url.searchParams.set('per_page', String(PAGE_SIZE))
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await fetcher(url, { headers: { Authorization: `Bearer ${options.apiToken}`, Accept: 'application/json' }, signal: controller.signal })
      if (response.status === 401 || response.status === 403) throw new Error('Cloudflare authorization failed. Check the server token has Registrar read access.')
      if (!response.ok) throw new Error(`Cloudflare HTTP status ${response.status}.`)

      const envelope = object(await response.json())
      if (envelope.success !== true || !Array.isArray(envelope.result)) throw new Error('Cloudflare Registrar request was rejected.')
      const info = object(envelope.result_info)
      if (!Number.isSafeInteger(info.count) || (info.count as number) !== envelope.result.length
        || !Number.isSafeInteger(info.per_page) || (info.per_page as number) < 1 || (info.per_page as number) > PAGE_SIZE
        || typeof info.cursor !== 'string' || info.cursor.length > 256) throw new Error('Cloudflare returned incomplete Registrar data.')
      const pageItems = envelope.result.map(normalizeCloudflareRegistration)
      for (const item of pageItems) {
        if (seenDomains.has(item.domainName)) invalid()
        seenDomains.add(item.domainName)
        registrations.push(item)
      }
      if (registrations.length > MAX_RESULTS) throw new Error('Cloudflare returned incomplete Registrar data.')
      cursor = info.cursor
      if (!cursor) return registrations
      if (seenCursors.has(cursor)) throw new Error('Cloudflare returned incomplete Registrar data.')
      seenCursors.add(cursor)
    }
    throw new Error('Cloudflare returned incomplete Registrar data.')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Cloudflare request timed out.')
    if (error instanceof Error && (error.message.startsWith('Cloudflare authorization failed.') || error.message.startsWith('Cloudflare HTTP status ')
      || error.message.startsWith('Cloudflare request failed.') || error.message.startsWith('Cloudflare Registrar request was rejected.')
      || error.message.startsWith('Cloudflare returned invalid Registrar data.') || error.message.startsWith('Cloudflare returned incomplete Registrar data.'))) throw error
    throw new Error('Cloudflare request failed.')
  } finally {
    clearTimeout(timer)
  }
  throw new Error('Cloudflare returned incomplete Registrar data.')
}
