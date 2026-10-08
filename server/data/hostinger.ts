import { createSubscription, type RecurrenceUnit, type Subscription, type SubscriptionStatus } from '../../src/domain/subscriptions.ts'
import { loadProviderCredentials } from '../security/provider-credentials.ts'
import { fetchHostingerSubscriptions, type HostingerSubscription } from '../providers/hostinger.ts'
import { LedgerError, type StoredSubscription } from './ledger.ts'

export type HostingerSyncState = { status: 'not-configured' | 'synced' | 'error'; lastAttemptAt?: string; lastSyncedAt?: string }
export type DiscoveredHostingerSubscription = Omit<HostingerSubscription, 'raw'> & {
  linkedSubscriptionId: string | null
  automaticallyLinked: boolean
  excluded: boolean
  possibleMatches: { id: string; name: string }[]
  providerNameCollision: boolean
  seenInLatestSync: boolean
  renewalAvailable: boolean
  upcomingCommitment: number | null
}
export type HostingerDiscovery = { subscriptions: DiscoveredHostingerSubscription[]; sync: HostingerSyncState }
type HostingerRow = { external_id: string; data_json: string; last_seen_at: string }
type SubscriptionRow = { id: string; name: string; provider: string | null; amount: number; currency: string; recurrence_interval: number; recurrence_unit: RecurrenceUnit; next_renewal_at: string; status: SubscriptionStatus; revision: number }
type SyncRow = { status: HostingerSyncState['status']; last_attempt_at: string | null; last_synced_at: string | null }
type CommitmentValues = Omit<Subscription, 'id' | 'billingType' | 'provider'>
type Commitment = CommitmentValues | { status: 'cancelled' }
const initialCommitmentFields = ['name', 'amount', 'currency', 'recurrenceInterval', 'recurrenceUnit', 'nextRenewalAt', 'status'] as const
const listSQL = `SELECT h.external_id, h.data_json, h.last_seen_at, l.subscription_id AS linked_subscription_id, l.automatic AS automatically_linked,
  e.external_id AS excluded_external_id FROM hostinger_subscriptions h LEFT JOIN hostinger_subscription_links l ON l.external_id = h.external_id
  LEFT JOIN hostinger_subscription_exclusions e ON e.external_id = h.external_id ORDER BY json_extract(h.data_json, '$.name'), h.external_id`

function error(status: number, message: string): never { throw new LedgerError(status, message) }
function storage<T>(promise: Promise<T>): Promise<T> {
  return promise.catch(cause => { if (cause instanceof LedgerError) throw cause; throw new LedgerError(503, 'Hostinger subscription storage is unavailable. Try again later.') })
}
function commitment(item: HostingerSubscription): Commitment | null {
  if (item.recurrenceInterval === null || !item.recurrenceUnit || item.recurrenceUnit === 'unsupported') return null
  const recurring = item.isAutoRenewed && ['active', 'in_trial', 'paused'].includes(item.status)
  if (!recurring) return { status: 'cancelled' }
  const nextRenewalAt = item.nextBillingDate
  if (item.renewalPrice === null || !nextRenewalAt) return { status: 'cancelled' }
  return { name: item.name, amount: item.renewalPrice, currency: item.currency, recurrenceInterval: item.recurrenceInterval, recurrenceUnit: item.recurrenceUnit, nextRenewalAt, status: item.status === 'paused' ? 'paused' : 'active' }
}
function fullCommitment(value: Commitment | null): value is CommitmentValues { return value !== null && 'amount' in value && 'nextRenewalAt' in value }
function validSubscription(row: SubscriptionRow): StoredSubscription {
  return { ...createSubscription({ id: row.id, name: row.name, provider: row.provider ?? undefined, billingType: 'fixed', amount: row.amount, currency: row.currency, recurrenceInterval: row.recurrence_interval, recurrenceUnit: row.recurrence_unit, nextRenewalAt: row.next_renewal_at, status: row.status }), revision: row.revision }
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) return error(400, 'A valid subscription revision is required.')
  return value as number
}
function apiItem(row: HostingerRow & { automatically_linked?: number; excluded_external_id?: string | null }, linkedId: string | null, lastSyncedAt?: string, currentSyncSucceeded = false, possibleMatches: { id: string; name: string }[] = [], providerNameCollision = false): DiscoveredHostingerSubscription {
  const item = JSON.parse(row.data_json) as Omit<HostingerSubscription, 'raw'>
  const base = commitment(item as HostingerSubscription)
  return { ...item, linkedSubscriptionId: linkedId, automaticallyLinked: row.automatically_linked === 1, excluded: !!row.excluded_external_id, possibleMatches, providerNameCollision, seenInLatestSync: currentSyncSucceeded && !!lastSyncedAt && row.last_seen_at === lastSyncedAt, renewalAvailable: fullCommitment(base), upcomingCommitment: fullCommitment(base) ? base.amount : null }
}
function syncState(row?: SyncRow | null): HostingerSyncState {
  if (!row) return { status: 'not-configured' }
  return { status: row.status, ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}), ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}) }
}

