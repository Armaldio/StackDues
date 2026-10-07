export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year'
export type SubscriptionStatus = 'active' | 'paused' | 'cancelled'

/** A fixed commitment. Metered provider spend belongs in a separate model. */
export type Subscription = {
  id: string
  name: string
  provider?: string
  billingType: 'fixed'
  amount: number
  currency: string
  recurrenceInterval: number
  recurrenceUnit: RecurrenceUnit
  /** Original recurrence anchor, as a UTC calendar date (YYYY-MM-DD). */
  nextRenewalAt: string
  status: SubscriptionStatus
}

export type NormalizedCost = { monthly: number; yearly: number }
export type CurrencyTotal = NormalizedCost & { currency: string }
export type Renewal = { subscription: Subscription; date: string; amount: number; currency: string }

const DAY_MS = 86_400_000
const YEAR_FREQUENCY: Record<RecurrenceUnit, number> = { day: 365, week: 365 / 7, month: 12, year: 1 }

function calendarDate(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    throw new Error('Date must use YYYY-MM-DD with a year from 0001 to 9999')
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Date must be a valid calendar date')
  }
  return date
}

function requiredText(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

export function createSubscription(input: Subscription): Subscription {
  const id = requiredText(input.id, 'id')
  const name = requiredText(input.name, 'name')
  const provider = input.provider === undefined ? undefined : requiredText(input.provider, 'provider')
  if (input.billingType !== 'fixed') throw new Error('Subscription billing type must be fixed')
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error('Amount must be a finite nonnegative number')
  if (typeof input.currency !== 'string' || !/^[A-Z]{3}$/.test(input.currency)) throw new Error('Currency must contain three uppercase letters')
  if (!Number.isSafeInteger(input.recurrenceInterval) || input.recurrenceInterval <= 0) throw new Error('Recurrence interval must be a positive safe integer')
  if (!Object.hasOwn(YEAR_FREQUENCY, input.recurrenceUnit)) throw new Error('Recurrence unit must be day, week, month or year')
  if (!['active', 'paused', 'cancelled'].includes(input.status)) throw new Error('Subscription status must be active, paused or cancelled')
  calendarDate(input.nextRenewalAt)
  normalizeCost(input)
  return { id, name, provider, billingType: 'fixed', amount: input.amount, currency: input.currency, recurrenceInterval: input.recurrenceInterval, recurrenceUnit: input.recurrenceUnit, nextRenewalAt: input.nextRenewalAt, status: input.status }
}

/** A comparison rate using 365 days / 12 months per year; never changes the actual charge. */
export function normalizeCost(subscription: Subscription): NormalizedCost {
  const yearly = subscription.amount / subscription.recurrenceInterval * YEAR_FREQUENCY[subscription.recurrenceUnit]
  if (!Number.isFinite(yearly)) throw new Error('Normalized cost must be a finite number')
  return { monthly: yearly / 12, yearly }
}

/** No FX conversion: active commitments are summed only within the same currency. */
export function normalizedTotals(subscriptions: readonly Subscription[]): CurrencyTotal[] {
  const totals = new Map<string, CurrencyTotal>()
  for (const subscription of subscriptions) {
    if (subscription.status !== 'active') continue
    const cost = normalizeCost(subscription)
    const total = totals.get(subscription.currency) ?? { currency: subscription.currency, monthly: 0, yearly: 0 }
    total.monthly += cost.monthly
    total.yearly += cost.yearly
    if (!Number.isFinite(total.monthly) || !Number.isFinite(total.yearly)) throw new Error('Subscription total must be a finite number')
    totals.set(subscription.currency, total)
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

// Every occurrence is computed from the original anchor, so February clamping never drifts.
function occurrenceAt(subscription: Subscription, anchor: Date, index: number): string | null {
  if (index === 0) return subscription.nextRenewalAt
  const step = subscription.recurrenceInterval * index
  if (!Number.isSafeInteger(step)) return null
  const unit = subscription.recurrenceUnit
  let date: Date
  if (unit === 'day' || unit === 'week') {
    date = new Date(anchor.getTime() + step * (unit === 'week' ? 7 : 1) * DAY_MS)
  } else {
    const monthIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + step * (unit === 'year' ? 12 : 1)
    const year = Math.floor(monthIndex / 12)
    const month = monthIndex % 12
    if (year > 9999) return null
    date = new Date(anchor)
    date.setUTCFullYear(year, month + 1, 0)
    const day = Math.min(anchor.getUTCDate(), date.getUTCDate())
    date.setUTCDate(day)
  }
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) return null
  return date.toISOString().slice(0, 10)
}

// Estimate the index directly, then check the clamped date. Old anchors need no daily loop.
function firstIndex(subscription: Subscription, anchor: Date, asOf: Date): number {
  if (asOf <= anchor) return 0
  let elapsed: number
  switch (subscription.recurrenceUnit) {
    case 'day': elapsed = (asOf.getTime() - anchor.getTime()) / DAY_MS; break
    case 'week': elapsed = (asOf.getTime() - anchor.getTime()) / (7 * DAY_MS); break
    case 'month': elapsed = (asOf.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + asOf.getUTCMonth() - anchor.getUTCMonth(); break
    case 'year': elapsed = asOf.getUTCFullYear() - anchor.getUTCFullYear(); break
  }
  const index = Math.floor(elapsed / subscription.recurrenceInterval)
  const candidate = occurrenceAt(subscription, anchor, index)
  return candidate !== null && candidate < asOf.toISOString().slice(0, 10) ? index + 1 : index
}

/** Next active renewal on or after the date; null if none is in years 0001–9999. */
export function nextRenewalOnOrAfter(subscription: Subscription, asOf: string): string | null {
  const date = calendarDate(asOf)
  if (subscription.status !== 'active') return null
  const anchor = calendarDate(subscription.nextRenewalAt)
  return occurrenceAt(subscription, anchor, firstIndex(subscription, anchor, date))
}

/** All active charges within an inclusive calendar-date window, sorted by date then id. */
export function upcomingRenewals(subscriptions: readonly Subscription[], start: string, end: string): Renewal[] {
  const startDate = calendarDate(start)
  calendarDate(end)
  if (start > end) throw new Error('Renewal window start must be on or before end')
  const renewals: Renewal[] = []
  for (const subscription of subscriptions) {
    if (subscription.status !== 'active') continue
    const anchor = calendarDate(subscription.nextRenewalAt)
    for (let index = firstIndex(subscription, anchor, startDate); ; index++) {
      const date = occurrenceAt(subscription, anchor, index)
      if (date === null || date > end) break
      renewals.push({ subscription, date, amount: subscription.amount, currency: subscription.currency })
    }
  }
  return renewals.sort((a, b) => a.date.localeCompare(b.date) || a.subscription.id.localeCompare(b.subscription.id))
}

/** Sum scheduled original charges, independently of normalized comparison rates. */
export function renewalChargeTotals(renewals: readonly Renewal[]): { currency: string; amount: number }[] {
  const totals = new Map<string, number>()
  for (const renewal of renewals) {
    const amount = (totals.get(renewal.currency) ?? 0) + renewal.amount
    if (!Number.isFinite(amount)) throw new Error('Renewal total exceeds the supported numeric range')
    totals.set(renewal.currency, amount)
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }))
}
