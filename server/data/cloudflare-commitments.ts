import { createSubscription, type Subscription } from '../../src/domain/subscriptions.ts'
import { isValidCostTimestamp } from '../../src/domain/usage-costs.ts'
import type { CloudflareCommitment, CloudflareSubscription } from '../providers/cloudflare-subscriptions.ts'
import { LedgerError } from './ledger.ts'

type CommitmentValues = Omit<Subscription, 'id' | 'billingType' | 'provider'>
type SubscriptionRow = {
  id: string
  name: string
  provider: string | null
  amount: number
  currency: string
  recurrence_interval: number
  recurrence_unit: Subscription['recurrenceUnit']
  next_renewal_at: string
  status: Subscription['status']
  revision: number
}
type LinkRow = { external_id: string; subscription_id: string }
type SourceRow = { data_json: string }

const commitmentFields = ['name', 'amount', 'currency', 'recurrenceInterval', 'recurrenceUnit', 'nextRenewalAt', 'status'] as const

function invalid(): never { throw new LedgerError(400, 'Invalid Cloudflare subscription data. Previous commitments were preserved.') }
function normalize(item: CloudflareSubscription): CloudflareSubscription {
  if (!item || typeof item.externalId !== 'string' || !item.externalId.trim() || item.externalId.length > 128
    || !['Trial', 'Provisioned', 'Paid', 'AwaitingPayment', 'Cancelled', 'Failed', 'Expired'].includes(item.state)) return invalid()
  if (item.commitment === null) return item
  try {
    const subscription = createSubscription({ id: item.externalId, provider: 'Cloudflare', billingType: 'fixed', ...item.commitment })
    const active = !['Cancelled', 'Failed', 'Expired'].includes(item.state)
    if (active && subscription.status !== 'active') return invalid()
    if (!active && subscription.status !== 'cancelled') return invalid()
    return { ...item, commitment: {
      name: subscription.name,
      amount: subscription.amount,
      currency: subscription.currency,
      recurrenceInterval: subscription.recurrenceInterval,
      recurrenceUnit: subscription.recurrenceUnit,
      nextRenewalAt: subscription.nextRenewalAt,
      status: item.commitment.status,
    } }
  } catch { return invalid() }
}

function overrides(current: SubscriptionRow, base: CommitmentValues): Partial<CommitmentValues> {
  const currentValues: CommitmentValues = {
    name: current.name,
    amount: current.amount,
    currency: current.currency,
    recurrenceInterval: current.recurrence_interval,
    recurrenceUnit: current.recurrence_unit,
    nextRenewalAt: current.next_renewal_at,
    status: current.status,
  }
  return Object.fromEntries(commitmentFields.filter(field => currentValues[field] !== base[field]).map(field => [field, currentValues[field]])) as Partial<CommitmentValues>
}

function sameFingerprint(row: SubscriptionRow, base: CommitmentValues): boolean {
  return row.amount === base.amount && row.currency === base.currency && row.recurrence_interval === base.recurrenceInterval
    && row.recurrence_unit === base.recurrenceUnit && row.next_renewal_at === base.nextRenewalAt && row.status === base.status
}

