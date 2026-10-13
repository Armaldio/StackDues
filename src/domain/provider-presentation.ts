import type { DataReadState } from './data-read-state.ts'
import type { CostProvider, CostSnapshot } from './usage-costs.ts'

export type ProviderSyncState = 'not-configured' | 'synced' | 'error' | undefined
export type ProviderPresentationState = 'checking' | 'unavailable' | 'not-connected' | 'sync-failed' | 'stale' | 'retained' | 'updated' | 'checked-empty' | 'awaiting-first-report'
export type ProviderPresentation = Readonly<{ state: ProviderPresentationState; label: string; detail: string }>

export function providerStatusPresentation(input: {
  configured: boolean | undefined
  syncStatus: ProviderSyncState
  hasObservation: boolean
  stale: boolean
  readState?: DataReadState
  readAt?: string
}): ProviderPresentation {
  if (input.configured === undefined && input.readState === 'pending') return { state: 'checking', label: 'Checking provider data', detail: 'Saved provider access and data are being checked.' }
  if (input.configured === undefined) return { state: 'unavailable', label: 'Connection status unavailable', detail: 'Saved provider access could not be confirmed.' }
  if (!input.configured) return { state: 'not-connected', label: 'Not connected', detail: 'No provider credentials are saved.' }
  if (input.readState === 'pending') return { state: 'checking', label: 'Checking provider data', detail: 'Saved credentials are being checked for a provider report.' }
  if (input.readState === 'unavailable' || input.readState === 'expired') return { state: 'unavailable', label: 'Provider data unavailable', detail: 'The latest provider data could not be loaded.' }
  if (input.readState === 'retained' || input.readState === 'retained-expired') return { state: 'retained', label: 'Last loaded · check failed', detail: `Showing the previous successful provider read${input.readAt ? ` from ${new Date(input.readAt).toLocaleString()}` : ''}.` }
  if (input.syncStatus === 'error') return { state: 'sync-failed', label: 'Sync failed', detail: 'The latest provider sync failed; previous observations remain available.' }
  if (input.stale) return { state: 'stale', label: 'Stale', detail: 'The last successful provider report is more than 36 hours old.' }
  if (input.syncStatus === 'synced') return input.hasObservation
    ? { state: 'updated', label: 'Updated', detail: 'A provider report is available from the latest successful sync.' }
    : { state: 'checked-empty', label: 'Checked · no report returned', detail: 'The latest successful provider check returned no report.' }
  return { state: 'awaiting-first-report', label: 'Credentials saved · awaiting first report', detail: 'Credentials are saved; no successful provider report is available yet.' }
}

export type CurrencyProviderCoverage = Readonly<{
  provider: CostProvider
  configured: boolean
  syncStatus: ProviderSyncState
  hasSuccessfulSync: boolean
  stale: boolean
  observedCurrencies: readonly string[]
}>

export function currencyUsageNote(
  currency: string,
  providers: readonly CurrencyProviderCoverage[],
  state: { feed: DataReadState; connections: DataReadState },
): string {
  if (state.connections === 'pending' || state.feed === 'pending') return 'Checking saved provider data…'
  if (['unavailable', 'expired'].includes(state.connections)) return 'Provider connection status unavailable; saved access has not been confirmed.'
  if (['unavailable', 'expired'].includes(state.feed)) return 'Billing observations unavailable; retry the data check.'
  if (state.feed === 'retained' || state.feed === 'retained-expired') return 'The latest billing data check failed; showing observations from the last successful read.'

  const configured = providers.filter(provider => provider.configured)
  if (!configured.length) return 'No connected usage provider'
  const relevant = configured.filter(provider => provider.observedCurrencies.includes(currency))
  if (relevant.some(provider => provider.syncStatus === 'error')) return `The ${currency} usage check failed; last known data remains available.`
  if (relevant.some(provider => provider.stale)) return `Last known ${currency} usage is stale.`
  if (relevant.length) return `No ${currency} usage report was returned in the latest check.`
  if (configured.some(provider => provider.syncStatus === 'error' && !provider.hasSuccessfulSync && provider.observedCurrencies.length === 0)) return 'Usage sync failed; the first provider report is not confirmed.'
  if (configured.some(provider => !provider.hasSuccessfulSync)) return 'Credentials saved · awaiting first usage report.'
  return `No connected provider reports ${currency} usage.`
}

export function providerSupportsFullMonthForecast(provider: CostProvider): boolean {
  return provider === 'aws'
}

export function missingForecastLabel(provider: CostProvider): string {
  return providerSupportsFullMonthForecast(provider) ? 'Not reported' : 'Not provided by this provider'
}

export function hasCurrencyObservation(snapshots: readonly CostSnapshot[], provider: CostProvider, currency: string): boolean {
  return snapshots.some(snapshot => snapshot.provider === provider && snapshot.currency === currency)
}
