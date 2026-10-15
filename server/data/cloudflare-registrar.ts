import { isValidCostTimestamp } from '../../src/domain/usage-costs.ts'
import { LedgerError } from './ledger.ts'
import { normalizeCloudflareRegistration, type CloudflareRegistration } from '../providers/cloudflare-registrar.ts'

export type CloudflareRegistrarSyncState = { status: 'not-configured' | 'synced' | 'error'; lastAttemptAt?: string; lastSyncedAt?: string }
export type DiscoveredCloudflareRegistration = CloudflareRegistration & { seenInLatestSync: boolean }
export type CloudflareRegistrarDiscovery = { registrations: DiscoveredCloudflareRegistration[]; sync: CloudflareRegistrarSyncState }
export type CloudflareRegistrarAttempt = { status: CloudflareRegistrarSyncState['status']; lastAttemptAt: string; registrations?: readonly CloudflareRegistration[] }

type RegistrationRow = { domain_name: string; data_json: string; last_seen_at: string }
type SyncRow = { status: CloudflareRegistrarSyncState['status']; last_attempt_at: string | null; last_synced_at: string | null }

function invalid(): never { throw new LedgerError(400, 'Invalid Cloudflare Registrar discovery data. Previously saved domains were preserved.') }
function storage<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch(cause => { if (cause instanceof LedgerError) throw cause; throw new LedgerError(503, 'Cloudflare Registrar storage is unavailable. Try again later.') })
}
function syncState(row?: SyncRow | null): CloudflareRegistrarSyncState {
  if (!row) return { status: 'not-configured' }
  return { status: row.status, ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}), ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}) }
}
function normalizeStoredRegistration(value: unknown): CloudflareRegistration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const item = value as Record<string, unknown>
  return normalizeCloudflareRegistration({ domain_name: item.domainName, status: item.status, expires_at: item.expiresAt, auto_renew: item.autoRenew })
}

/** Build transactional writes that retain last-known domains on failed or unconfigured reads. */
export function cloudflareRegistrarStatements(db: D1Database, input: CloudflareRegistrarAttempt): D1PreparedStatement[] {
  if (!input || !['not-configured', 'synced', 'error'].includes(input.status) || !isValidCostTimestamp(input.lastAttemptAt)) return invalid()
  const attemptedAt = new Date(input.lastAttemptAt).toISOString()
  let registrations: CloudflareRegistration[] | undefined
  if (input.status === 'synced') {
    if (!Array.isArray(input.registrations) || input.registrations.length > 1000) return invalid()
    try { registrations = input.registrations.map(normalizeStoredRegistration) } catch { return invalid() }
    if (new Set(registrations.map(item => item.domainName)).size !== registrations.length) return invalid()
    if (new TextEncoder().encode(JSON.stringify(registrations)).byteLength > 1024 * 1024) return invalid()
  } else if (input.registrations !== undefined) return invalid()

  const statements: D1PreparedStatement[] = [db.prepare(`INSERT INTO cloudflare_registrar_sync_state (singleton, status, last_attempt_at, last_synced_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET status = excluded.status, last_attempt_at = excluded.last_attempt_at,
      last_synced_at = CASE WHEN excluded.status = 'synced' THEN excluded.last_synced_at ELSE cloudflare_registrar_sync_state.last_synced_at END
    WHERE cloudflare_registrar_sync_state.last_attempt_at IS NULL OR excluded.last_attempt_at >= cloudflare_registrar_sync_state.last_attempt_at`)
    .bind(input.status, attemptedAt, input.status === 'synced' ? attemptedAt : null)]
  if (input.status === 'synced') {
    statements.push(db.prepare(`DELETE FROM cloudflare_registrations WHERE EXISTS (
      SELECT 1 FROM cloudflare_registrar_sync_state WHERE singleton = 1 AND status = 'synced' AND last_attempt_at = ?)`)
      .bind(attemptedAt))
    if (registrations!.length) statements.push(db.prepare(`INSERT INTO cloudflare_registrations (domain_name, data_json, last_seen_at)
      SELECT json_extract(value, '$.domainName'), value, ? FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM cloudflare_registrar_sync_state WHERE singleton = 1 AND status = 'synced' AND last_attempt_at = ?)`)
      .bind(attemptedAt, JSON.stringify(registrations), attemptedAt))
  }
  return statements
}

export async function readCloudflareRegistrarDiscovery(db: D1Database): Promise<CloudflareRegistrarDiscovery> {
  return storage(async () => {
    const [items, state] = await db.batch([
      db.prepare('SELECT domain_name, data_json, last_seen_at FROM cloudflare_registrations ORDER BY domain_name COLLATE NOCASE'),
      db.prepare('SELECT status, last_attempt_at, last_synced_at FROM cloudflare_registrar_sync_state WHERE singleton = 1'),
    ])
    const sync = syncState((state!.results as SyncRow[])[0])
    return {
      registrations: (items!.results as RegistrationRow[]).map(row => ({
        ...normalizeStoredRegistration(JSON.parse(row.data_json)),
        seenInLatestSync: sync.status === 'synced' && !!sync.lastSyncedAt && row.last_seen_at === sync.lastSyncedAt,
      })),
      sync,
    }
  })
}
