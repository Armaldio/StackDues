import type { StoredSubscription } from './subscription-api'

export type HostingerDiscoveryRow = {
  externalId: string; name: string; status: string; recurrenceInterval: number | null; recurrenceUnit: string | null
  currency: string; totalPrice: number | null; renewalPrice: number | null; isAutoRenewed: boolean; createdAt: string
  expiresAt: string | null; nextBillingAt: string | null; linkedSubscriptionId: string | null; seenInLatestSync: boolean
  renewalAvailable: boolean; upcomingCommitment: number | null
}
export type HostingerDiscovery = { subscriptions: HostingerDiscoveryRow[]; sync: { status: string; lastAttemptAt?: string; lastSyncedAt?: string } }
export class HostingerApiError extends Error { constructor(message: string, public readonly status?: number) { super(message) } }

async function request(path: string, method: string, body?: unknown): Promise<unknown> {
  let response: Response
  try { response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000), headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }) }
  catch { throw new HostingerApiError('Hostinger could not be reached. Previously discovered services remain available.') }
  if (!response.ok) {
    if (response.status === 401) throw new HostingerApiError('Your session expired. Sign in again, then reload.', 401)
    if (response.status === 409) throw new HostingerApiError('This service may already match a ledger entry. Reload and link it to avoid a duplicate.', 409)
    if (response.status === 400) throw new HostingerApiError('This service has no supported upcoming recurring charge. Keep it as a manual entry if needed.', 400)
    if (response.status === 429) throw new HostingerApiError('Wait a moment before refreshing providers again.', 429)
    throw new HostingerApiError('Hostinger could not be updated. Previous provider data and commitments were retained.', response.status)
  }
  try { return response.status === 204 ? undefined : await response.json() }
  catch { throw new HostingerApiError('The Hostinger response could not be checked. Reload before making changes.') }
}
export async function readHostingerDiscovery(): Promise<HostingerDiscovery> {
  const value = await request('/api/hostinger/subscriptions', 'GET')
  if (!value || typeof value !== 'object' || !('subscriptions' in value) || !Array.isArray(value.subscriptions) || !('sync' in value)) throw new HostingerApiError('Hostinger discovery returned invalid data. Reload before making changes.')
  return value as HostingerDiscovery
}
export async function syncHostinger(): Promise<HostingerDiscovery> { await request('/api/hostinger/subscriptions/sync', 'POST', {}); return readHostingerDiscovery() }
export async function addHostingerSubscription(externalId: string): Promise<StoredSubscription> { return await request(`/api/hostinger/subscriptions/${encodeURIComponent(externalId)}/entry`, 'POST', {}) as StoredSubscription }
export async function linkHostingerSubscription(externalId: string, subscription: StoredSubscription, mode: 'keep-current' | 'use-provider'): Promise<StoredSubscription> {
  return await request(`/api/hostinger/subscriptions/${encodeURIComponent(externalId)}/link`, 'POST', { subscriptionId: subscription.id, revision: subscription.revision, mode }) as StoredSubscription
}
