import { createSubscription, normalizedTotals, type Subscription } from '../../src/domain/subscriptions.ts'
import { isValidCostTimestamp, type CostProvider, type CostSnapshot } from '../../src/domain/usage-costs.ts'
import { emptyCostFeed, parseCostFeed, type CostFeed, type ProviderSyncStatus } from '../../src/lib/cost-feed.ts'

export type StoredSubscription = Subscription & { revision: number }
export const IMPORT_LIMIT = 1000
export class LedgerError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) { super(message); this.name = 'LedgerError'; this.statusCode = statusCode }
}

type SubscriptionRow = {
  id: string; name: string; provider: string | null; amount: number; currency: string
  recurrence_interval: number; recurrence_unit: Subscription['recurrenceUnit']; next_renewal_at: string
  status: Subscription['status']; revision: number
}
type ObservationRow = { id: string; provider: CostProvider; period_start: string; period_end: string; amount: number; currency: string; kind: CostSnapshot['kind']; captured_at: string; metadata_json: string }
type StatusRow = { provider: CostProvider; status: ProviderSyncStatus['status']; last_attempt_at: string | null; last_synced_at: string | null }
const selectSubscriptions = 'SELECT * FROM manual_subscriptions ORDER BY name, id'
const insertSubscription = `INSERT INTO manual_subscriptions (id, name, provider, amount, currency, recurrence_interval, recurrence_unit, next_renewal_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

function validateSubscription(value: unknown): Subscription {
  try {
    const subscription = createSubscription(value as Subscription)
    if ([subscription.id, subscription.name, subscription.provider].some(text => text !== undefined && text.length > 256)) throw new Error('Too long')
    return subscription
  } catch { throw new LedgerError(400, 'Check subscription details, amounts, recurrence and renewal dates.') }
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new LedgerError(400, 'A valid subscription revision is required.')
  return value as number
}
function parameters(subscription: Subscription): (string | number | null)[] {
  return [subscription.id, subscription.name, subscription.provider ?? null, subscription.amount, subscription.currency, subscription.recurrenceInterval, subscription.recurrenceUnit, subscription.nextRenewalAt, subscription.status]
}
function fromRow(row: SubscriptionRow): StoredSubscription {
  const item = createSubscription({ id: row.id, name: row.name, ...(row.provider === null ? {} : { provider: row.provider }), billingType: 'fixed', amount: row.amount, currency: row.currency, recurrenceInterval: row.recurrence_interval, recurrenceUnit: row.recurrence_unit, nextRenewalAt: row.next_renewal_at, status: row.status })
  return { ...item, revision: revision(row.revision) }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    if (error instanceof LedgerError) throw error
    const message = error instanceof Error ? error.message : ''
    if (message.includes('subscription_total_overflow')) throw new LedgerError(400, 'Subscription totals exceed the supported numeric range. Changes were not saved.')
    if (message.includes('immutable_observation_conflict')) throw new LedgerError(409, 'An immutable cost observation already exists with different values.')
    if (message.includes('UNIQUE constraint failed: manual_subscriptions.id')) throw new LedgerError(409, 'This subscription already exists. Reload before editing it.')
    throw new LedgerError(503, 'Private storage is unavailable. Try again later.')
  }
}

export async function listSubscriptions(db: D1Database): Promise<StoredSubscription[]> {
  return storage(async () => {
    const result = await db.prepare(selectSubscriptions).all<SubscriptionRow>()
    const items = result.results.map(fromRow)
    normalizedTotals(items)
    return items
  })
}
export async function createStoredSubscription(db: D1Database, input: unknown): Promise<StoredSubscription> {
  const item = validateSubscription(input)
  return storage(async () => {
    const row = await db.prepare(`${insertSubscription} RETURNING *`).bind(...parameters(item)).first<SubscriptionRow>()
    if (!row) throw new Error('Missing inserted record')
    return fromRow(row)
  })
}
export async function patchStoredSubscription(db: D1Database, id: string, input: unknown, expectedRevision: unknown, afterUpdate?: (item: Subscription, revision: number) => Promise<D1PreparedStatement | null>): Promise<StoredSubscription> {
  const item = validateSubscription(input)
  const expected = revision(expectedRevision)
  if (item.id !== id) throw new LedgerError(400, 'Subscription ID cannot be changed.')
  return storage(async () => {
    const update = db.prepare(`UPDATE manual_subscriptions SET name = ?, provider = ?, amount = ?, currency = ?, recurrence_interval = ?, recurrence_unit = ?, next_renewal_at = ?, status = ?, revision = revision + 1 WHERE id = ? AND revision = ? RETURNING *`)
      .bind(...parameters(item).slice(1), id, expected)
    const override = await afterUpdate?.(item, expected)
    const row = override
      ? (await db.batch<SubscriptionRow>([update, override]))[0]!.results[0]
      : await update.first<SubscriptionRow>()
    if (row) return fromRow(row)
    const exists = await db.prepare('SELECT id FROM manual_subscriptions WHERE id = ?').bind(id).first()
    throw new LedgerError(exists ? 409 : 404, exists ? 'This subscription changed on another device. Reload before editing it.' : 'Subscription was not found.')
  })
}
export async function deleteStoredSubscription(db: D1Database, id: string, expectedRevision: unknown): Promise<{ deleted: true }> {
  const expected = revision(expectedRevision)
  return storage(async () => {
    const result = await db.prepare('DELETE FROM manual_subscriptions WHERE id = ? AND revision = ?').bind(id, expected).run()
    if (result.meta.changes === 1) return { deleted: true }
    const exists = await db.prepare('SELECT id FROM manual_subscriptions WHERE id = ?').bind(id).first()
    throw new LedgerError(exists ? 409 : 404, exists ? 'This subscription changed on another device. Reload before deleting it.' : 'Subscription was not found.')
  })
}
export async function importSubscriptions(db: D1Database, input: unknown): Promise<{ subscriptions: StoredSubscription[]; createdIds: string[] }> {
  if (!Array.isArray(input) || input.length > IMPORT_LIMIT) throw new LedgerError(400, `Import must contain at most ${IMPORT_LIMIT} subscriptions.`)
  const items = input.map(validateSubscription)
  if (new Set(items.map(item => item.id)).size !== items.length) throw new LedgerError(400, 'Imported subscriptions contain duplicate IDs.')
  try { normalizedTotals(items) } catch { throw new LedgerError(400, 'Imported subscription totals exceed the supported numeric range.') }
  return storage(async () => {
    // Two statements regardless of import size; stay within D1 invocation query limits.
    const insertion = db.prepare(`INSERT INTO manual_subscriptions (id, name, provider, amount, currency, recurrence_interval, recurrence_unit, next_renewal_at, status)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.provider'), json_extract(value, '$.amount'), json_extract(value, '$.currency'), json_extract(value, '$.recurrenceInterval'), json_extract(value, '$.recurrenceUnit'), json_extract(value, '$.nextRenewalAt'), json_extract(value, '$.status')
      FROM json_each(?) WHERE 1 ON CONFLICT(id) DO NOTHING RETURNING id`).bind(JSON.stringify(items))
    const results = await db.batch<SubscriptionRow>([insertion, db.prepare(selectSubscriptions)])
    const subscriptions = results[1]!.results.map(fromRow)
    const created = new Set(results[0]!.results.map(row => row.id))
    return { subscriptions, createdIds: items.filter(item => created.has(item.id)).map(item => item.id) }
  })
}

export async function readCostFeed(db: D1Database): Promise<CostFeed> {
  return storage(async () => {
    const [observations, statuses] = await db.batch([
      db.prepare('SELECT * FROM cost_observations ORDER BY captured_at, id'),
      db.prepare('SELECT * FROM provider_sync_status'),
    ])
    const providers = { ...emptyCostFeed().providers }
    for (const row of statuses!.results as StatusRow[]) providers[row.provider] = {
      status: row.status, ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}), ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
    }
    return parseCostFeed({ providers, snapshots: (observations!.results as ObservationRow[]).map(row => ({ id: row.id, provider: row.provider, periodStart: row.period_start, periodEnd: row.period_end, amount: row.amount, currency: row.currency, kind: row.kind, capturedAt: row.captured_at, metadata: JSON.parse(row.metadata_json) })) })
  })
}

/** Each provider's observations and status commit together. Errors never replace its last success. */
export async function persistProviderSync(db: D1Database, provider: CostProvider, input: readonly CostSnapshot[], status: ProviderSyncStatus): Promise<void> {
  if (!['aws', 'cloudflare'].includes(provider) || !isValidCostTimestamp(status.lastAttemptAt) || !['not-configured', 'synced', 'error'].includes(status.status)) throw new LedgerError(400, 'Invalid provider sync state.')
  const attemptedAt = new Date(status.lastAttemptAt).toISOString()
  if (status.status === 'synced' && (!isValidCostTimestamp(status.lastSyncedAt) || Date.parse(status.lastSyncedAt) !== Date.parse(attemptedAt))) throw new LedgerError(400, 'Invalid successful sync timestamp.')
  let snapshots: readonly CostSnapshot[]
  try {
    snapshots = parseCostFeed({ ...emptyCostFeed(), snapshots: input }).snapshots
    if (snapshots.some(row => row.provider !== provider) || (status.status !== 'synced' && snapshots.length)) throw new Error('Invalid collection')
  } catch { throw new LedgerError(400, 'Invalid provider observations. Previous history was preserved.') }
  await storage(async () => {
    const statements = snapshots.map(row => db.prepare(`INSERT INTO cost_observations (id, provider, period_start, period_end, amount, currency, kind, captured_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(row.id, row.provider, row.periodStart, row.periodEnd, row.amount, row.currency, row.kind, new Date(row.capturedAt).toISOString(), JSON.stringify(row.metadata ?? {})))
    statements.push(db.prepare(`INSERT INTO provider_sync_status (provider, status, last_attempt_at, last_synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET status = excluded.status, last_attempt_at = excluded.last_attempt_at, last_synced_at = CASE WHEN excluded.status = 'synced' THEN excluded.last_synced_at ELSE provider_sync_status.last_synced_at END WHERE provider_sync_status.last_attempt_at IS NULL OR excluded.last_attempt_at >= provider_sync_status.last_attempt_at`)
      .bind(provider, status.status, attemptedAt, status.status === 'synced' ? attemptedAt : null))
    await db.batch(statements)
  })
}
