<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import SubscriptionForm from './components/SubscriptionForm.vue'
import InfrastructurePanel from './components/InfrastructurePanel.vue'
import ConnectionsPanel from './components/ConnectionsPanel.vue'
import HostingerDiscovery from './components/HostingerDiscovery.vue'
import CostHistory from './components/CostHistory.vue'
import LegacyImport from './components/LegacyImport.vue'
import ServiceDetail from './components/ServiceDetail.vue'
import SpendingTimeline from './components/SpendingTimeline.vue'
import ServiceInventory from './components/ServiceInventory.vue'
import type { ServiceSelection } from './domain/service-selection'
import { nextDistinctRenewals, nextRenewalOnOrAfter, normalizeCost, normalizedTotals, renewalChargeTotals, upcomingRenewals, type Subscription } from './domain/subscriptions'
import { currentCostSnapshots, emptyCostFeed, fetchCostFeed, isProviderStale, CostFeedReadError } from './lib/cost-feed'
import { trackedSpendingTotals, usageTotals, type CostProvider } from './domain/usage-costs'
import { overviewInsights } from './domain/overview-insights'
import { hostingerCoverage, hostingerFreshness } from './domain/hostinger-coverage'
import { currencyUsageNote, missingForecastLabel, providerStatusPresentation, type CurrencyProviderCoverage } from './domain/provider-presentation'
import { ConnectionApiError, fetchConnections, type ConnectionStatuses } from './lib/connection-api'
import { HostingerApiError, readHostingerDiscovery, type HostingerDiscovery as HostingerState } from './lib/hostinger-api'
import { createStoredSubscription, deleteStoredSubscription, fetchSubscriptions, importStoredSubscriptions, serializeSubscriptionExport, SUBSCRIPTION_EXPORT_FILENAME, SubscriptionRequestFailure, updateStoredSubscription, type StoredSubscription, type ImportResult } from './lib/subscription-api'
import { failedReadState, successfulReadState, type DataReadState } from './domain/data-read-state'

