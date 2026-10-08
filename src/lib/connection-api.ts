import { isValidCostTimestamp } from '../domain/usage-costs.ts'
import type { CostProvider } from '../domain/usage-costs.ts'

export type ConnectionProvider = 'aws' | 'cloudflare' | 'hostinger'
export type ConnectionStatus = { configured: boolean; revision: number; updatedAt?: string }
export type ConnectionStatuses = Record<ConnectionProvider, ConnectionStatus>
export type ProviderCredentials = {
  aws: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  cloudflare: { accountId: string; apiToken: string }
  hostinger: { apiToken: string }
}
export class ConnectionApiError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) { super(message); this.status = status }
}
export function parseConnectionStatus(value: unknown): ConnectionStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectionApiError('Connection status could not be read. Reload connections before making changes.')
  const row = value as Record<string, unknown>
  if (typeof row.configured !== 'boolean' || !Number.isSafeInteger(row.revision) || (row.revision as number) < 0 || (row.configured && row.revision === 0) || (row.updatedAt !== undefined && !isValidCostTimestamp(row.updatedAt))) {
    throw new ConnectionApiError('Connection status could not be read. Reload connections before making changes.')
  }
  return { configured: row.configured, revision: row.revision as number, ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt as string }) }
}
export function parseConnectionStatuses(value: unknown): ConnectionStatuses {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConnectionApiError('Connection status could not be read. Reload connections before making changes.')
  const rows = value as Record<string, unknown>
  return { aws: parseConnectionStatus(rows.aws), cloudflare: parseConnectionStatus(rows.cloudflare), hostinger: parseConnectionStatus(rows.hostinger) }
}
async function request(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60_000), headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch { throw new ConnectionApiError('The server could not be reached. Reload to check the saved state before trying again.') }
  if (!response.ok) {
    if (response.status === 401) throw new ConnectionApiError('Your session expired. Sign in again, then reload.', 401)
    if (response.status === 409) throw new ConnectionApiError('The connection changed on another device. Reload connections before replacing or disconnecting it.', 409)
    if (response.status === 429) throw new ConnectionApiError('A provider refresh is already running or was started recently. Wait a moment, then try again.', 429)
    throw new ConnectionApiError('The request failed. Reload to check the saved state before trying again.', response.status)
  }
  return response
}
async function json(response: Response): Promise<unknown> {
  try { return await response.json() }
  catch { throw new ConnectionApiError('The server response could not be read. Reload to check the saved state before trying again.') }
}
export async function fetchConnections(): Promise<ConnectionStatuses> { return parseConnectionStatuses(await json(await request('/api/connections', 'GET'))) }
export async function saveConnection<P extends ConnectionProvider>(provider: P, credentials: ProviderCredentials[P], revision: number): Promise<ConnectionStatus> {
  const status = parseConnectionStatus(await json(await request(`/api/connections/${provider}`, 'PUT', { credentials, revision })))
  if (!status.configured || status.revision <= revision) throw new ConnectionApiError('The saved connection could not be confirmed. Reload connections before trying again.')
  return status
}
export async function deleteConnection(provider: ConnectionProvider, revision: number): Promise<ConnectionStatus> {
  const status = parseConnectionStatus(await json(await request(`/api/connections/${provider}`, 'DELETE', undefined, { 'If-Match': `"${revision}"` })))
  if (status.configured || status.revision <= revision) throw new ConnectionApiError('The disconnection could not be confirmed. Reload connections before trying again.')
  return status
}
const refreshing = new Map<string, Promise<void>>()
export async function refreshProviders(provider?: CostProvider): Promise<void> {
  const key = provider ?? 'all'
  const current = refreshing.get(key)
  if (current) return current
  const url = provider ? `/api/costs/refresh?provider=${provider}` : '/api/costs/refresh'
  const operation = request(url, 'POST').then(async response => {
    if (!provider) return
    const feed = await json(response)
    const providers = feed && typeof feed === 'object' && !Array.isArray(feed) ? (feed as Record<string, unknown>).providers : undefined
    const status = providers && typeof providers === 'object' && !Array.isArray(providers) ? (providers as Record<string, unknown>)[provider] : undefined
    if (!status || typeof status !== 'object' || Array.isArray(status) || (status as Record<string, unknown>).status !== 'synced') {
      throw new ConnectionApiError('The provider refresh did not complete. Previous data is retained; retry the sync.')
    }
  }).finally(() => refreshing.delete(key))
  refreshing.set(key, operation)
  return operation
}