export async function readHostingerDiscovery(db: D1Database): Promise<HostingerDiscovery> {
  return storage((async () => {
    const [items, state, ledger] = await db.batch([db.prepare(listSQL), db.prepare('SELECT status, last_attempt_at, last_synced_at FROM hostinger_sync_state WHERE singleton = 1'), db.prepare('SELECT * FROM manual_subscriptions ORDER BY name, id')])
    const sync = syncState((state!.results as SyncRow[])[0])
    const rows = items!.results as (HostingerRow & { linked_subscription_id: string | null; automatically_linked?: number; excluded_external_id?: string | null })[]
    const manual = ledger!.results as SubscriptionRow[]
    const providerNames = new Map<string, number>()
    for (const row of rows) {
      const item = JSON.parse(row.data_json) as HostingerSubscription & { commitment: Commitment | null }
      if (fullCommitment(item.commitment) && item.isAutoRenewed && ['active', 'in_trial', 'paused'].includes(item.status)) {
        const key = item.name.trim().toLowerCase()
        providerNames.set(key, (providerNames.get(key) ?? 0) + 1)
      }
    }
    return { subscriptions: rows.map(row => {
      const source = JSON.parse(row.data_json) as HostingerSubscription & { commitment: Commitment | null }
      const name = source.name.trim().toLowerCase()
      const possibleMatches = manual.filter(item => item.id !== row.linked_subscription_id && (
        item.name.trim().toLowerCase() === name || fullCommitment(source.commitment) && item.amount === source.commitment.amount && item.currency === source.commitment.currency && item.recurrence_interval === source.commitment.recurrenceInterval && item.recurrence_unit === source.commitment.recurrenceUnit && item.next_renewal_at === source.commitment.nextRenewalAt && item.status === source.commitment.status
      )).map(item => ({ id: item.id, name: item.name }))
      return apiItem(row, row.linked_subscription_id, sync.lastSyncedAt, sync.status === 'synced', possibleMatches, (providerNames.get(name) ?? 0) > 1)
    }), sync }
  })())
}

function parseCommitment(data: string): Commitment | null {
  const parsed = JSON.parse(data) as { commitment: Commitment | null }
  return parsed.commitment
}
export async function createHostingerLedgerEntry(db: D1Database, externalId: string): Promise<StoredSubscription> {
  if (typeof externalId !== 'string' || externalId.length > 128) return error(400, 'A valid Hostinger subscription ID is required.')
  return storage((async () => {
    const row = await db.prepare('SELECT external_id, data_json, last_seen_at FROM hostinger_subscriptions WHERE external_id = ?').bind(externalId).first<HostingerRow>()
    if (!row) return error(404, 'Refresh Hostinger subscriptions before adding this service.')
    const base = parseCommitment(row.data_json)
    const data = JSON.parse(row.data_json) as { status: string; externalId: string }
    if (!fullCommitment(base) || !['active', 'in_trial', 'paused'].includes(data.status)) return error(400, 'This Hostinger service has no supported upcoming recurring charge. Add a manual entry if needed.')
    const id = crypto.randomUUID()
    const item = createSubscription({ id, provider: 'Hostinger', billingType: 'fixed', ...base })
    const link = await db.prepare('SELECT subscription_id FROM hostinger_subscription_links WHERE external_id = ?').bind(externalId).first()
    if (link) return error(409, 'This Hostinger service already has a ledger entry. Reload to see it.')
    let queries: D1Result<unknown>[]
    try { queries = await db.batch([
      db.prepare(`INSERT INTO manual_subscriptions (id, name, provider, amount, currency, recurrence_interval, recurrence_unit, next_renewal_at, status)
        SELECT ?, ?, 'Hostinger', ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM manual_subscriptions WHERE lower(trim(name)) = lower(trim(?))) RETURNING *`)
        .bind(item.id, item.name, item.amount, item.currency, item.recurrenceInterval, item.recurrenceUnit, item.nextRenewalAt, item.status, item.name),
      db.prepare(`INSERT INTO hostinger_subscription_links (external_id, subscription_id, overrides_json, linked_at)
        SELECT ?, ?, '{}', ? WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = ?)`)
        .bind(externalId, id, new Date().toISOString(), id),
    ]) } catch (cause) {
      const link = await db.prepare('SELECT subscription_id FROM hostinger_subscription_links WHERE external_id = ?').bind(externalId).first()
      if (link) return error(409, 'This Hostinger service already has a ledger entry. Reload to see it.')
      throw cause
    }
    const subscription = queries[0]!.results[0] as unknown as SubscriptionRow | undefined
    if (!subscription) return error(409, 'This Hostinger service already has a ledger entry. Reload to see it.')
    return validSubscription(subscription)
  })())
}

