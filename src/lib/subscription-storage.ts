import { createSubscription, normalizedTotals, type Subscription } from '../domain/subscriptions.ts'

export const STORAGE_KEY = 'ledger.subscriptions.v1'
export type LedgerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type StorageResult = { subscriptions: Subscription[]; error: string | null; blocked: boolean }

/** Validate the entire saved ledger before accepting any of it. Never discard damaged records. */
export function loadSubscriptions(storage: LedgerStorage): StorageResult {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { subscriptions: [], error: null, blocked: false }
    const saved: unknown = JSON.parse(raw)
    if (!Array.isArray(saved)) throw new Error('Invalid ledger')
    const subscriptions = saved.map((record) => createSubscription(record as Subscription))
    if (new Set(subscriptions.map(({ id }) => id)).size !== subscriptions.length) throw new Error('Duplicate ids')
    normalizedTotals(subscriptions)
    return { subscriptions, error: null, blocked: false }
  } catch {
    return { subscriptions: [], error: 'Saved subscriptions could not be read. Your saved data has been left untouched. Restore browser storage or recover the saved ledger before making changes.', blocked: true }
  }
}

export function saveSubscriptions(storage: LedgerStorage, subscriptions: Subscription[]): string | null {
  if (loadSubscriptions(storage).blocked) return 'Saved subscriptions could not be read. Changes were not saved.'
  let validated: Subscription[]
  try {
    validated = subscriptions.map(createSubscription)
    if (new Set(validated.map(({ id }) => id)).size !== validated.length) throw new Error('Duplicate ids')
    normalizedTotals(validated)
  } catch (cause) {
    return `Check subscription amounts and recurrence intervals. ${cause instanceof Error ? cause.message : 'Invalid subscription details.'} Changes were not saved.`
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(validated))
    return null
  } catch {
    return 'Changes could not be saved in this browser. Check available storage and try again.'
  }
}