/** Returns writes that join provider discovery to the ledger in the same D1 batch as cost sync. */
export async function cloudflareCommitmentStatements(db: D1Database, input: readonly CloudflareSubscription[], syncedAt: string): Promise<D1PreparedStatement[]> {
  if (!isValidCostTimestamp(syncedAt) || !Array.isArray(input) || input.length > 1000) return invalid()
  const items = input.map(normalize)
  if (new Set(items.map(item => item.externalId)).size !== items.length) return invalid()
  const data = items.map(item => ({ ...item, commitment: item.commitment }))
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 1024 * 1024) return invalid()

  const [linksResult, exclusionsResult, manualResult, hostingerLinksResult] = await db.batch([
    db.prepare('SELECT external_id, subscription_id FROM cloudflare_fixed_subscription_links'),
    db.prepare('SELECT external_id FROM cloudflare_fixed_subscription_exclusions'),
    db.prepare('SELECT * FROM manual_subscriptions ORDER BY name, id'),
    db.prepare('SELECT subscription_id FROM hostinger_subscription_links'),
  ])
  const links = linksResult!.results as LinkRow[]
  const linkedExternalIds = new Set(links.map(row => row.external_id))
  const linkedSubscriptionIds = new Set(links.map(row => row.subscription_id))
  const excludedExternalIds = new Set((exclusionsResult!.results as { external_id: string }[]).map(row => row.external_id))
  const hostingerLinkedIds = new Set((hostingerLinksResult!.results as { subscription_id: string }[]).map(row => row.subscription_id))
  const manual = manualResult!.results as SubscriptionRow[]
  const autoCommitments: { externalId: string; subscription: Subscription }[] = []
  const autoLinks: { externalId: string; subscriptionId: string; overrides: Partial<CommitmentValues> }[] = []
  const reservedManualIds = new Set<string>()

  for (const source of items) {
    const base = source.commitment
    if (!base || base.status !== 'active' || linkedExternalIds.has(source.externalId) || excludedExternalIds.has(source.externalId)) continue
    const name = base.name.trim().toLowerCase()
    const candidates = manual.filter(row => !linkedSubscriptionIds.has(row.id) && !hostingerLinkedIds.has(row.id)
      && (!row.provider || row.provider.toLowerCase() === 'cloudflare')
      && (row.name.trim().toLowerCase() === name || sameFingerprint(row, base)))
    if (candidates.length === 1 && !reservedManualIds.has(candidates[0]!.id)) {
      const candidate = candidates[0]!
      autoLinks.push({ externalId: source.externalId, subscriptionId: candidate.id, overrides: overrides(candidate, base) })
      reservedManualIds.add(candidate.id)
      continue
    }
    if (candidates.length > 0) continue
    autoCommitments.push({
      externalId: source.externalId,
      subscription: createSubscription({ id: crypto.randomUUID(), provider: 'Cloudflare', billingType: 'fixed', ...base }),
    })
  }

  const statements: D1PreparedStatement[] = []
  if (data.length) statements.push(db.prepare(`INSERT INTO cloudflare_fixed_subscriptions (external_id, data_json, last_seen_at)
    SELECT json_extract(value, '$.externalId'), value, ? FROM json_each(?) WHERE 1
    ON CONFLICT(external_id) DO UPDATE SET data_json = excluded.data_json, last_seen_at = excluded.last_seen_at`)
    .bind(syncedAt, JSON.stringify(data)))
  if (autoCommitments.length) statements.push(db.prepare(`INSERT INTO manual_subscriptions (id, name, provider, amount, currency, recurrence_interval, recurrence_unit, next_renewal_at, status)
    SELECT json_extract(value, '$.subscription.id'), json_extract(value, '$.subscription.name'), 'Cloudflare', json_extract(value, '$.subscription.amount'), json_extract(value, '$.subscription.currency'),
      json_extract(value, '$.subscription.recurrenceInterval'), json_extract(value, '$.subscription.recurrenceUnit'), json_extract(value, '$.subscription.nextRenewalAt'), json_extract(value, '$.subscription.status')
    FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_links WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_exclusions WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM manual_subscriptions WHERE lower(trim(name)) = lower(trim(json_extract(value, '$.subscription.name'))))`)
    .bind(JSON.stringify(autoCommitments)))
  if (autoCommitments.length) statements.push(db.prepare(`INSERT INTO cloudflare_fixed_subscription_links (external_id, subscription_id, overrides_json, linked_at, automatic)
    SELECT json_extract(value, '$.externalId'), json_extract(value, '$.subscription.id'), '{}', ?, 1 FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = json_extract(value, '$.subscription.id'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_links WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_exclusions WHERE external_id = json_extract(value, '$.externalId'))`)
    .bind(syncedAt, JSON.stringify(autoCommitments)))
  if (autoLinks.length) statements.push(db.prepare(`INSERT INTO cloudflare_fixed_subscription_links (external_id, subscription_id, overrides_json, linked_at, automatic)
    SELECT json_extract(value, '$.externalId'), json_extract(value, '$.subscriptionId'), json_extract(value, '$.overrides'), ?, 0 FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = json_extract(value, '$.subscriptionId'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_links WHERE subscription_id = json_extract(value, '$.subscriptionId'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_links WHERE external_id = json_extract(value, '$.externalId'))
      AND NOT EXISTS (SELECT 1 FROM cloudflare_fixed_subscription_exclusions WHERE external_id = json_extract(value, '$.externalId'))`)
    .bind(syncedAt, JSON.stringify(autoLinks)))
  if (data.length) statements.push(db.prepare(`UPDATE manual_subscriptions AS m SET
    name = COALESCE(json_extract(l.overrides_json, '$.name'), json_extract(c.data_json, '$.commitment.name'), m.name),
    amount = COALESCE(json_extract(l.overrides_json, '$.amount'), json_extract(c.data_json, '$.commitment.amount'), m.amount),
    currency = COALESCE(json_extract(l.overrides_json, '$.currency'), json_extract(c.data_json, '$.commitment.currency'), m.currency),
    recurrence_interval = COALESCE(json_extract(l.overrides_json, '$.recurrenceInterval'), json_extract(c.data_json, '$.commitment.recurrenceInterval'), m.recurrence_interval),
    recurrence_unit = COALESCE(json_extract(l.overrides_json, '$.recurrenceUnit'), json_extract(c.data_json, '$.commitment.recurrenceUnit'), m.recurrence_unit),
    next_renewal_at = COALESCE(json_extract(l.overrides_json, '$.nextRenewalAt'), json_extract(c.data_json, '$.commitment.nextRenewalAt'), m.next_renewal_at),
    status = COALESCE(json_extract(l.overrides_json, '$.status'), json_extract(c.data_json, '$.commitment.status'), 'cancelled'), revision = revision + 1
    FROM cloudflare_fixed_subscription_links l JOIN cloudflare_fixed_subscriptions c ON c.external_id = l.external_id
    WHERE m.id = l.subscription_id AND c.last_seen_at = ?
    AND (m.name IS NOT COALESCE(json_extract(l.overrides_json, '$.name'), json_extract(c.data_json, '$.commitment.name'), m.name) OR
      m.amount IS NOT COALESCE(json_extract(l.overrides_json, '$.amount'), json_extract(c.data_json, '$.commitment.amount'), m.amount) OR
      m.currency IS NOT COALESCE(json_extract(l.overrides_json, '$.currency'), json_extract(c.data_json, '$.commitment.currency'), m.currency) OR
      m.recurrence_interval IS NOT COALESCE(json_extract(l.overrides_json, '$.recurrenceInterval'), json_extract(c.data_json, '$.commitment.recurrenceInterval'), m.recurrence_interval) OR
      m.recurrence_unit IS NOT COALESCE(json_extract(l.overrides_json, '$.recurrenceUnit'), json_extract(c.data_json, '$.commitment.recurrenceUnit'), m.recurrence_unit) OR
      m.next_renewal_at IS NOT COALESCE(json_extract(l.overrides_json, '$.nextRenewalAt'), json_extract(c.data_json, '$.commitment.nextRenewalAt'), m.next_renewal_at) OR
      m.status IS NOT COALESCE(json_extract(l.overrides_json, '$.status'), json_extract(c.data_json, '$.commitment.status'), 'cancelled'))`).bind(syncedAt))
  return statements
}