export async function linkHostingerToLedger(db: D1Database, externalId: string, subscriptionId: string, expectedRevisionInput: unknown, mode: unknown): Promise<StoredSubscription> {
  if (typeof externalId !== 'string' || externalId.length > 128 || typeof subscriptionId !== 'string' || subscriptionId.length > 256) return error(400, 'Choose a valid Hostinger service and ledger subscription.')
  const expected = revision(expectedRevisionInput)
  if (mode !== 'keep-current' && mode !== 'use-provider') return error(400, 'Choose whether to keep the current ledger values or apply Hostinger values.')
  return storage((async () => {
    const [providerRow, manualRow] = await Promise.all([
      db.prepare('SELECT external_id, data_json, last_seen_at FROM hostinger_subscriptions WHERE external_id = ?').bind(externalId).first<HostingerRow>(),
      db.prepare('SELECT * FROM manual_subscriptions WHERE id = ?').bind(subscriptionId).first<SubscriptionRow>(),
    ])
    if (!providerRow || !manualRow) return error(404, 'Refresh Hostinger and reload the ledger before linking.')
    const base = parseCommitment(providerRow.data_json)
    const data = JSON.parse(providerRow.data_json) as { status: string }
    if (!fullCommitment(base) || !['active', 'in_trial', 'paused'].includes(data.status)) return error(400, 'This Hostinger service has no supported upcoming recurring charge.')
    const current = validSubscription(manualRow)
    const next = mode === 'use-provider' ? { ...current, ...base, provider: 'Hostinger' } : current
    const item = createSubscription(next)
    const changes = db.batch([
      db.prepare('UPDATE manual_subscriptions SET name = ?, provider = ?, amount = ?, currency = ?, recurrence_interval = ?, recurrence_unit = ?, next_renewal_at = ?, status = ?, revision = revision + 1 WHERE id = ? AND revision = ? RETURNING *')
        .bind(item.name, 'Hostinger', item.amount, item.currency, item.recurrenceInterval, item.recurrenceUnit, item.nextRenewalAt, item.status, subscriptionId, expected),
      db.prepare(`INSERT INTO hostinger_subscription_links (external_id, subscription_id, overrides_json, linked_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = ? AND revision = ?)`)
        .bind(externalId, subscriptionId, JSON.stringify(mode === 'keep-current' ? Object.fromEntries(initialCommitmentFields.map(field => [field, current[field]])) : {}), new Date().toISOString(), subscriptionId, expected + 1),
    ])
    let results: D1Result<unknown>[]
    try { results = await changes }
    catch (cause) {
      const [externalLink, manualLink] = await Promise.all([
        db.prepare('SELECT subscription_id FROM hostinger_subscription_links WHERE external_id = ?').bind(externalId).first(),
        db.prepare('SELECT external_id FROM hostinger_subscription_links WHERE subscription_id = ?').bind(subscriptionId).first(),
      ])
      if (externalLink || manualLink) return error(409, 'This Hostinger service or ledger entry is already linked. Reload before trying again.')
      throw cause
    }
    const row = results[0]!.results[0] as unknown as SubscriptionRow | undefined
    if (!row) return error(409, 'The ledger subscription changed. Reload before linking.')
    return validSubscription(row)
  })())
}

