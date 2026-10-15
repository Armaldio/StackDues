export type CloudflareRegistration = { domainName: string; status: string; expiresAt: string | null; autoRenew: boolean; seenInLatestSync: boolean }
export type CloudflareRegistrarDiscovery = {
  registrations: CloudflareRegistration[]
  sync: { status: 'not-configured' | 'synced' | 'error'; lastAttemptAt?: string; lastSyncedAt?: string }
}

export class CloudflareRegistrarApiError extends Error {
  constructor(message: string, public readonly status?: number) { super(message) }
}

export async function readCloudflareRegistrarDiscovery(): Promise<CloudflareRegistrarDiscovery> {
  let response: Response
  try { response = await fetch('/api/cloudflare/registrar', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000) }) }
  catch { throw new CloudflareRegistrarApiError('Cloudflare domain renewals could not be loaded. Previously saved details remain available.') }
  if (!response.ok) {
    if (response.status === 401) throw new CloudflareRegistrarApiError('Your session expired. Sign in again, then reload.', 401)
    throw new CloudflareRegistrarApiError('Cloudflare domain renewals could not be loaded. Previously saved details remain available.', response.status)
  }
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || !('registrations' in value) || !Array.isArray(value.registrations) || !('sync' in value)) throw new Error('Invalid response')
    return value as CloudflareRegistrarDiscovery
  } catch { throw new CloudflareRegistrarApiError('Cloudflare domain renewal data could not be checked. Reload before relying on it.') }
}