const costFeed = ref(emptyCostFeed())
const financialRefreshError = ref('')
const costFeedReadState = ref<DataReadState>('pending')
const costFeedReadAt = ref<string>()
const costFeedReadError = ref('')
const connectionReadState = ref<DataReadState>('pending')
const connectionReadAt = ref<string>()
const connectionStatusesResolved = ref(false)
const connectionStatusesError = ref(false)
const hostingerReadState = ref<DataReadState>('pending')
const hostingerReadAt = ref<string>()
const hostingerReadError = ref('')
const hostingerStateResolved = ref(false)
const connectionStatuses = ref<ConnectionStatuses>()
const hostingerState = ref<HostingerState>()
const router = useRouter()
const route = router.currentRoute
const routeSections: Record<string, string> = { '/': 'overview', '/services': 'services', '/connections': 'connections', '/history': 'history' }
const currentSection = computed(() => routeSections[route.value.path] ?? 'overview')
const sectionMeta = computed(() => ({
  overview: { title: 'Overview', subtitle: 'Know what you pay. See what’s coming.', eyebrow: 'Your costs, in one place' },
  services: { title: 'Services', subtitle: 'Manage fixed renewals and explore provider costs.', eyebrow: 'Everything you track' },
  connections: { title: 'Connections', subtitle: 'Connect providers to keep billing data up to date.', eyebrow: 'Private provider access' },
  history: { title: 'History', subtitle: 'Review past charges, forecasts and renewals.', eyebrow: 'Your saved observations' },
}[currentSection.value as 'overview' | 'services' | 'connections' | 'history']))
const mainContent = ref<HTMLElement>()
const subscriptions = ref<StoredSubscription[]>([])
const storageError = ref<string | null>(null)
const loading = ref(true)
const busy = ref(false)
const loaded = ref(false)
const subscriptionsReadAt = ref<string>()
const subscriptionsReadState = ref<DataReadState>('pending')
const blocked = computed(() => loading.value || busy.value || !loaded.value || storageError.value !== null)
function readIsExpired(cause: unknown) {
  return (cause instanceof CostFeedReadError || cause instanceof ConnectionApiError || cause instanceof HostingerApiError) && cause.status === 401
    || cause instanceof Error && ('kind' in cause && cause.kind === 'session' || cause.message.includes('Your session expired.'))
}
function readTime(value?: string) { return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '' }
async function reloadLedger() {
  if (loading.value && loaded.value) return
  loading.value = true
  try { subscriptions.value = await fetchSubscriptions(); storageError.value = null; loaded.value = true; subscriptionsReadAt.value = new Date().toISOString(); subscriptionsReadState.value = successfulReadState(subscriptions.value.length > 0) }
  catch (cause) { storageError.value = cause instanceof Error ? cause.message : 'Subscriptions could not be loaded. Reload before making changes.'; subscriptionsReadState.value = failedReadState(loaded.value, readIsExpired(cause)) }
  finally { loading.value = false }
}
const legacyPaths: Record<string, string> = { overview: '/', subscriptions: '/services', connections: '/connections', history: '/history', infrastructure: '/services', 'hostinger-discovery': '/services' }
const hostingerDisclosure = ref<HTMLDetailsElement>()
async function focusHostingerTarget() {
  if (route.value.hash !== '#hostinger-discovery' || currentSection.value !== 'services') return
  await nextTick()
  if (!hostingerStateResolved.value) return
  if (hostingerDisclosure.value) hostingerDisclosure.value.open = true
  await nextTick()
  const target = document.getElementById('hostinger-discovery')
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
}
function normalizeLegacyHash(hash = route.value.hash) {
  const section = hash.slice(1) || window.location.hash.slice(1)
  if (section === 'hostinger-discovery') {
    if (route.value.path !== '/services') void router.replace({ path: '/services', hash: '#hostinger-discovery' })
    else void focusHostingerTarget()
    return
  }
  if (section && legacyPaths[section]) void router.replace({ path: legacyPaths[section]!, hash: '' })
}
watch(() => [route.value.path, route.value.hash], ([, hash]) => { if (hash) normalizeLegacyHash(hash); else void focusHostingerTarget() })
watch(hostingerStateResolved, () => { void focusHostingerTarget() })
onMounted(() => {
  void reloadLedger()
  void fetchCostFeed('/api/costs').then(feed => { setCostFeed(feed); financialRefreshError.value = ''; costFeedReadError.value = '' }).catch(cause => { costFeedReadState.value = failedReadState(!!costFeedReadAt.value, readIsExpired(cause)); costFeedReadError.value = cause instanceof Error ? cause.message : 'Saved billing data could not be loaded.' })
  void fetchConnections().then(statuses => { connectionStatuses.value = statuses; connectionReadState.value = successfulReadState(true); connectionReadAt.value = new Date().toISOString() }).catch(cause => { connectionStatusesError.value = true; connectionReadState.value = failedReadState(!!connectionReadAt.value, readIsExpired(cause)) }).finally(() => { connectionStatusesResolved.value = true })
  void readHostingerDiscovery().then(setHostingerState).catch(cause => { hostingerReadState.value = failedReadState(!!hostingerReadAt.value, readIsExpired(cause)); hostingerReadError.value = cause instanceof Error ? cause.message : 'Hostinger services could not be loaded.' }).finally(() => { hostingerStateResolved.value = true })
  normalizeLegacyHash(route.value.hash)
  void focusPaymentScheduleTarget()
  if (!routeSections[route.value.path]) void router.replace('/')
})
watch(currentSection, async () => { await nextTick(); mainContent.value?.focus() })
async function focusPaymentScheduleTarget() {
  if (route.value.path !== '/history' || route.value.hash !== '#payment-schedule') return
  await nextTick()
  document.getElementById('payment-schedule-heading')?.focus({ preventScroll: true })
}
watch(() => route.value.fullPath, () => { void focusPaymentScheduleTarget() })
const notice = ref('')
const exportError = ref('')
const today = ref(new Date().toISOString().slice(0, 10))
const timer = window.setInterval(() => { today.value = new Date().toISOString().slice(0, 10) }, 60_000)
const financialRefreshInterval = 15 * 60 * 1000
let lastFinancialRefresh = Date.now()
let financialRefresh: Promise<void> | undefined
let financialReadRevision = 0
async function refreshPersistedFinancialData(force = false) {
  if (!force && Date.now() - lastFinancialRefresh < financialRefreshInterval) return financialRefresh
  if (!force && financialRefresh) return financialRefresh
  lastFinancialRefresh = Date.now()
  const revision = ++financialReadRevision
  const operation = Promise.allSettled([
    fetchCostFeed('/api/costs'),
    readHostingerDiscovery(),
    fetchConnections(),
  ]).then(results => {
    if (revision !== financialReadRevision) return
    if (results[0]!.status === 'fulfilled') {
      applyCostFeed(results[0]!.value); costFeedReadState.value = successfulReadState(results[0]!.value.snapshots.length > 0); costFeedReadAt.value = new Date().toISOString(); costFeedReadError.value = ''
    } else {
      costFeedReadState.value = failedReadState(!!costFeedReadAt.value, readIsExpired(results[0]!.reason)); costFeedReadError.value = results[0]!.reason instanceof Error ? results[0]!.reason.message : 'Saved billing data could not be loaded.'
    }
    if (results[1]!.status === 'fulfilled') {
      hostingerState.value = results[1]!.value; hostingerReadState.value = successfulReadState(results[1]!.value.subscriptions.length > 0); hostingerReadAt.value = new Date().toISOString(); hostingerReadError.value = ''
    } else {
      hostingerReadState.value = failedReadState(!!hostingerReadAt.value, readIsExpired(results[1]!.reason)); hostingerReadError.value = results[1]!.reason instanceof Error ? results[1]!.reason.message : 'Hostinger services could not be loaded.'
    }
    if (results[2]!.status === 'fulfilled') setConnectionStatuses(results[2]!.value)
    else { connectionStatusesError.value = true; connectionReadState.value = failedReadState(!!connectionReadAt.value, readIsExpired(results[2]!.reason)) }
    financialRefreshError.value = results.slice(0, 2).some(result => result.status === 'rejected')
      ? ['retained', 'retained-expired'].includes(costFeedReadState.value) || ['retained', 'retained-expired'].includes(hostingerReadState.value)
        ? 'Saved billing data could not be checked. Previously displayed observations remain available.'
        : 'Saved billing data could not be checked. No earlier observations are available for one or more sources.'
      : ''
  }).finally(() => { if (financialRefresh === operation) financialRefresh = undefined })
  financialRefresh = operation
  return operation
}
function refreshWhenVisible() { if (document.visibilityState === 'visible') void refreshPersistedFinancialData() }
window.addEventListener('focus', refreshWhenVisible)
document.addEventListener('visibilitychange', refreshWhenVisible)
const financialRefreshTimer = window.setInterval(refreshWhenVisible, 60_000)
onUnmounted(() => {
  window.clearInterval(timer)
  window.clearInterval(financialRefreshTimer)
  window.removeEventListener('focus', refreshWhenVisible)
  document.removeEventListener('visibilitychange', refreshWhenVisible)
})
const showForm = ref(false)
const editing = ref<StoredSubscription>()
const formSaveFailure = ref<SubscriptionRequestFailure | null>(null)
const formRecoveryNotice = ref('')
const formReviewRequired = ref(false)
const formCheckingSave = ref(false)
let formSession = 0
const formCanRetry = ref(true)
let lastFormTrigger: HTMLElement | null = null
const search = ref('')
const statusFilter = ref('all')
const serviceSelection = ref<ServiceSelection | null>(null)
let lastDetailTrigger: HTMLElement | null = null
const detailOpenedFromScreen = ref(false)
const detailProviders = new Set(['aws', 'cloudflare', 'openai', 'digitalocean', 'hostinger', 'github'])
function selectionRouteKey(selection: ServiceSelection) {
  return `${selection.kind}:${encodeURIComponent(selection.kind === 'subscription' ? selection.id : selection.provider)}`
}
function selectionFromRoute(value: unknown): ServiceSelection | null {
  if (typeof value !== 'string') return null
  const separator = value.indexOf(':')
  if (separator < 0) return null
  const kind = value.slice(0, separator)
  let id: string
  try { id = decodeURIComponent(value.slice(separator + 1)) } catch { return null }
  if (kind === 'subscription' && id) return { kind, id }
  if (kind === 'provider' && detailProviders.has(id)) return { kind, provider: id as CostProvider | 'hostinger' | 'github' }
  return null
}
watch(() => route.value.query.detail, async value => {
  const selection = selectionFromRoute(value)
  if (selection) { serviceSelection.value = selection; return }
  if (serviceSelection.value) {
    serviceSelection.value = null
    await nextTick()
    lastDetailTrigger?.focus()
    lastDetailTrigger = null
  }
  detailOpenedFromScreen.value = false
}, { immediate: true })
function openServiceDetails(selection: ServiceSelection, event?: Event) {
  lastDetailTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : document.activeElement instanceof HTMLElement ? document.activeElement : null
  const detail = selectionRouteKey(selection)
  if (route.value.query.detail === detail) { serviceSelection.value = selection; return }
  detailOpenedFromScreen.value = true
  void router.push({ query: { ...route.value.query, detail } })
}
function openProviderDetails(provider: CostProvider | 'hostinger' | 'github', event?: Event) { openServiceDetails({ kind: 'provider', provider }, event) }
async function openHostingerManagement() {
  if (hostingerDisclosure.value) hostingerDisclosure.value.open = true
  await nextTick()
  document.getElementById('hostinger-discovery')?.scrollIntoView({ block: 'start' })
  document.getElementById('hostinger-discovery')?.focus({ preventScroll: true })
}
async function closeServiceDetails() {
  if (route.value.query.detail) {
    if (detailOpenedFromScreen.value) {
      detailOpenedFromScreen.value = false
      await router.back()
    } else {
      const { detail: _, ...query } = route.value.query
      await router.replace({ query })
    }
    return
  }
  serviceSelection.value = null
  await nextTick()
  lastDetailTrigger?.focus()
  lastDetailTrigger = null
}
function editDetailedSubscription(item: Subscription) {
  const stored = subscriptions.value.find(candidate => candidate.id === item.id)
  const trigger = lastDetailTrigger
  void closeServiceDetails()
  if (stored) openForm(stored, trigger ?? undefined)
}
const hasConfiguredProvider = computed(() => connectionStatuses.value ? Object.values(connectionStatuses.value).some(status => status.configured) : Object.values(costFeed.value.providers).some(status => status.status !== 'not-configured') || (!!hostingerState.value && hostingerState.value.sync.status !== 'not-configured'))
const totals = computed(() => normalizedTotals(subscriptions.value))
const meterSnapshots = computed(() => currentCostSnapshots(costFeed.value))
function providerIsConfigured(provider: 'aws' | 'cloudflare' | 'openai' | 'digitalocean') {
  return connectionStatuses.value ? connectionStatuses.value[provider].configured : costFeed.value.providers[provider].status !== 'not-configured'
}
function providerConnectionNote(provider: 'aws' | 'cloudflare' | 'openai' | 'digitalocean') {
  return providerStatusPresentation({ configured: connectionStatuses.value ? connectionStatuses.value[provider].configured : connectionStatusesError.value || connectionReadState.value === 'pending' ? undefined : providerIsConfigured(provider), syncStatus: costFeed.value.providers[provider].status, hasObservation: currentCostSnapshots(costFeed.value).some(row => row.provider === provider), stale: isProviderStale(costFeed.value.providers[provider]), readState: costFeedReadState.value === 'pending' ? costFeedReadState.value : connectionReadState.value === 'pending' ? connectionReadState.value : costFeedReadState.value }).detail
}
function hostingerIsConfigured() { return connectionStatuses.value ? connectionStatuses.value.hostinger.configured : !!hostingerState.value && hostingerState.value.sync.status !== 'not-configured' }
const connectedMeteredProviders = computed(() => (['aws', 'cloudflare', 'openai'] as const).filter(providerIsConfigured))
const connectedBillingProviders = computed(() => (['aws', 'cloudflare', 'openai', 'digitalocean'] as const).filter(providerIsConfigured))
const serviceProviders = computed(() => [
  ...(['aws', 'cloudflare', 'openai', 'digitalocean'] as const).map(provider => {
    const state = costFeed.value.providers[provider]
    const rows = currentCostSnapshots(costFeed.value).filter(row => row.provider === provider && row.kind === 'actual')
    const serviceNames = rows.flatMap(row => Array.isArray(row.metadata?.breakdown) ? row.metadata.breakdown.map(item => typeof item === 'object' && item && 'service' in item ? String(item.service) : '') : []).filter(Boolean)
    const reported = rows.map(row => provider === 'digitalocean'
      ? `Finalized invoice total · ${money(row.amount, row.currency)} · ${row.periodStart.slice(0, 7)} invoice period`
      : `Reported actual · ${money(row.amount, row.currency)} · ${row.periodStart}–${row.periodEnd} (end exclusive)`).join(' · ')
    const latestCapture = Math.max(...currentCostSnapshots(costFeed.value).filter(row => row.provider === provider).map(row => Date.parse(row.capturedAt)))
    const forecasts = currentCostSnapshots(costFeed.value).filter(row => row.provider === provider && row.kind === 'forecast' && Date.parse(row.capturedAt) === latestCapture)
      .map(row => `Full-month forecast (includes actuals) · ${money(row.amount, row.currency)}`).join(' · ')
    const summary = [reported, provider === 'digitalocean' ? '' : forecasts].filter(Boolean).join(' · ') || (state.status === 'error' ? 'Last sync failed; last known usage may be available in details.' : state.status === 'synced' ? provider === 'digitalocean' ? 'Checked successfully; no finalized invoice total is available.' : 'Checked successfully; no current usage report.' : hasCostReadFailure.value ? 'Usage data could not be loaded; current usage is unavailable.' : state.status === 'not-configured' ? 'Usage not connected; no reported amount.' : 'Usage data is pending.')
    const presentation = providerStatusPresentation({ configured: connectionStatuses.value?.[provider].configured ?? (connectionReadState.value === 'pending' || connectionStatusesError.value && !connectionStatuses.value ? undefined : state.status !== 'not-configured'), syncStatus: state.status, hasObservation: rows.length > 0, stale: isProviderStale(state), readState: connectionReadState.value === 'pending' ? 'pending' : costFeedReadState.value, readAt: costFeedReadAt.value })
    return { id: provider, name: providerName(provider), status: state.status, presentation, lastSyncedAt: state.lastSyncedAt, summary, searchTerms: serviceNames.join(' ') }
  }),
  {
    id: 'hostinger' as const, name: 'Hostinger',
    status: hostingerState.value?.sync.status ?? (hostingerIsConfigured() ? hostingerStateResolved.value ? 'error' : 'pending' : 'not-configured'),
    presentation: providerStatusPresentation({ configured: connectionStatuses.value?.hostinger.configured ?? (connectionReadState.value === 'pending' || connectionStatusesError.value && !connectionStatuses.value ? undefined : hostingerIsConfigured()), syncStatus: hostingerState.value?.sync.status === 'synced' || hostingerState.value?.sync.status === 'error' || hostingerState.value?.sync.status === 'not-configured' ? hostingerState.value.sync.status : undefined, hasObservation: !!hostingerState.value?.subscriptions.length, stale: hostingerFreshness(hostingerState.value?.sync) === 'stale', readState: connectionReadState.value === 'pending' ? 'pending' : hostingerReadState.value, readAt: hostingerReadAt.value }),
    lastSyncedAt: hostingerState.value?.sync.lastSyncedAt,
    summary: hostingerState.value?.sync.status === 'error' ? 'Latest sync failed; saved subscriptions and previous discoveries are retained.' : hostingerState.value?.sync.status === 'synced' ? `${hostingerState.value.subscriptions.filter(row => row.linkedSubscriptionId).length} linked renewal(s); unlinked discoveries need review.` : hostingerIsConfigured() ? hostingerStateResolved.value ? 'Hostinger discovery could not be loaded; saved subscriptions remain in the inventory.' : 'Hostinger data is pending; saved linked renewals remain in fixed subscriptions.' : 'No Hostinger connection; saved manual renewals remain searchable.',
  },
])
const hostingerInventoryRows = computed(() => hostingerState.value?.subscriptions ?? [])
const meteredTotals = computed(() => usageTotals(meterSnapshots.value, today.value, connectedMeteredProviders.value))
const trackedTotals = computed(() => trackedSpendingTotals(totals.value, meteredTotals.value, connectedMeteredProviders.value, meterSnapshots.value))
const providerUsage = computed(() => ({
  aws: usageTotals(meterSnapshots.value, today.value, connectedMeteredProviders.value.includes('aws') ? ['aws'] : []),
  cloudflare: usageTotals(meterSnapshots.value, today.value, connectedMeteredProviders.value.includes('cloudflare') ? ['cloudflare'] : []),
  openai: usageTotals(meterSnapshots.value, today.value, connectedMeteredProviders.value.includes('openai') ? ['openai'] : []),
}))
const actualPeriodLabels = computed(() => Object.fromEntries(trackedTotals.value.map(({ currency }) => [currency, meteredProviders.map(provider => {
  const usage = providerUsage.value[provider].find(item => item.currency === currency && item.hasActual)
  return usage ? `${providerName(provider)} · ${periodDescription(provider, currency)}` : null
}).filter((value): value is string => value !== null).join(' · ')])))
const currencyCoverage = computed<CurrencyProviderCoverage[]>(() => (['aws', 'cloudflare', 'openai'] as const).map(provider => ({
  provider,
  configured: providerIsConfigured(provider),
  syncStatus: costFeed.value.providers[provider].status,
  hasSuccessfulSync: !!costFeed.value.providers[provider].lastSyncedAt,
  stale: isProviderStale(costFeed.value.providers[provider]),
  observedCurrencies: costFeed.value.snapshots.filter(row => row.provider === provider).map(row => row.currency),
})))
function showMeteredCurrency(currency: string) {
  if (connectionStatuses.value && !connectedMeteredProviders.value.length) return false
  if (currencyCoverage.value.some(provider => provider.configured && provider.observedCurrencies.includes(currency))) return true
  if (connectionReadState.value === 'pending' || costFeedReadState.value === 'pending' || ['unavailable', 'expired', 'retained', 'retained-expired'].includes(costFeedReadState.value)) return true
  return currencyCoverage.value.some(provider => provider.configured && !provider.hasSuccessfulSync && provider.observedCurrencies.length === 0)
}
function meteredStatus(currency: string) {
  return currencyUsageNote(currency, currencyCoverage.value, { feed: costFeedReadState.value, connections: connectionReadState.value })
}
const spendingInsights = computed(() => overviewInsights(costFeed.value.snapshots.filter(row => connectedBillingProviders.value.includes(row.provider))))
const featuredInsight = computed(() => spendingInsights.value.find(item => item.drivers.length || item.changePercent !== null) ?? spendingInsights.value[0])
const lastSuccessfulSync = computed(() => [
  ...Object.values(costFeed.value.providers).map(provider => provider.lastSyncedAt),
  hostingerState.value?.sync.lastSyncedAt,
].filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null)
const upcomingCharges = computed(() => nextDistinctRenewals(upcomingRenewals(confirmedSubscriptions.value, today.value, endDate(365))).slice(0, 3))
const currentMonthEnd = computed(() => {
  const [year, month] = today.value.split('-').map(Number)
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10)
})
const currentMonthRenewalTotals = computed(() => renewalChargeTotals(upcomingRenewals(confirmedSubscriptions.value, today.value, currentMonthEnd.value)))
const currentMonthLabel = computed(() => new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' }).format(new Date(`${today.value.slice(0, 7)}-01T00:00:00Z`)))
const featuredDriverMaximum = computed(() => Math.max(0, ...(featuredInsight.value?.drivers.map(driver => driver.amount) ?? [])))
function driverWidth(amount: number) { return featuredDriverMaximum.value > 0 ? `${Math.max(4, amount / featuredDriverMaximum.value * 100)}%` : '0%' }
const hostingerLinkedIds = computed(() => new Set((hostingerState.value?.subscriptions ?? []).map(item => item.linkedSubscriptionId).filter((id): id is string => !!id)))
const hostingerFixedTotals = computed(() => normalizedTotals(subscriptions.value.filter(item => item.provider === 'Hostinger' || hostingerLinkedIds.value.has(item.id))))
const manualFixedTotals = computed(() => normalizedTotals(subscriptions.value.filter(item => item.provider !== 'Hostinger' && !hostingerLinkedIds.value.has(item.id))))
const meteredProviders = ['aws', 'cloudflare', 'openai'] as const
const digitalOceanInvoices = computed(() => meterSnapshots.value.filter(row => row.provider === 'digitalocean' && row.metadata?.scope === 'finalized-invoice-total').sort((a, b) => b.periodStart.localeCompare(a.periodStart)))
function providerName(provider: 'aws' | 'cloudflare' | 'openai' | 'digitalocean') { return provider === 'aws' ? 'AWS' : provider === 'cloudflare' ? 'Cloudflare' : provider === 'openai' ? 'OpenAI API' : 'DigitalOcean' }
const meteredWarning = computed(() => {
  const failed = connectedBillingProviders.value.filter(provider => costFeed.value.providers[provider].status === 'error')
  if (failed.length) return `${failed.map(providerName).join(' and ')} sync failed. Last successful observations are shown where available.`
  const stale = connectedBillingProviders.value.filter(provider => isProviderStale(costFeed.value.providers[provider]))
  return stale.length ? `${stale.map(providerName).join(' and ')} data is stale. Last known values remain visible.` : ''
})
function endDate(days: number) { const date = new Date(`${today.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days - 1); return date.toISOString().slice(0, 10) }
const currentHostingerLedger = computed(() => new Set((hostingerState.value?.subscriptions ?? []).filter(item => item.seenInLatestSync && hostingerState.value?.sync.status === 'synced').map(item => item.linkedSubscriptionId).filter((id): id is string => !!id)))
const confirmedSubscriptions = computed(() => subscriptions.value.filter(item => {
  if (item.provider !== 'Hostinger') return true
  const linkedSource = hostingerState.value?.subscriptions.some(source => source.linkedSubscriptionId === item.id) ?? false
  if (linkedSource) return currentHostingerLedger.value.has(item.id)
  // A provider label alone does not prove this manual ledger row is linked to
  // Hostinger discovery. Keep independent saved commitments during read failures.
  return true
}))
const hostingerCoverageWarning = computed(() => hostingerStateResolved.value ? hostingerCoverage(hostingerState.value, hostingerIsConfigured()) : '')
const currentSubscriptionsReadState = computed(() => loaded.value && !storageError.value ? successfulReadState(subscriptions.value.length > 0) : subscriptionsReadState.value)
const paymentScheduleReadState = computed<DataReadState>(() => {
  if (['pending', 'unavailable', 'expired'].includes(currentSubscriptionsReadState.value)) return currentSubscriptionsReadState.value
  if (connectionReadState.value === 'pending') return 'pending'
  if (!connectionStatuses.value && ['unavailable', 'expired'].includes(connectionReadState.value)) return connectionReadState.value
  if (connectionStatuses.value?.hostinger.configured) {
    if (hostingerState.value?.sync.status === 'error') return hostingerState.value.subscriptions.length ? 'retained' : 'unavailable'
    if (['pending', 'unavailable', 'expired', 'retained', 'retained-expired'].includes(hostingerReadState.value)) return hostingerReadState.value
  }
  return currentSubscriptionsReadState.value
})
const hasCostReadFailure = computed(() => ['unavailable', 'expired'].includes(costFeedReadState.value))
const hasRetainedCostRead = computed(() => ['retained', 'retained-expired'].includes(costFeedReadState.value))
const hasHostingerReadFailure = computed(() => ['unavailable', 'expired'].includes(hostingerReadState.value))
const hasRetainedHostingerRead = computed(() => ['retained', 'retained-expired'].includes(hostingerReadState.value))
const costReadMessage = computed(() => costFeedReadState.value === 'expired' ? 'Your session expired. Sign in again to load saved billing observations.' : 'Saved billing observations could not be loaded. No current result is confirmed.')
const hostingerReadMessage = computed(() => hostingerReadState.value === 'expired' ? 'Your session expired. Sign in again to load Hostinger services.' : 'Hostinger services could not be loaded. No current provider result is confirmed.')
const overviewFreshness = computed(() => {
  if (connectionReadState.value === 'pending') return 'Checking saved provider connections'
  if (['unavailable', 'expired'].includes(connectionReadState.value) && !connectionStatuses.value) return 'Provider connection status unavailable'
  if (lastSuccessfulSync.value) return `Latest successful data · ${dateLabel(lastSuccessfulSync.value.slice(0, 10))}`
  if (hasConfiguredProvider.value) return 'Waiting for first billing data'
  return connectionStatuses.value ? 'No billing connections yet' : 'Provider connection status not confirmed'
})
const overviewEmptyMessage = computed(() => {
  if (costFeedReadState.value === 'pending') return 'Checking saved billing observations before confirming an empty spending summary.'
  if (hasCostReadFailure.value) return 'Billing observations are unavailable until the saved data read succeeds.'
  if (hasRetainedCostRead.value) return `No spending data was present in the last successful read${readTime(costFeedReadAt.value) ? ` from ${readTime(costFeedReadAt.value)}` : ''}; the latest check failed.`
  if (connectionReadState.value === 'pending') return 'Checking provider connections before confirming an empty spending summary.'
  if (connectionStatusesError.value && !connectionStatuses.value) return 'Provider connection status is unavailable; a zero summary cannot be confirmed.'
  return 'No spending data has arrived yet.'
})
function money(amount: number | null, currency: string) { if (amount === null) return `${currency} total unavailable`; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) } catch { return `${currency} ${amount.toFixed(2)}` } }
function dateLabel(date: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) }
function periodDescription(provider: 'aws' | 'cloudflare' | 'openai', currency: string) {
  const periods = currentCostSnapshots(costFeed.value).filter(row => row.provider === provider && row.currency === currency && row.kind === 'actual' && (row.metadata?.period === 'current' || row.metadata?.scope === 'billing-period-to-date'))
  if (!periods.length) return 'Unavailable'
  if (provider === 'openai') {
    const reportedThrough = periods.map(row => row.metadata?.reportedThrough).filter((value): value is string => typeof value === 'string').sort().at(-1)
    return `Daily organization API cost buckets${reportedThrough ? ` · reported through ${reportedThrough.slice(0, 10)}` : ''}`
  }
  return [...new Set(periods.map(row => `${row.periodStart}–${row.periodEnd}${row.metadata?.reportedThrough ? ` · reported through ${String(row.metadata.reportedThrough).slice(0, 10)}` : ''}`))].join(', ')
}
function recurrence(item: Subscription) { return `Every ${item.recurrenceInterval} ${item.recurrenceUnit}${item.recurrenceInterval === 1 ? '' : 's'}` }
function openForm(item?: StoredSubscription, trigger?: HTMLElement) {
  if (blocked.value) return
  formSession++
  const target = trigger ?? document.activeElement
  lastFormTrigger = target instanceof HTMLElement ? target : null
  formSaveFailure.value = null; formRecoveryNotice.value = ''; formReviewRequired.value = false; formCheckingSave.value = false; formCanRetry.value = true
  editing.value = item; showForm.value = true
}
async function closeForm() {
  formSession++
  showForm.value = false
  formSaveFailure.value = null; formRecoveryNotice.value = ''; formReviewRequired.value = false; formCheckingSave.value = false; formCanRetry.value = true
  await nextTick()
  restoreFormFocus()
}
function restoreFormFocus() {
  if (!showForm.value && !busy.value && lastFormTrigger?.isConnected && !lastFormTrigger.matches(':disabled')) lastFormTrigger.focus()
  if (!showForm.value && !busy.value) lastFormTrigger = null
}
function mutationError(cause: unknown) { storageError.value = cause instanceof Error ? cause.message : 'Changes could not be confirmed. Reload before making changes.' }
async function save(item: Subscription) {
  if (blocked.value || formSaveFailure.value || !formCanRetry.value) return
  busy.value = true
  try {
    const saved = editing.value ? await updateStoredSubscription(item, editing.value.revision) : await createStoredSubscription(item)
    if (saved.id !== item.id) throw new Error('The saved subscription could not be confirmed. Reload before making changes.')
    subscriptions.value = subscriptions.value.some(({ id }) => id === saved.id) ? subscriptions.value.map(existing => existing.id === saved.id ? saved : existing) : [...subscriptions.value, saved]
    storageError.value = null; formSaveFailure.value = null; formRecoveryNotice.value = ''; notice.value = `${item.name} saved.`; await closeForm()
  } catch (cause) {
    formSaveFailure.value = cause instanceof SubscriptionRequestFailure
      ? cause
      : new SubscriptionRequestFailure('uncertain', cause instanceof Error ? cause.message : 'The save could not be confirmed. Your draft is still here; check its save status before retrying.')
    formRecoveryNotice.value = ''
    formCanRetry.value = false
  }
  finally { busy.value = false; await nextTick(); restoreFormFocus() }
}
function sameSubscription(left: Subscription, right: Subscription) {
  return left.id === right.id && left.name === right.name && (left.provider ?? '') === (right.provider ?? '') && left.billingType === right.billingType && left.amount === right.amount && left.currency === right.currency && left.recurrenceInterval === right.recurrenceInterval && left.recurrenceUnit === right.recurrenceUnit && left.nextRenewalAt === right.nextRenewalAt && left.status === right.status
}
async function checkFormSave(item: Subscription) {
  if (formCheckingSave.value) return
  const session = formSession
  formCheckingSave.value = true
  formRecoveryNotice.value = ''
  try {
    const latest = await fetchSubscriptions()
    if (session !== formSession || !showForm.value) return
    subscriptions.value = latest; loaded.value = true; storageError.value = null
    const current = latest.find(candidate => candidate.id === item.id)
    if (current && sameSubscription(current, item)) {
      notice.value = `${item.name} was saved and confirmed.`
      await closeForm()
      return
    }
    if (editing.value && !current) {
      formSaveFailure.value = new SubscriptionRequestFailure('conflict', 'This subscription is no longer in the ledger. Your draft is still here; copy it before closing or contact support.')
      formCanRetry.value = false
      return
    }
    if (current) {
      const previousRevision = editing.value?.revision
      editing.value = current
      formReviewRequired.value = previousRevision === undefined || current.revision !== previousRevision
      formRecoveryNotice.value = formReviewRequired.value
        ? 'A newer saved version is available below. Review its changes before saving your draft.'
        : 'The latest ledger is loaded. Your draft is still here and can be retried safely.'
      formCanRetry.value = true
    } else {
      formReviewRequired.value = false
      formRecoveryNotice.value = 'No saved copy was found. Your draft is preserved and can be retried safely.'
      formCanRetry.value = true
    }
    formSaveFailure.value = null
  } catch (cause) {
    if (session !== formSession || !showForm.value) return
    formSaveFailure.value = cause instanceof SubscriptionRequestFailure
      ? cause
      : new SubscriptionRequestFailure('unavailable', 'Subscriptions could not be checked. Your draft is still here; try again when storage is available.')
    formCanRetry.value = false
  } finally { if (session === formSession) formCheckingSave.value = false }
}
function confirmLatestForDraft() {
  formReviewRequired.value = false
  formRecoveryNotice.value = 'Your draft will be saved using the latest revision.'
}
async function setStatus(item: StoredSubscription) {
  if (blocked.value) return
  busy.value = true
  const status = item.status === 'active' ? 'paused' : 'active'
  try {
    const saved = await updateStoredSubscription({ ...item, status }, item.revision)
    if (saved.id !== item.id) throw new Error('The saved subscription could not be confirmed. Reload before making changes.')
    subscriptions.value = subscriptions.value.map(existing => existing.id === item.id ? saved : existing)
    notice.value = `${item.name} ${status === 'active' ? 'resumed' : 'paused'}.`
  } catch (cause) { mutationError(cause) }
  finally { busy.value = false }
}
async function remove(item: StoredSubscription) {
  if (blocked.value || !window.confirm(`Delete ${item.name}? This does not cancel the service.`)) return
  busy.value = true
  try { await deleteStoredSubscription(item.id, item.revision); subscriptions.value = subscriptions.value.filter(({ id }) => id !== item.id); notice.value = `${item.name} deleted.` }
  catch (cause) { mutationError(cause) }
  finally { busy.value = false }
}
async function importLedger(items: Subscription[]): Promise<ImportResult> {
  if (blocked.value) throw new Error('Reload subscriptions before importing.')
  busy.value = true
  try {
    const result = await importStoredSubscriptions(items)
    subscriptions.value = result.subscriptions; storageError.value = null; notice.value = `${result.createdIds.length} subscriptions imported.`
    return result
  } catch (cause) { mutationError(cause); throw cause }
  finally { busy.value = false }
}
function downloadSubscriptions() {
  if (blocked.value) return
  try {
    const json = serializeSubscriptionExport(subscriptions.value)
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    try {
      const link = document.createElement('a')
      link.href = url; link.download = SUBSCRIPTION_EXPORT_FILENAME; link.click()
      exportError.value = ''; notice.value = 'Subscriptions downloaded. Keep this file private.'
    } finally { setTimeout(() => URL.revokeObjectURL(url), 1_000) }
  } catch {
    exportError.value = 'Subscriptions could not be downloaded. Your account was not changed. Try again.'
  }
}
async function reloadFinancialViews() {
  await Promise.allSettled([reloadLedger(), refreshPersistedFinancialData(true)])
}
function setConnectionStatuses(statuses: ConnectionStatuses) { financialReadRevision++; connectionStatuses.value = statuses; connectionStatusesError.value = false; connectionReadState.value = successfulReadState(true); connectionReadAt.value = new Date().toISOString() }
function applyCostFeed(feed: typeof costFeed.value) { costFeed.value = feed }
function setCostFeed(feed: typeof costFeed.value) { financialReadRevision++; applyCostFeed(feed); costFeedReadState.value = successfulReadState(feed.snapshots.length > 0); costFeedReadAt.value = new Date().toISOString(); costFeedReadError.value = '' }
function setHostingerState(state: HostingerState) { financialReadRevision++; hostingerState.value = state; hostingerReadState.value = successfulReadState(state.subscriptions.length > 0); hostingerReadAt.value = new Date().toISOString(); hostingerReadError.value = '' }

</script>

<template>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="app-shell">
    <aside class="sidebar">
      <NuxtLink class="brand" to="/" aria-label="StackDues"><span class="brand-mark" aria-hidden="true">S</span><span aria-hidden="true">tackDues</span></NuxtLink>
      <p class="workspace-label">Personal workspace</p>
      <nav aria-label="Primary"><NuxtLink to="/" :aria-current="currentSection === 'overview' ? 'page' : undefined">Overview</NuxtLink><NuxtLink to="/services" :aria-current="currentSection === 'services' ? 'page' : undefined">Services <span class="nav-count">{{ subscriptions.length }}</span></NuxtLink><NuxtLink to="/connections" :aria-current="currentSection === 'connections' ? 'page' : undefined">Connections</NuxtLink><NuxtLink to="/history" :aria-current="currentSection === 'history' ? 'page' : undefined">History</NuxtLink></nav>
      <div class="sidebar-note"><span class="local-indicator" aria-hidden="true"></span><strong>Private to your account</strong><p>Fixed subscriptions are saved to your account and available across devices.</p></div>
    </aside>
    <main id="main-content" ref="mainContent" tabindex="-1">
      <header class="page-header"><div><p class="eyebrow">{{ sectionMeta.eyebrow }}</p><h1>{{ sectionMeta.title }}<span class="heading-period">.</span></h1><p class="muted">{{ sectionMeta.subtitle }}</p><form action="/auth/logout" method="post"><button class="text-button" type="submit">Sign out</button></form></div><div class="header-actions"><NuxtLink v-if="currentSection !== 'connections'" class="primary-button" :to="currentSection === 'overview' && hasConfiguredProvider ? '/services' : '/connections'">{{ currentSection === 'overview' && hasConfiguredProvider ? 'View services' : hasConfiguredProvider ? 'Manage connections' : 'Connect a provider' }}</NuxtLink><NuxtLink v-if="currentSection === 'overview' && hasConfiguredProvider" class="secondary-button" to="/connections">Manage connections</NuxtLink><button v-if="currentSection === 'services' || currentSection === 'overview'" class="secondary-button" :disabled="blocked" @click="openForm()">Add manually</button></div></header>
      <div v-if="storageError" class="error-message storage-error" role="alert">{{ storageError }} <button class="text-button" type="button" :disabled="loading || busy" @click="reloadLedger">Reload subscriptions</button><a v-if="storageError.includes('session expired')" href="/login">Sign in</a></div>
      <p v-if="financialRefreshError" class="feed-warning financial-refresh-warning" role="alert">{{ financialRefreshError }} <button class="text-button" type="button" :disabled="!!financialRefresh" @click="refreshPersistedFinancialData(true)">Try again</button></p>
      <p v-if="hasCostReadFailure" class="error-message" role="alert">{{ costReadMessage }} <button class="text-button" type="button" :disabled="!!financialRefresh" @click="refreshPersistedFinancialData(true)">Try again</button><a v-if="costFeedReadState === 'expired' || costFeedReadState === 'retained-expired'" href="/login">Sign in</a></p>
      <p v-else-if="hasRetainedCostRead" class="feed-warning" role="status">The latest billing data check failed. Showing observations from the last successful read{{ readTime(costFeedReadAt) ? ` on ${readTime(costFeedReadAt)}` : '' }}. <button class="text-button" type="button" :disabled="!!financialRefresh" @click="refreshPersistedFinancialData(true)">Try again</button><a v-if="costFeedReadState === 'retained-expired'" href="/login">Sign in</a></p>
      <p v-if="hasHostingerReadFailure" class="error-message" role="alert">{{ hostingerReadMessage }} <button class="text-button" type="button" :disabled="!!financialRefresh" @click="refreshPersistedFinancialData(true)">Try again</button><a v-if="hostingerReadState === 'expired' || hostingerReadState === 'retained-expired'" href="/login">Sign in</a></p>
      <p v-else-if="hasRetainedHostingerRead" class="feed-warning" role="status">The latest Hostinger data check failed. Showing saved service details from the last successful read{{ readTime(hostingerReadAt) ? ` on ${readTime(hostingerReadAt)}` : '' }}.</p>
      <p v-if="connectionStatusesError" class="feed-warning" role="status">Connection status could not be checked. {{ connectionStatuses ? `Showing the last successful status read${readTime(connectionReadAt) ? ` from ${readTime(connectionReadAt)}` : ''}.` : 'Saved provider access has not been confirmed.' }} <button class="text-button" type="button" :disabled="!!financialRefresh" @click="refreshPersistedFinancialData(true)">Try again</button><a v-if="connectionReadState === 'expired' || connectionReadState === 'retained-expired'" href="/login">Sign in</a></p>
      <template v-if="currentSection === 'overview'">
      <p v-if="loading" role="status">Loading your subscriptions…</p>
      <p v-else-if="busy" role="status">Saving your subscriptions…</p>
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <section v-if="loaded" class="tracked-spending overview-snapshot" aria-labelledby="tracked-spending-title">
        <div class="overview-section-heading"><div><p class="eyebrow">Your spending</p><h2 id="tracked-spending-title">Monthly equivalents and provider costs</h2></div><p class="overview-freshness">{{ overviewFreshness }}</p></div>
        <p class="overview-explanation">Monthly equivalents average active fixed subscriptions for comparison. Upcoming renewals and provider-reported costs are shown separately; amounts are never combined across currencies.</p>
        <p v-if="meteredWarning" class="feed-warning" role="status">{{ meteredWarning }}</p>
        <div v-if="trackedTotals.length" class="tracked-spending-grid">
          <article v-for="total in trackedTotals" :key="total.currency" class="tracked-spending-card overview-currency-card">
            <p class="overview-currency">{{ total.currency }}</p>
            <dl class="overview-spend-pair"><div><dt>Active subscriptions · monthly equivalent</dt><dd :aria-describedby="`fixed-spend-note-${total.currency}`">{{ money(total.fixedMonthly, total.currency) }}</dd></div><div v-if="showMeteredCurrency(total.currency)"><dt>Provider-reported costs · current period</dt><dd :aria-describedby="`metered-spend-note-${total.currency}`">{{ total.meteredActual === null ? 'Not reported' : money(total.meteredActual, total.currency) }}</dd></div></dl>
            <p class="overview-spend-note" :id="`fixed-spend-note-${total.currency}`">Monthly comparison only. Actual fixed charges and dates appear below.</p>
            <p v-if="showMeteredCurrency(total.currency)" class="overview-spend-note" :id="`metered-spend-note-${total.currency}`">{{ actualPeriodLabels[total.currency] ? `Source and period · ${actualPeriodLabels[total.currency]}` : meteredStatus(total.currency) }}</p>
            <dl v-if="total.meteredForecast !== null" class="overview-forecast"><div><dt>Full-month estimate</dt><dd>{{ money(total.meteredForecast, total.currency) }}</dd></div></dl>
          </article>
        </div>
        <p v-if="hostingerCoverageWarning" class="feed-warning hostinger-coverage-warning" role="status">{{ hostingerCoverageWarning }} <NuxtLink to="/services#hostinger-discovery">Review Hostinger services</NuxtLink></p>
        <div v-if="!trackedTotals.length" class="overview-empty"><p>{{ overviewEmptyMessage }}</p><p v-if="!['pending', 'unavailable', 'expired'].includes(costFeedReadState) && !['pending', 'unavailable', 'expired'].includes(connectionReadState)">Connect a provider or add a fixed service to get started.</p><NuxtLink class="text-button" to="/services">Add a fixed service</NuxtLink></div>
      </section>
      <section v-if="loaded" class="overview-next-charges" aria-labelledby="next-charges-title">
        <div class="overview-section-heading"><div><p class="eyebrow">Fixed recurring charges</p><h2 id="next-charges-title">Coming up next</h2></div><div class="overview-section-links"><NuxtLink class="text-button" to="/history#payment-schedule">Full payment schedule</NuxtLink><NuxtLink class="text-button" to="/services">Manage services</NuxtLink></div></div>
        <p v-if="paymentScheduleReadState === 'pending'" class="metric-note" role="status">Checking saved subscriptions and provider coverage; any listed renewals are known saved commitments.</p>
        <p v-else-if="['unavailable', 'expired'].includes(paymentScheduleReadState)" class="metric-note" role="status">Provider or subscription data is unavailable; any listed renewals are known saved commitments and the full schedule is unconfirmed.</p>
        <div class="current-month-schedule" aria-labelledby="current-month-schedule-title"><div><h3 id="current-month-schedule-title">Scheduled fixed charges left in {{ currentMonthLabel }}</h3><p>Upcoming renewal amounts only; excludes provider usage and charges dated earlier this month.</p></div><ul v-if="currentMonthRenewalTotals.length"><li v-for="total in currentMonthRenewalTotals" :key="total.currency"><span>{{ total.currency }}</span><strong>{{ money(total.amount, total.currency) }}</strong></li></ul><p v-else-if="['available', 'empty'].includes(paymentScheduleReadState)" class="current-month-empty">No active fixed renewals remain this month.</p><p v-else class="current-month-empty" role="status">This month’s schedule is not fully confirmed.</p></div>
        <ul v-if="upcomingCharges.length" class="overview-renewal-list"><li v-for="charge in upcomingCharges" :key="`${charge.subscription.id}-${charge.date}`"><button class="overview-renewal-name service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'subscription', id: charge.subscription.id }, $event)">{{ charge.subscription.name }}<span>{{ charge.subscription.provider || 'Fixed subscription' }}</span></button><span class="overview-renewal-date">{{ dateLabel(charge.date) }}</span><strong class="overview-renewal-amount">{{ money(charge.amount, charge.currency) }}</strong></li></ul>
        <p v-else-if="paymentScheduleReadState === 'pending'" class="quiet-empty" role="status">The upcoming schedule is still loading.</p>
        <p v-else-if="['unavailable', 'expired'].includes(paymentScheduleReadState)" class="quiet-empty" role="status">Upcoming renewals could not be fully confirmed because saved subscription or provider data is unavailable.</p>
        <p v-else class="quiet-empty">No active renewal is scheduled in the next year.</p>
        <p v-if="hostingerCoverageWarning" class="feed-warning hostinger-coverage-warning" role="status">{{ hostingerCoverageWarning }} <NuxtLink to="/services#hostinger-discovery">Review Hostinger services</NuxtLink></p>
      </section>
      <section v-if="loaded" class="spending-insights overview-featured-insight" aria-labelledby="spending-insights-title">
        <div class="overview-section-heading"><div><p class="eyebrow">Where metered costs go</p><h2 id="spending-insights-title">Cost drivers</h2></div><NuxtLink class="text-button" to="/history">View history</NuxtLink></div>
        <article v-if="featuredInsight" class="insight-card"><h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: featuredInsight.provider }, $event)">{{ providerName(featuredInsight.provider) }} · {{ featuredInsight.currency }}</button></h3><p class="insight-total">{{ money(featuredInsight.actual, featuredInsight.currency) }}<span> reported actuals</span></p><p v-if="featuredInsight.previousComparable !== null && featuredInsight.changePercent !== null" class="metric-note">{{ money(featuredInsight.previousComparable, featuredInsight.currency) }} in the aligned prior period · {{ featuredInsight.changePercent > 0 ? '+' : '' }}{{ featuredInsight.changePercent.toFixed(1) }}%</p><p v-else class="metric-note">Not enough data to compare yet.</p><ul v-if="featuredInsight.drivers.length" class="insight-drivers" :aria-label="`${providerName(featuredInsight.provider)} ${featuredInsight.currency} cost drivers`"><li v-for="driver in featuredInsight.drivers.slice(0, 3)" :key="driver.service"><span class="insight-driver-name">{{ driver.service }}</span><span class="insight-driver-bar" aria-hidden="true"><span :style="{ width: driverWidth(driver.amount) }"></span></span><strong>{{ money(driver.amount, featuredInsight.currency) }}</strong></li></ul></article>
        <p v-else class="quiet-empty">Reported provider costs will appear after the first successful billing sync.</p>
      </section>
      <details v-if="loaded" class="provider-observations">
        <summary>Provider details and sync status</summary>
      <section v-if="loaded" class="provider-overview" aria-labelledby="provider-overview-title">
        <div class="section-header"><div><p class="eyebrow">Connected providers and fixed renewals</p><h2 id="provider-overview-title">Your spending</h2></div></div>
        <div class="provider-overview-grid">
          <article v-for="provider in meteredProviders" :key="provider" class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider }, $event)">{{ providerName(provider) }} <span class="metric-note">{{ provider === 'openai' ? 'Organization API costs' : 'Metered usage' }}</span></button></h3>
            <template v-if="providerUsage[provider].length">
            <dl v-for="usage in providerUsage[provider]" :key="usage.currency"><div><dt>{{ provider === 'openai' ? 'Organization API costs reported' : 'Provider-reported usage' }} · {{ usage.currency }}</dt><dd>{{ money(usage.hasActual ? usage.actual : null, usage.currency) }}</dd></div><div><dt>Full-month estimate</dt><dd>{{ usage.hasForecast ? money(usage.estimatedMonthly, usage.currency) : missingForecastLabel(provider) }}</dd></div><div><dt>Source period</dt><dd>{{ periodDescription(provider, usage.currency) }}</dd></div></dl>
            </template>
            <p v-else class="metric-note">{{ providerConnectionNote(provider) }}</p>
            <p v-if="costFeed.providers[provider].status === 'error'" class="feed-warning" role="status">Sync failed; last known charges remain visible.</p>
            <p v-else-if="isProviderStale(costFeed.providers[provider])" class="feed-warning" role="status">Last known charges are stale.</p>
            <p v-if="costFeed.providers[provider].lastSyncedAt" class="metric-note">{{ costFeed.providers[provider].status === 'error' ? 'Last successful data · ' : 'Last successful sync · ' }}{{ new Date(costFeed.providers[provider].lastSyncedAt!).toLocaleString() }}</p>
          </article>
          <article class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: 'digitalocean' }, $event)">DigitalOcean <span class="metric-note">Finalized invoice totals</span></button></h3>
            <template v-if="digitalOceanInvoices.length"><div v-for="invoice in digitalOceanInvoices.slice(0, 3)" :key="invoice.id" class="provider-overview-value">{{ money(invoice.amount, invoice.currency) }} <span>· {{ invoice.periodStart.slice(0, 7) }} invoice period</span></div><p class="metric-note">Previews, balances, nightly usage estimates, payments, and credit events are excluded.</p></template>
            <p v-else class="metric-note">{{ providerConnectionNote('digitalocean').replace('billing data', 'finalized invoices') }}</p>
          </article>
          <article class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: 'hostinger' }, $event)">Hostinger <span class="metric-note">Fixed recurring commitments</span></button></h3>
            <div v-for="total in hostingerFixedTotals" :key="total.currency" class="provider-overview-value">{{ money(total.monthly, total.currency) }} <span>/ mo equivalent</span></div>
            <p v-if="!hostingerFixedTotals.length" class="metric-note">{{ hostingerReadState === 'pending' ? 'Checking saved Hostinger services…' : hostingerReadState === 'unavailable' || hostingerReadState === 'expired' ? 'Hostinger services unavailable; retry the data check.' : hostingerIsConfigured() ? 'Connected; eligible renewals appear after sync.' : connectionReadState === 'pending' ? 'Checking saved connection status…' : 'Not connected' }}</p>
            <p v-else class="metric-note">Included in fixed commitments and upcoming renewals.</p>
          </article>
          <article class="provider-overview-card">
            <h3>Manual subscriptions <span class="metric-note">Fixed recurring commitments</span></h3>
            <div v-for="total in manualFixedTotals" :key="total.currency" class="provider-overview-value">{{ money(total.monthly, total.currency) }} <span>/ mo equivalent</span></div>
            <p v-if="!manualFixedTotals.length" class="metric-note">No manual subscriptions yet.</p>
            <p v-else class="metric-note">Per-currency monthly equivalent; upcoming charges are listed below.</p>
          </article>
        </div>
        <p class="metric-note">Actual charges to date are not a full-month projection. Forecasts already include actuals; currencies remain separate. DigitalOcean finalized invoices are shown for their billing periods, not as current-month accrual.</p>
      </section>
      </details>
      </template>
      <section v-if="currentSection === 'services'" id="services" class="services-screen">
      <section id="subscriptions" class="subscriptions-section" aria-labelledby="subscriptions-title"><div class="section-header"><div><p class="eyebrow">Fixed recurring charges</p><h2 id="subscriptions-title">Subscriptions <span v-if="loaded" class="heading-count">{{ subscriptions.length }}</span></h2></div><div class="table-tools"><NuxtLink class="text-button" to="/history#payment-schedule">Payment schedule</NuxtLink><button class="secondary-button" type="button" :disabled="blocked" @click="downloadSubscriptions">Download subscriptions JSON</button></div></div>
        <p v-if="subscriptionsReadState === 'pending'" role="status">Checking saved subscriptions…</p>
        <p v-if="exportError" class="error-message" role="alert">{{ exportError }}</p>
        <div v-if="loaded && !subscriptions.length" class="subscriptions-empty"><h3>No fixed subscriptions yet</h3><p>Provider usage and unlinked Hostinger discoveries appear in the services inventory below; add a service to track fixed renewals.</p></div>
        <ServiceInventory v-if="loaded" v-model:query="search" v-model:status="statusFilter" :subscriptions="subscriptions" :providers="serviceProviders" :discovered="hostingerInventoryRows" :blocked="blocked" :loading="loading || connectionReadState === 'pending' || costFeedReadState === 'pending' || !hostingerStateResolved" :format-money="(amount, currency) => amount === null ? 'Price unavailable' : money(amount, currency)" :recurrence="recurrence" :monthly="item => normalizeCost(item).monthly" :renewal="item => nextRenewalOnOrAfter(item, today) ? dateLabel(nextRenewalOnOrAfter(item, today)!) : '—'" @details="openServiceDetails($event)" @edit="openForm" @toggle="setStatus" @remove="remove" @review="openHostingerManagement" />
      </section>
      <LegacyImport v-if="loaded" :disabled="blocked" :existing-subscriptions="subscriptions" :import-subscriptions="importLedger" />
      <p v-if="!hostingerStateResolved" role="status">Checking saved Hostinger services…</p>
      <details v-if="hostingerStateResolved" ref="hostingerDisclosure" class="inventory-management"><summary>Hostinger matching, exclusions and sync controls</summary><KeepAlive><HostingerDiscovery v-if="currentSection === 'services'" :initial="hostingerState" :ledger="subscriptions" @changed="reloadLedger" @loaded="setHostingerState" /></KeepAlive></details>
      <details v-if="connectionStatusesResolved" class="inventory-management"><summary>Provider usage reports and technical details</summary><KeepAlive><InfrastructurePanel v-if="currentSection === 'services'" :initial-feed="costFeed" :fixed-totals="totals" :today="today" :configured-providers="connectedBillingProviders" :feed-read-state="costFeedReadState" :feed-read-at="costFeedReadAt" @details="openProviderDetails($event)" /></KeepAlive></details>
      </section>
      <p v-if="currentSection === 'connections' && !connectionStatusesResolved" role="status">Checking saved provider connections…</p>
      <KeepAlive><ConnectionsPanel v-if="currentSection === 'connections' && connectionStatusesResolved" :initial-statuses="connectionStatuses" :cost-feed="costFeed" :hostinger="hostingerState" @loaded="setConnectionStatuses" @changed="reloadFinancialViews" @details="openProviderDetails($event)" /></KeepAlive>
      <section v-if="currentSection === 'history'" class="history-screen">
        <div class="content-columns single-column"><SpendingTimeline :subscriptions="confirmedSubscriptions" :snapshots="costFeed.snapshots" :today="today" :hostinger-coverage-warning="hostingerCoverageWarning" :subscriptions-state="paymentScheduleReadState" :subscriptions-read-at="subscriptionsReadAt" :cost-feed-state="costFeedReadState" :cost-feed-read-at="costFeedReadAt" @select="openServiceDetails($event)" /></div>
        <CostHistory :snapshots="costFeed.snapshots" :read-state="costFeedReadState" :last-read-at="costFeedReadAt" />
      </section>
      <footer class="app-footer"><span>StackDues</span><p>Fixed subscriptions are saved privately to your account. Existing browser data remains untouched.</p></footer>
    </main>
  </div>
  <SubscriptionForm v-if="showForm" :subscription="editing" :today="today" :save-failure="formSaveFailure" :recovery-notice="formRecoveryNotice" :review-required="formReviewRequired" :can-retry="formCanRetry" :checking-save="formCheckingSave" :saving="busy" :aria-busy="busy" @save="save" @check-save="checkFormSave" @confirm-latest="confirmLatestForDraft" @close="closeForm" />
  <ServiceDetail v-if="serviceSelection" :selection="serviceSelection" :feed="costFeed" :subscriptions="subscriptions" :subscriptions-loaded="loaded" :today="today" :hostinger-sync="hostingerState?.sync" :hostinger-rows="hostingerState?.subscriptions" :connection-statuses="connectionStatuses" :connection-read-state="connectionReadState" :cost-feed-read-state="costFeedReadState" :cost-feed-read-at="costFeedReadAt" :hostinger-read-state="hostingerReadState" :hostinger-read-at="hostingerReadAt" @close="closeServiceDetails" @edit="editDetailedSubscription" />
</template>