export async function setHostingerExclusion(db: D1Database, externalId: string, excluded: unknown): Promise<{ excluded: boolean }> {
  if (typeof externalId !== 'string' || externalId.length > 128 || typeof excluded !== 'boolean') return error(400, 'Choose a valid Hostinger service and exclusion state.')
  return storage((async () => {
    const exists = await db.prepare('SELECT external_id FROM hostinger_subscriptions WHERE external_id = ?').bind(externalId).first()
    if (!exists) return error(404, 'Refresh Hostinger subscriptions before changing this service.')
    const linked = await db.prepare('SELECT subscription_id, automatic FROM hostinger_subscription_links WHERE external_id = ?').bind(externalId).first<{ subscription_id: string; automatic: number }>()
    const statements: D1PreparedStatement[] = []
    if (excluded) {
      statements.push(db.prepare('INSERT INTO hostinger_subscription_exclusions (external_id, excluded_at) VALUES (?, ?) ON CONFLICT(external_id) DO UPDATE SET excluded_at = excluded.excluded_at').bind(externalId, new Date().toISOString()))
      if (linked?.automatic) statements.push(db.prepare('DELETE FROM manual_subscriptions WHERE id = ?').bind(linked.subscription_id))
      else if (linked) statements.push(db.prepare('DELETE FROM hostinger_subscription_links WHERE external_id = ?').bind(externalId))
    } else statements.push(db.prepare('DELETE FROM hostinger_subscription_exclusions WHERE external_id = ?').bind(externalId))
    await db.batch(statements)
    return { excluded }
  })())
}

export async function hostingerDeleteExclusionStatement(db: D1Database, id: string, expectedRevision: number): Promise<D1PreparedStatement | null> {
  return db.prepare(`INSERT INTO hostinger_subscription_exclusions (external_id, excluded_at)
    SELECT external_id, ? FROM hostinger_subscription_links WHERE subscription_id = ?
      AND EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = ? AND revision = ?) ON CONFLICT(external_id) DO NOTHING`)
    .bind(new Date().toISOString(), id, id, expectedRevision)
}

export async function hostingerEditStatement(db: D1Database, subscription: Subscription, expectedRevision: number): Promise<D1PreparedStatement | null> {
  const row = await db.prepare(`SELECT h.data_json FROM hostinger_subscription_links l JOIN hostinger_subscriptions h ON h.external_id = l.external_id WHERE l.subscription_id = ?`).bind(subscription.id).first<{ data_json: string }>()
  if (!row) return null
  const base = (JSON.parse(row.data_json) as { commitment: Commitment | null }).commitment
  const changed: Partial<CommitmentValues> = {}
  for (const field of initialCommitmentFields) {
    const providerValue = fullCommitment(base) ? base[field] : field === 'status' ? base?.status : undefined
    if (providerValue === undefined || subscription[field] !== providerValue) Object.assign(changed, { [field]: subscription[field] })
  }
  return db.prepare(`UPDATE hostinger_subscription_links SET overrides_json = ? WHERE subscription_id = ? AND EXISTS (
    SELECT 1 FROM manual_subscriptions WHERE id = ? AND revision = ? AND name = ? AND provider IS ? AND amount = ? AND currency = ?
      AND recurrence_interval = ? AND recurrence_unit = ? AND next_renewal_at = ? AND status = ?
  )`).bind(JSON.stringify(changed), subscription.id, subscription.id, expectedRevision + 1, subscription.name, subscription.provider ?? null, subscription.amount, subscription.currency, subscription.recurrenceInterval, subscription.recurrenceUnit, subscription.nextRenewalAt, subscription.status)
}

