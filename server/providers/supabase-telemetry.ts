import { LedgerError } from '../data/ledger.ts'
import type { SupabaseCredentials } from '../security/provider-credentials.ts'

export type SupabaseUsageObservation = Readonly<{
  id: string
  organizationSlug: string
  projectRef: string
  projectName: string
  interval: '1day'
  observedAt: string
  capturedAt: string
  authRequests: number
  realtimeRequests: number
  restRequests: number
  storageRequests: number
}>
type Project = { ref: string; name: string }
type Dependencies = { fetch?: typeof fetch; timeoutMs?: number }
const endpoint = 'https://api.supabase.com/v1'

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z$/.test(value)
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Supabase telemetry count')
  return value
}
async function requestJson(url: URL, token: string, fetcher: typeof fetch, timeoutMs: number): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch { throw new Error('Supabase telemetry request failed') }
  if (!response.ok) throw new Error(`Supabase telemetry request failed (${response.status})`)
  try { return await response.json() }
  catch { throw new Error('Supabase telemetry response was invalid') }
}

async function listProjects(credentials: SupabaseCredentials, fetcher: typeof fetch, timeoutMs: number): Promise<Project[]> {
  const projects: Project[] = []
  let offset = 0
  for (;;) {
    const url = new URL(`${endpoint}/organizations/${encodeURIComponent(credentials.organizationSlug)}/projects`)
    url.searchParams.set('limit', '100')
    url.searchParams.set('offset', String(offset))
    const payload = record(await requestJson(url, credentials.apiToken, fetcher, timeoutMs))
    const data = payload?.projects
    const pagination = record(payload?.pagination)
    if (!Array.isArray(data) || !pagination || !Number.isSafeInteger(pagination.count) || !Number.isSafeInteger(pagination.limit) || !Number.isSafeInteger(pagination.offset)) throw new Error('Supabase project response was invalid')
    for (const item of data) {
      const row = record(item)
      if (!row || typeof row.ref !== 'string' || !/^[a-z]{20}$/.test(row.ref) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 256) throw new Error('Supabase project response was invalid')
      projects.push({ ref: row.ref, name: row.name.trim() })
    }
    if (Number(pagination.offset) !== offset) throw new Error('Supabase project response was invalid')
    if (offset + data.length >= Number(pagination.count)) break
    const nextOffset = offset + Number(pagination.limit)
    if (!data.length || nextOffset <= offset || nextOffset >= 10000) throw new Error('Supabase organization contains too many projects to sync safely')
    offset = nextOffset
  }
  return projects
}

async function collectProject(credentials: SupabaseCredentials, project: Project, now: string, fetcher: typeof fetch, timeoutMs: number): Promise<SupabaseUsageObservation[]> {
  const url = new URL(`${endpoint}/projects/${encodeURIComponent(project.ref)}/analytics/endpoints/usage.api-counts`)
  url.searchParams.set('interval', '1day')
  const response = record(await requestJson(url, credentials.apiToken, fetcher, timeoutMs))
  if (!response || !Array.isArray(response.result) || (response.error !== undefined && response.error !== null && response.error !== '')) throw new Error('Supabase telemetry response was invalid')
  return response.result.map((item: unknown) => {
    const row = record(item)
    if (!row || !validTimestamp(row.timestamp)) throw new Error('Supabase telemetry response was invalid')
    return Object.freeze({
      id: crypto.randomUUID(), organizationSlug: credentials.organizationSlug, projectRef: project.ref, projectName: project.name,
      interval: '1day' as const, observedAt: row.timestamp, capturedAt: now,
      authRequests: count(row.total_auth_requests), realtimeRequests: count(row.total_realtime_requests),
      restRequests: count(row.total_rest_requests), storageRequests: count(row.total_storage_requests),
    })
  })
}

/** Uses only documented read endpoints and publishes request counters as non-financial telemetry. */
export async function collectSupabaseTelemetry(credentials: SupabaseCredentials, now = new Date(), dependencies: Dependencies = {}): Promise<SupabaseUsageObservation[]> {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid Supabase telemetry capture time')
  const fetcher = dependencies.fetch ?? fetch
  const timeoutMs = dependencies.timeoutMs ?? 20_000
  try {
    const projects = await listProjects(credentials, fetcher, timeoutMs)
    const capturedAt = now.toISOString()
    const observations: SupabaseUsageObservation[] = []
    for (let index = 0; index < projects.length; index += 4) {
      const batch = projects.slice(index, index + 4)
      observations.push(...(await Promise.all(batch.map(project => collectProject(credentials, project, capturedAt, fetcher, timeoutMs)))).flat())
    }
    return observations
  } catch {
    throw new LedgerError(502, 'Supabase telemetry could not be refreshed. Previous data is retained; check the organization slug and read-only token permissions.')
  }
}

function fromRow(row: Record<string, unknown>): SupabaseUsageObservation {
  return {
    id: String(row.id), organizationSlug: String(row.organization_slug), projectRef: String(row.project_ref), projectName: String(row.project_name),
    interval: '1day', observedAt: String(row.observed_at), capturedAt: String(row.captured_at),
    authRequests: Number(row.auth_requests), realtimeRequests: Number(row.realtime_requests),
    restRequests: Number(row.rest_requests), storageRequests: Number(row.storage_requests),
  }
}

export async function readSupabaseTelemetry(db: D1Database, organizationSlug?: string): Promise<SupabaseUsageObservation[]> {
  try {
    const query = organizationSlug
      ? db.prepare(`SELECT * FROM supabase_usage_observations WHERE organization_slug = ? AND captured_at = (SELECT MAX(latest.captured_at) FROM supabase_usage_observations AS latest WHERE latest.organization_slug = supabase_usage_observations.organization_slug AND latest.project_ref = supabase_usage_observations.project_ref) ORDER BY project_name, observed_at LIMIT 10000`).bind(organizationSlug)
      : db.prepare(`SELECT * FROM supabase_usage_observations WHERE captured_at = (SELECT MAX(latest.captured_at) FROM supabase_usage_observations AS latest WHERE latest.organization_slug = supabase_usage_observations.organization_slug AND latest.project_ref = supabase_usage_observations.project_ref) ORDER BY project_name, observed_at LIMIT 10000`)
    const result = await query.all<Record<string, unknown>>()
    return result.results.map(fromRow)
  } catch { throw new LedgerError(503, 'Supabase telemetry storage is unavailable. Try again later.') }
}

export async function persistSupabaseTelemetry(db: D1Database, observations: readonly SupabaseUsageObservation[]): Promise<void> {
  try {
    for (let index = 0; index < observations.length; index += 100) {
      const batch = observations.slice(index, index + 100).map(row => db.prepare(`INSERT INTO supabase_usage_observations (id, organization_slug, project_ref, project_name, interval, observed_at, captured_at, auth_requests, realtime_requests, rest_requests, storage_requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        row.id, row.organizationSlug, row.projectRef, row.projectName, row.interval, row.observedAt, row.capturedAt, row.authRequests, row.realtimeRequests, row.restRequests, row.storageRequests,
      ))
      if (batch.length) await db.batch(batch)
    }
  } catch { throw new LedgerError(503, 'Supabase telemetry could not be saved. Previous data is retained. Try again later.') }
}