export async function cloudflareDeleteExclusionStatement(db: D1Database, id: string, expectedRevision: number): Promise<D1PreparedStatement | null> {
  return db.prepare(`INSERT INTO cloudflare_fixed_subscription_exclusions (external_id, excluded_at)
    SELECT external_id, ? FROM cloudflare_fixed_subscription_links WHERE subscription_id = ?
      AND EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = ? AND revision = ?)
    ON CONFLICT(external_id) DO NOTHING`).bind(new Date().toISOString(), id, id, expectedRevision)
}

export async function cloudflareEditStatement(db: D1Database, subscription: Subscription, expectedRevision: number): Promise<D1PreparedStatement | null> {
  const row = await db.prepare(`SELECT c.data_json FROM cloudflare_fixed_subscription_links l
    JOIN cloudflare_fixed_subscriptions c ON c.external_id = l.external_id WHERE l.subscription_id = ?`).bind(subscription.id).first<SourceRow>()
  if (!row) return null
  const source = JSON.parse(row.data_json) as { commitment: CloudflareCommitment | null }
  if (!source.commitment) return null
  const current: SubscriptionRow = {
    id: subscription.id,
    name: subscription.name,
    provider: subscription.provider ?? null,
    amount: subscription.amount,
    currency: subscription.currency,
    recurrence_interval: subscription.recurrenceInterval,
    recurrence_unit: subscription.recurrenceUnit,
    next_renewal_at: subscription.nextRenewalAt,
    status: subscription.status,
    revision: expectedRevision,
  }
  const overridesJson = JSON.stringify(overrides(current, source.commitment))
  return db.prepare(`UPDATE cloudflare_fixed_subscription_links SET overrides_json = ? WHERE subscription_id = ?
    AND EXISTS (SELECT 1 FROM manual_subscriptions WHERE id = ? AND revision = ?)`).bind(overridesJson, subscription.id, subscription.id, expectedRevision + 1)
}