export async function refreshHostingerEntries(db: D1Database, encryptionKey: string | undefined, now = new Date(), fetcher?: typeof fetch): Promise<HostingerDiscovery> {
  let configured = false
  let records: HostingerSubscription[] = []
  try {
    const credentials = await loadProviderCredentials(db, 'hostinger', encryptionKey)
    configured = credentials !== null
    if (credentials) records = await fetchHostingerSubscriptions(credentials.apiToken, { fetch: fetcher })
  } catch {
    const last = await storage(db.prepare('SELECT last_synced_at FROM hostinger_sync_state WHERE singleton = 1').first<{ last_synced_at: string | null }>())
    await storage(db.prepare(`INSERT INTO hostinger_sync_state (singleton, status, last_attempt_at, last_synced_at) VALUES (1, 'error', ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET status = 'error', last_attempt_at = excluded.last_attempt_at`).bind(now.toISOString(), last?.last_synced_at ?? null).run())
    return error(502, 'Hostinger refresh failed. Previous provider data and commitments remain available. Check the saved token and retry.')
  }
  const at = now.toISOString()
    const data = records.map(item => ({ ...item, commitment: commitment(item) }))
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024) return error(502, 'Hostinger data is too large to store. Previous data was kept.')
  const statements: D1PreparedStatement[] = []
  if (data.length) statements.push(db.prepare(`INSERT INTO hostinger_subscriptions (external_id, data_json, raw_json, last_seen_at)
    SELECT json_extract(value, '$.externalId'), json_remove(value, '$.raw'), json_extract(value, '$.raw'), ? FROM json_each(?) WHERE 1
    ON CONFLICT(external_id) DO UPDATE SET data_json = excluded.data_json, raw_json = excluded.raw_json, last_seen_at = excluded.last_seen_at`).bind(at, JSON.stringify(data)))
  // Include eligible renewals automatically unless a likely manual counterpart needs an explicit link.
  const [linkRows, exclusionRows, manualRows] = await db.batch([
    db.prepare('SELECT external_id, subscription_id FROM hostinger_subscription_links'),
    db.prepare('SELECT external_id FROM hostinger_subscription_exclusions'),
    db.prepare('SELECT * FROM manual_subscriptions'),
  ])
  const existingLinks = linkRows!.results as { external_id: string; subscription_id: string }[]
  const linkedIds = new Set(existingLinks.map(row => row.external_id))
  const linkedSubscriptionIds = new Set(existingLinks.map(row => row.subscription_id))
  const excludedIds = new Set((exclusionRows!.results as { external_id: string }[]).map(row => row.external_id))
  const manual = manualRows!.results as SubscriptionRow[]
  const providerNames = new Map<string, number>()
  for (const item of data) {
    if (fullCommitment(item.commitment) && item.isAutoRenewed && ['active', 'in_trial', 'paused'].includes(item.status)) {
      const key = item.name.trim().toLowerCase()
      providerNames.set(key, (providerNames.get(key) ?? 0) + 1)
    }
  }
  const autoCommitments: { externalId: string; subscription: Subscription }[] = []
  const autoLinks: { externalId: string; subscriptionId: string; overrides: Partial<CommitmentValues> }[] = []
  const reservedManualIds = new Set<string>()
  for (const item of data) {
    const base = item.commitment
    if (!fullCommitment(base) || !['active', 'in_trial', 'paused'].includes(item.status)) continue
    const normalizedName = item.name.trim().toLowerCase()
    if (linkedIds.has(item.externalId) || excludedIds.has(item.externalId) || (providerNames.get(normalizedName) ?? 0) > 1) continue
    const candidates = manual.filter(row => (
      row.name.trim().toLowerCase() === normalizedName || row.amount === base.amount && row.currency === base.currency && row.recurrence_interval === base.recurrenceInterval && row.recurrence_unit === base.recurrenceUnit && row.next_renewal_at === base.nextRenewalAt && row.status === base.status
    ))
    if (candidates.length) {
      if (candidates.length === 1) {
        const candidate = candidates[0]!
        const exact = candidate.amount === base.amount && candidate.currency === base.currency && candidate.recurrence_interval === base.recurrenceInterval && candidate.recurrence_unit === base.recurrenceUnit && candidate.next_renewal_at === base.nextRenewalAt && candidate.status === base.status
        if (exact && !linkedSubscriptionIds.has(candidate.id) && !reservedManualIds.has(candidate.id)) {
          const current = validSubscription(candidate)
          autoLinks.push({ externalId: item.externalId, subscriptionId: current.id, overrides: Object.fromEntries(initialCommitmentFields.map(field => [field, current[field]])) })
          reservedManualIds.add(candidate.id)
        }
      }
      continue
    }
    const subscription = createSubscription({ id: crypto.randomUUID(), provider: 'Hostinger', billingType: 'fixed', ...base })
    autoCommitments.push({ externalId: item.externalId, subscription })
  }
  if (autoCommitments.length) statements.push(db.prepare(`INSERT INTO manual_subscriptions (id, name, provider, amount, currency, recurrence_interval, recurrence_unit, next_renewal_at, status)
    SELECT json_extract(value, '$.subscription.id'), json_extract(value, '$.subscription.name'), 'Hostinger', json_extract(value, '$.subscription.amount'), json_extract(value, '$.subscription.currency'),
      json_extract(value, '$.subscription.recurrenceInterval'), json_extract(value, '$.subscription.recurrenceUnit'), json_extract(value, '$.subscription.nextRenewalAt'), json_extract(value, '$.subscription.status')
    FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM hostinger_subscription_links WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM hostinger_subscription_exclusions WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM manual_subscriptions WHERE lower(trim(name)) = lower(trim(json_extract(value, '$.subscription.name'))))`)
    .bind(JSON.stringify(autoCommitments)))
  if (autoCommitments.length) statements.push(db.prepare(`INSERT INTO hostinger_subscription_links (external_id, subscription_id, overrides_json, linked_at, automatic)
    SELECT json_extract(value, '$.externalId'), json_extract(value, '$.subscription.id'), '{}', ?, 1 FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = json_extract(value, '$.subscription.id'))
      AND NOT EXISTS (SELECT 1 FROM hostinger_subscription_links WHERE external_id = json_extract(value, '$.externalId'))`)
    .bind(at, JSON.stringify(autoCommitments)))
  if (autoLinks.length) statements.push(db.prepare(`INSERT INTO hostinger_subscription_links (external_id, subscription_id, overrides_json, linked_at, automatic)
    SELECT json_extract(value, '$.externalId'), json_extract(value, '$.subscriptionId'), json_extract(value, '$.overrides'), ?, 0 FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = json_extract(value, '$.subscriptionId'))
      AND NOT EXISTS (SELECT 1 FROM hostinger_subscription_links WHERE subscription_id = json_extract(value, '$.subscriptionId'))
      AND NOT EXISTS (SELECT 1 FROM hostinger_subscription_links WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM hostinger_subscription_exclusions WHERE external_id = json_extract(value, '$.externalId'))`)
    .bind(at, JSON.stringify(autoLinks)))
  statements.push(db.prepare(`UPDATE manual_subscriptions AS m SET
    name = COALESCE(json_extract(l.overrides_json, '$.name'), json_extract(h.data_json, '$.commitment.name'), m.name),
    amount = COALESCE(json_extract(l.overrides_json, '$.amount'), json_extract(h.data_json, '$.commitment.amount'), m.amount),
    currency = COALESCE(json_extract(l.overrides_json, '$.currency'), json_extract(h.data_json, '$.commitment.currency'), m.currency),
    recurrence_interval = COALESCE(json_extract(l.overrides_json, '$.recurrenceInterval'), json_extract(h.data_json, '$.commitment.recurrenceInterval'), m.recurrence_interval),
    recurrence_unit = COALESCE(json_extract(l.overrides_json, '$.recurrenceUnit'), json_extract(h.data_json, '$.commitment.recurrenceUnit'), m.recurrence_unit),
    next_renewal_at = COALESCE(json_extract(l.overrides_json, '$.nextRenewalAt'), json_extract(h.data_json, '$.commitment.nextRenewalAt'), m.next_renewal_at),
    status = COALESCE(json_extract(l.overrides_json, '$.status'), json_extract(h.data_json, '$.commitment.status'), 'cancelled'), revision = revision + 1
    FROM hostinger_subscription_links l JOIN hostinger_subscriptions h ON h.external_id = l.external_id
    WHERE m.id = l.subscription_id AND h.last_seen_at = ?
    AND (
      m.name IS NOT COALESCE(json_extract(l.overrides_json, '$.name'), json_extract(h.data_json, '$.commitment.name'), m.name) OR
      m.amount IS NOT COALESCE(json_extract(l.overrides_json, '$.amount'), json_extract(h.data_json, '$.commitment.amount'), m.amount) OR
      m.currency IS NOT COALESCE(json_extract(l.overrides_json, '$.currency'), json_extract(h.data_json, '$.commitment.currency'), m.currency) OR
      m.recurrence_interval IS NOT COALESCE(json_extract(l.overrides_json, '$.recurrenceInterval'), json_extract(h.data_json, '$.commitment.recurrenceInterval'), m.recurrence_interval) OR
      m.recurrence_unit IS NOT COALESCE(json_extract(l.overrides_json, '$.recurrenceUnit'), json_extract(h.data_json, '$.commitment.recurrenceUnit'), m.recurrence_unit) OR
      m.next_renewal_at IS NOT COALESCE(json_extract(l.overrides_json, '$.nextRenewalAt'), json_extract(h.data_json, '$.commitment.nextRenewalAt'), m.next_renewal_at) OR
      m.status IS NOT COALESCE(json_extract(l.overrides_json, '$.status'), json_extract(h.data_json, '$.commitment.status'), 'cancelled')
    )`).bind(at))
  statements.push(db.prepare(`INSERT INTO hostinger_sync_state (singleton, status, last_attempt_at, last_synced_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET status = excluded.status, last_attempt_at = excluded.last_attempt_at, last_synced_at = excluded.last_synced_at`)
    .bind(configured ? 'synced' : 'not-configured', at, configured ? at : null))
  await storage(db.batch(statements))
  return readHostingerDiscovery(db)
}
