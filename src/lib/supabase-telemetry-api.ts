import { parseConnectionStatus, type ConnectionStatus } from './connection-api.ts'

export type SupabaseUsageObservation = Readonly<{
  id: string; organizationSlug: string; projectRef: string; projectName: string; interval: '1day';
  observedAt: string; capturedAt: string; authRequests: number; realtimeRequests: number; restRequests: number; storageRequests: number
}>
export type SupabaseUsageState = { configured: boolean; status: ConnectionStatus; observations: SupabaseUsageObservation[] }
export class SupabaseTelemetryError extends Error {}

function parseState(value: unknown): SupabaseUsageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupabaseTelemetryError('Supabase telemetry could not be read. Reload connections before trying again.')
  const row = value as Record<string, unknown>
  if (typeof row.configured !== 'boolean' || !Array.isArray(row.observations)) throw new SupabaseTelemetryError('Supabase telemetry could not be read. Reload connections before trying again.')
  try {
    return { configured: row.configured, status: parseConnectionStatus(row.status), observations: row.observations.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error()
      const observation = item as Record<string, unknown>
      if (['id', 'organizationSlug', 'projectRef', 'projectName', 'observedAt', 'capturedAt'].some(key => typeof observation[key] !== 'string') || observation.interval !== '1day' || ['authRequests', 'realtimeRequests', 'restRequests', 'storageRequests'].some(key => !Number.isSafeInteger(observation[key]) || Number(observation[key]) < 0)) throw new Error()
      return observation as unknown as SupabaseUsageObservation
    }) }
  } catch { throw new SupabaseTelemetryError('Supabase telemetry could not be read. Reload connections before trying again.') }
}
async function request(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  let response: Response
  try { response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }) }
  catch { throw new SupabaseTelemetryError('The server could not be reached. Reload connections before trying again.') }
  if (!response.ok) throw new SupabaseTelemetryError(response.status === 401 ? 'Your session expired. Sign in again, then reload.' : 'Supabase telemetry request failed. Previous data is retained; check the organization slug and read-only token permissions.')
  return response
}
async function json(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw new SupabaseTelemetryError('The server response could not be read. Reload connections before trying again.') }
}
export async function fetchSupabaseUsage(): Promise<SupabaseUsageState> { return parseState(await json(await request('/api/supabase/usage'))) }
export async function refreshSupabaseUsage(): Promise<SupabaseUsageState> { return parseState(await json(await request('/api/supabase/usage/refresh', 'POST'))) }
export async function saveSupabaseConnection(credentials: { apiToken: string; organizationSlug: string }, revision: number): Promise<ConnectionStatus> {
  const value = parseConnectionStatus(await json(await request('/api/supabase/connection', 'PUT', { credentials, revision })))
  if (!value.configured || value.revision <= revision) throw new SupabaseTelemetryError('The saved connection could not be confirmed. Reload connections before trying again.')
  return value
}
export async function deleteSupabaseConnection(revision: number): Promise<ConnectionStatus> {
  const value = parseConnectionStatus(await json(await request('/api/supabase/connection', 'DELETE', undefined, { 'If-Match': `"${revision}"` })))
  if (value.configured || value.revision <= revision) throw new SupabaseTelemetryError('The disconnection could not be confirmed. Reload connections before trying again.')
  return value
}
