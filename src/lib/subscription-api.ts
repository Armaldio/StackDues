import { createSubscription, normalizedTotals, type Subscription } from '../domain/subscriptions.ts'

export type StoredSubscription = Subscription & { revision: number }
export type ImportResult = { subscriptions: StoredSubscription[]; createdIds: string[] }
export const SUBSCRIPTION_EXPORT_FILENAME = 'stackdues-subscriptions.json'

export type SubscriptionRequestFailureKind = 'session' | 'conflict' | 'uncertain' | 'unavailable' | 'rejected'
export class SubscriptionRequestFailure extends Error {
  readonly kind: SubscriptionRequestFailureKind
  constructor(kind: SubscriptionRequestFailureKind, message: string) {
    super(message)
    this.name = 'SubscriptionRequestFailure'
    this.kind = kind
  }
}

/** Serialize only importer-compatible subscription fields; never include server revisions or other record properties. */
export function serializeSubscriptionExport(records: readonly StoredSubscription[]): string {
  if (records.length > 1_000) throw new Error('This export exceeds the 1,000-subscription import limit.')
  const subscriptions = records.map(record => createSubscription(record))
  if (new Set(subscriptions.map(({ id }) => id)).size !== subscriptions.length) throw new Error('This export contains duplicate subscription IDs.')
  normalizedTotals(subscriptions)
  const json = JSON.stringify(subscriptions, null, 2)
  if (new TextEncoder().encode(json).length > 1_048_576) throw new Error('This export exceeds the 1 MB import limit.')
  return json
}

export function parseStoredSubscriptions(value: unknown): StoredSubscription[] {
  if (!Array.isArray(value)) throw new Error('The server returned invalid subscription data. Reload before making changes.')
  const records = value.map((record: unknown) => {
    if (!record || typeof record !== 'object' || !('revision' in record) || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
      throw new Error('The server returned an invalid subscription revision. Reload before making changes.')
    }
    return { ...createSubscription(record as unknown as Subscription), revision: record.revision as number }
  })
  if (new Set(records.map(({ id }) => id)).size !== records.length) throw new Error('The server returned duplicate subscriptions.')
  normalizedTotals(records)
  return records
}

async function request(path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`/api/subscriptions${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000),
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new SubscriptionRequestFailure(method === 'GET' ? 'unavailable' : 'uncertain', method === 'GET'
      ? 'Subscription storage could not be reached. Your displayed records have been kept.'
      : 'The save could not be confirmed. Your draft is still here; check its save status before retrying.')
  }
  if (!response.ok) {
    if (response.status === 401) throw new SubscriptionRequestFailure('session', 'Your session expired. Sign in again to continue. Your draft is still here.')
    if (response.status === 409) throw new SubscriptionRequestFailure('conflict', 'This subscription changed on another device. Your draft is still here; reload the latest version to review it.')
    if (method !== 'GET' && response.status >= 500) throw new SubscriptionRequestFailure('uncertain', 'The save could not be confirmed. Your draft is still here; check its save status before retrying.')
    throw new SubscriptionRequestFailure(response.status >= 500 ? 'unavailable' : 'rejected', 'The ledger request could not be completed. Your displayed records have been kept.')
  }
  try { return await response.json() }
  catch {
    throw new SubscriptionRequestFailure(method === 'GET' ? 'unavailable' : 'uncertain', method === 'GET'
      ? 'The server response could not be read. Reload the ledger before making changes.'
      : 'The save response could not be read. Your draft is still here; check whether your changes were saved before retrying.')
  }
}

export async function fetchSubscriptions(): Promise<StoredSubscription[]> { return parseStoredSubscriptions(await request()) }
export async function createStoredSubscription(subscription: Subscription): Promise<StoredSubscription> {
  return parseStoredSubscriptions([await request('', 'POST', createSubscription(subscription))])[0]!
}
export async function updateStoredSubscription(subscription: Subscription, revision: number): Promise<StoredSubscription> {
  return parseStoredSubscriptions([await request(`/${encodeURIComponent(subscription.id)}`, 'PATCH', { subscription: createSubscription(subscription), revision })])[0]!
}
export async function deleteStoredSubscription(id: string, revision: number): Promise<void> {
  const result = await request(`/${encodeURIComponent(id)}`, 'DELETE', undefined, { 'If-Match': `"${revision}"` })
  if (!result || typeof result !== 'object' || !('deleted' in result) || result.deleted !== true) throw new Error('Deletion could not be confirmed. Reload the ledger before making changes.')
}
export async function importStoredSubscriptions(subscriptions: Subscription[]): Promise<ImportResult> {
  const result = await request('/import', 'POST', { subscriptions: subscriptions.map(createSubscription) })
  if (!result || typeof result !== 'object' || !('subscriptions' in result) || !('createdIds' in result) || !Array.isArray(result.createdIds) || result.createdIds.some(id => typeof id !== 'string')) {
    throw new Error('Import could not be confirmed. Keep your backup and reload subscriptions before making changes.')
  }
  const records = parseStoredSubscriptions(result.subscriptions)
  const ids = new Set(records.map(({ id }) => id))
  const source = new Map(subscriptions.map(record => [record.id, createSubscription(record)]))
  if (subscriptions.some(({ id }) => !ids.has(id)) || result.createdIds.some(id => !ids.has(id) || !source.has(id)) || new Set(result.createdIds).size !== result.createdIds.length) {
    throw new Error('Import could not be verified. Keep your backup and reload subscriptions before making changes.')
  }
  for (const id of result.createdIds as string[]) {
    const stored = records.find(record => record.id === id)!
    if (JSON.stringify(createSubscription(stored)) !== JSON.stringify(source.get(id))) throw new Error('An imported record could not be verified. Keep your backup and reload subscriptions before making changes.')
  }
  return { subscriptions: records, createdIds: result.createdIds as string[] }
}
