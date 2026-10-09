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
import type { ServiceSelection } from './domain/service-selection'
import { nextRenewalOnOrAfter, normalizeCost, normalizedTotals, upcomingRenewals, type Subscription } from './domain/subscriptions'
import { currentCostSnapshots, emptyCostFeed, fetchCostFeed, isProviderStale } from './lib/cost-feed'
import { trackedSpendingTotals, usageTotals, type CostProvider } from './domain/usage-costs'
import { overviewInsights } from './domain/overview-insights'
import { fetchConnections, type ConnectionStatuses } from './lib/connection-api'
import { readHostingerDiscovery, type HostingerDiscovery as HostingerState } from './lib/hostinger-api'
import { createStoredSubscription, deleteStoredSubscription, fetchSubscriptions, importStoredSubscriptions, serializeSubscriptionExport, SUBSCRIPTION_EXPORT_FILENAME, updateStoredSubscription, type StoredSubscription, type ImportResult } from './lib/subscription-api'

const costFeed = ref(emptyCostFeed())
const costFeedResolved = ref(false)
const costFeedLoaded = ref(false)
const connectionStatusesResolved = ref(false)
const hostingerStateResolved = ref(false)
const infrastructure = ref<InstanceType<typeof InfrastructurePanel>>()
const hostinger = ref<InstanceType<typeof HostingerDiscovery>>()
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
const blocked = computed(() => loading.value || busy.value || !loaded.value || storageError.value !== null)
async function reloadLedger() {
  if (loading.value && loaded.value) return
  loading.value = true
  try { subscriptions.value = await fetchSubscriptions(); storageError.value = null; loaded.value = true }
  catch (cause) { storageError.value = cause instanceof Error ? cause.message : 'Subscriptions could not be loaded. Reload before making changes.' }
  finally { loading.value = false }
}
const legacyPaths: Record<string, string> = { overview: '/', subscriptions: '/services', connections: '/connections', history: '/history', infrastructure: '/services', 'hostinger-discovery': '/services' }
function normalizeLegacyHash(hash = route.value.hash) {
  const section = hash.slice(1) || window.location.hash.slice(1)
  if (section && legacyPaths[section]) void router.replace({ path: legacyPaths[section]!, hash: '' })
}
watch(() => route.value.hash, hash => { if (hash) normalizeLegacyHash(hash) })
onMounted(() => {
  void reloadLedger()
  void fetchCostFeed('/api/costs').then(setCostFeed).catch(() => {}).finally(() => { costFeedResolved.value = true })
  void fetchConnections().then(statuses => { connectionStatuses.value = statuses }).catch(() => {}).finally(() => { connectionStatusesResolved.value = true })
  void readHostingerDiscovery().then(state => { hostingerState.value = state }).catch(() => {}).finally(() => { hostingerStateResolved.value = true })
  normalizeLegacyHash(route.value.hash)
  if (!routeSections[route.value.path]) void router.replace('/')
})
watch(currentSection, async () => { await nextTick(); mainContent.value?.focus() })
const notice = ref('')
const exportError = ref('')
const today = ref(new Date().toISOString().slice(0, 10))
const timer = window.setInterval(() => { today.value = new Date().toISOString().slice(0, 10) }, 60_000)
onUnmounted(() => { window.clearInterval(timer) })
const showForm = ref(false)
const editing = ref<StoredSubscription>()
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
  void closeServiceDetails()
  if (stored) openForm(stored)
}
const hasConfiguredProvider = computed(() => Object.values(connectionStatuses.value ?? {}).some(status => status.configured))
const totals = computed(() => normalizedTotals(subscriptions.value))
const meterSnapshots = computed(() => currentCostSnapshots(costFeed.value))
const connectedMeteredProviders = computed(() => (['aws', 'cloudflare', 'openai'] as const).filter(provider => costFeed.value.providers[provider].status !== 'not-configured'))
const connectedBillingProviders = computed(() => (['aws', 'cloudflare', 'openai', 'digitalocean'] as const).filter(provider => costFeed.value.providers[provider].status !== 'not-configured'))
const meteredTotals = computed(() => usageTotals(meterSnapshots.value, today.value, connectedMeteredProviders.value))
const trackedTotals = computed(() => trackedSpendingTotals(totals.value, meteredTotals.value, connectedMeteredProviders.value, meterSnapshots.value))
const providerUsage = computed(() => ({
  aws: usageTotals(meterSnapshots.value, today.value, ['aws']),
  cloudflare: usageTotals(meterSnapshots.value, today.value, ['cloudflare']),
  openai: usageTotals(meterSnapshots.value, today.value, ['openai']),
}))
const actualPeriodLabels = computed(() => Object.fromEntries(trackedTotals.value.map(({ currency }) => [currency, meteredProviders.map(provider => {
  const usage = providerUsage.value[provider].find(item => item.currency === currency && item.hasActual)
  return usage ? `${providerName(provider)} · ${periodDescription(provider, currency)}` : null
}).filter((value): value is string => value !== null).join(' · ')])))
const spendingInsights = computed(() => overviewInsights(costFeed.value.snapshots))
const featuredInsight = computed(() => spendingInsights.value.find(item => item.drivers.length || item.changePercent !== null) ?? spendingInsights.value[0])
const lastSuccessfulSync = computed(() => [
  ...Object.values(costFeed.value.providers).map(provider => provider.lastSyncedAt),
  hostingerState.value?.sync.lastSyncedAt,
].filter((value): value is string => typeof value === 'string').sort().at(-1) ?? null)
const upcomingCharges = computed(() => upcomingRenewals(confirmedSubscriptions.value, today.value, endDate(365)).slice(0, 3))
const hostingerLinkedIds = computed(() => new Set((hostingerState.value?.subscriptions ?? []).map(item => item.linkedSubscriptionId).filter((id): id is string => !!id)))
const hostingerFixedTotals = computed(() => normalizedTotals(subscriptions.value.filter(item => item.provider === 'Hostinger' || hostingerLinkedIds.value.has(item.id))))
const manualFixedTotals = computed(() => normalizedTotals(subscriptions.value.filter(item => item.provider !== 'Hostinger' && !hostingerLinkedIds.value.has(item.id))))
const configuredMeteredProviders = computed(() => (['aws', 'cloudflare', 'openai', 'digitalocean'] as const).filter(provider => connectionStatuses.value?.[provider].configured))
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
const confirmedSubscriptions = computed(() => subscriptions.value.filter(item => item.provider !== 'Hostinger' || !hostingerState.value?.subscriptions.some(source => source.linkedSubscriptionId === item.id) || currentHostingerLedger.value.has(item.id)))
const hasStaleHostinger = computed(() => !!hostingerState.value?.subscriptions.some(item => item.linkedSubscriptionId && !item.seenInLatestSync))
const visibleSubscriptions = computed(() => subscriptions.value.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value) && `${item.name} ${item.provider ?? ''}`.toLowerCase().includes(search.value.toLowerCase())))
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
function openForm(item?: StoredSubscription) { if (blocked.value) return; editing.value = item; showForm.value = true }
function mutationError(cause: unknown) { storageError.value = cause instanceof Error ? cause.message : 'Changes could not be confirmed. Reload before making changes.' }
async function save(item: Subscription) {
  if (blocked.value) return
  busy.value = true
  try {
    const saved = editing.value ? await updateStoredSubscription(item, editing.value.revision) : await createStoredSubscription(item)
    if (saved.id !== item.id) throw new Error('The saved subscription could not be confirmed. Reload before making changes.')
    subscriptions.value = subscriptions.value.some(({ id }) => id === saved.id) ? subscriptions.value.map(existing => existing.id === saved.id ? saved : existing) : [...subscriptions.value, saved]
    storageError.value = null; notice.value = `${item.name} saved.`; showForm.value = false
  } catch (cause) { mutationError(cause) }
  finally { busy.value = false }
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
  const reloadCosts = async () => {
    if (infrastructure.value) await infrastructure.value.reload()
    else setCostFeed(await fetchCostFeed('/api/costs'))
  }
  const reloadHostinger = async () => {
    if (hostinger.value) await hostinger.value.reload()
    else hostingerState.value = await readHostingerDiscovery()
  }
  await Promise.allSettled([reloadLedger(), reloadCosts(), reloadHostinger()])
}
function setConnectionStatuses(statuses: ConnectionStatuses) { connectionStatuses.value = statuses }
function setCostFeed(feed: typeof costFeed.value) { costFeed.value = feed; costFeedLoaded.value = true }

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
      <header class="page-header"><div><p class="eyebrow">{{ sectionMeta.eyebrow }}</p><h1>{{ sectionMeta.title }}<span class="heading-period">.</span></h1><p class="muted">{{ sectionMeta.subtitle }}</p><form action="/auth/logout" method="post"><button class="text-button" type="submit">Sign out</button></form></div><div class="header-actions"><NuxtLink v-if="currentSection !== 'connections'" class="primary-button" to="/connections">{{ hasConfiguredProvider ? 'Manage connections' : 'Connect a provider' }}</NuxtLink><button v-if="currentSection === 'services' || currentSection === 'overview'" class="secondary-button" :disabled="blocked" @click="openForm()">Add manually</button></div></header>
      <div v-if="storageError" class="error-message storage-error" role="alert">{{ storageError }} <button class="text-button" type="button" :disabled="loading || busy" @click="reloadLedger">Reload subscriptions</button><a v-if="storageError.includes('session expired')" href="/login">Sign in</a></div>
      <template v-if="currentSection === 'overview'">
      <p v-if="loading" role="status">Loading your subscriptions…</p>
      <p v-else-if="busy" role="status">Saving your subscriptions…</p>
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <section v-if="loaded" class="tracked-spending overview-snapshot" aria-labelledby="tracked-spending-title">
        <div class="overview-section-heading"><div><p class="eyebrow">Your monthly picture</p><h2 id="tracked-spending-title">Known spending</h2></div><p v-if="lastSuccessfulSync" class="overview-freshness">{{ costFeed.snapshots.length ? 'Updated' : 'Checked' }} {{ dateLabel(lastSuccessfulSync.slice(0, 10)) }}</p><p v-else class="overview-freshness">{{ hasConfiguredProvider ? 'Waiting for first billing data' : 'No billing connections yet' }}</p></div>
        <p v-if="meteredWarning" class="feed-warning" role="status">{{ meteredWarning }}</p>
        <div v-if="trackedTotals.length" class="tracked-spending-grid">
          <article v-for="total in trackedTotals" :key="total.currency" class="tracked-spending-card overview-currency-card">
            <p class="overview-currency">{{ total.currency }}</p>
            <p class="overview-primary-value">{{ total.combinedMonthlyEstimate === null ? money(total.fixedMonthly, total.currency) : money(total.combinedMonthlyEstimate, total.currency) }}</p>
            <p class="overview-value-label">{{ total.combinedMonthlyEstimate === null ? 'Known fixed monthly commitments' : 'Estimated monthly spend' }}</p>
            <dl class="overview-breakdown"><div><dt>Fixed monthly equivalent</dt><dd>{{ money(total.fixedMonthly, total.currency) }}</dd></div><div><dt>Metered actual · month to date</dt><dd>{{ total.meteredActual === null ? 'Not reported' : money(total.meteredActual, total.currency) }}</dd></div><div><dt>Metered full-month forecast</dt><dd>{{ total.meteredForecast === null ? 'Unavailable' : money(total.meteredForecast, total.currency) }}</dd></div></dl>
            <p v-if="actualPeriodLabels[total.currency]" class="overview-period-note">Reported periods · {{ actualPeriodLabels[total.currency] }}</p>
            <p v-if="total.combinedMonthlyEstimate === null && connectedMeteredProviders.length" class="metric-note">Known fixed and reported actual costs remain visible while a complete forecast is unavailable.</p>
          </article>
        </div>
        <div v-else class="overview-empty"><p>No spending data has arrived yet.</p><p>Connect a provider or add a fixed service to get started.</p><NuxtLink class="text-button" to="/services">Add a fixed service</NuxtLink></div>
      </section>
      <section v-if="loaded" class="overview-next-charges" aria-labelledby="next-charges-title">
        <div class="overview-section-heading"><div><p class="eyebrow">Fixed recurring charges</p><h2 id="next-charges-title">Coming up next</h2></div><NuxtLink class="text-button" to="/services">Manage services</NuxtLink></div>
        <ul v-if="upcomingCharges.length" class="overview-renewal-list"><li v-for="charge in upcomingCharges" :key="`${charge.subscription.id}-${charge.date}`"><button class="overview-renewal-name service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'subscription', id: charge.subscription.id }, $event)">{{ charge.subscription.name }}<span>{{ charge.subscription.provider || 'Fixed subscription' }}</span></button><span class="overview-renewal-date">{{ dateLabel(charge.date) }}</span><strong class="overview-renewal-amount">{{ money(charge.amount, charge.currency) }}</strong></li></ul>
        <p v-else class="quiet-empty">No confirmed renewals are scheduled in the next year.</p>
        <p v-if="hasStaleHostinger" class="feed-warning" role="status">Some Hostinger renewal dates need confirmation and are omitted here. <NuxtLink to="/services">Review Hostinger services</NuxtLink></p>
      </section>
      <section v-if="loaded" class="spending-insights overview-featured-insight" aria-labelledby="spending-insights-title">
        <div class="overview-section-heading"><div><p class="eyebrow">One useful signal</p><h2 id="spending-insights-title">Cost driver &amp; trend</h2></div><NuxtLink class="text-button" to="/history">View history</NuxtLink></div>
        <article v-if="featuredInsight" class="insight-card"><h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: featuredInsight.provider }, $event)">{{ providerName(featuredInsight.provider) }} · {{ featuredInsight.currency }}</button></h3><p class="insight-total">{{ money(featuredInsight.actual, featuredInsight.currency) }}<span> reported actuals</span></p><p v-if="featuredInsight.previousComparable !== null && featuredInsight.changePercent !== null" class="metric-note">{{ money(featuredInsight.previousComparable, featuredInsight.currency) }} in the aligned prior period · {{ featuredInsight.changePercent > 0 ? '+' : '' }}{{ featuredInsight.changePercent.toFixed(1) }}%</p><p v-else class="metric-note">No aligned prior period is available yet.</p><ul v-if="featuredInsight.drivers.length" class="insight-drivers"><li v-for="driver in featuredInsight.drivers.slice(0, 1)" :key="driver.service"><span>Top service · {{ driver.service }}</span><strong>{{ money(driver.amount, featuredInsight.currency) }}</strong></li></ul></article>
        <p v-else class="quiet-empty">A cost trend will appear after enough provider history is available.</p>
      </section>
      <details v-if="loaded" class="provider-observations">
        <summary>Provider details and sync status</summary>
      <section v-if="loaded" class="provider-overview" aria-labelledby="provider-overview-title">
        <div class="section-header"><div><p class="eyebrow">Connected providers and fixed renewals</p><h2 id="provider-overview-title">Your spending</h2></div></div>
        <div class="provider-overview-grid">
          <article v-for="provider in meteredProviders" :key="provider" class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider }, $event)">{{ providerName(provider) }} <span class="metric-note">{{ provider === 'openai' ? 'Organization API costs' : 'Metered usage' }}</span></button></h3>
            <template v-if="providerUsage[provider].length">
              <dl v-for="usage in providerUsage[provider]" :key="usage.currency"><div><dt>{{ provider === 'openai' ? 'Reported API costs to date' : 'Actual charges to date' }} · {{ usage.currency }}</dt><dd>{{ money(usage.hasActual ? usage.actual : null, usage.currency) }}</dd></div><div><dt>Full-month forecast</dt><dd>{{ usage.hasForecast ? money(usage.estimatedMonthly, usage.currency) : 'Forecast unavailable' }}</dd></div><div><dt>Reported period</dt><dd>{{ periodDescription(provider, usage.currency) }}</dd></div></dl>
            </template>
            <p v-else class="metric-note">{{ connectionStatuses?.[provider].configured ? 'Connected; billing observations are not available yet.' : 'Not connected' }}</p>
            <p v-if="costFeed.providers[provider].status === 'error'" class="feed-warning" role="status">Sync failed; last known charges remain visible.</p>
            <p v-else-if="isProviderStale(costFeed.providers[provider])" class="feed-warning" role="status">Last known charges are stale.</p>
            <p v-if="costFeed.providers[provider].lastSyncedAt" class="metric-note">Last successful sync · {{ new Date(costFeed.providers[provider].lastSyncedAt!).toLocaleString() }}</p>
          </article>
          <article class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: 'digitalocean' }, $event)">DigitalOcean <span class="metric-note">Finalized invoice totals</span></button></h3>
            <template v-if="digitalOceanInvoices.length"><div v-for="invoice in digitalOceanInvoices.slice(0, 3)" :key="invoice.id" class="provider-overview-value">{{ money(invoice.amount, invoice.currency) }} <span>· {{ invoice.periodStart.slice(0, 7) }} invoice period</span></div><p class="metric-note">Previews, balances, nightly usage estimates, payments, and credit events are excluded.</p></template>
            <p v-else class="metric-note">{{ connectionStatuses?.digitalocean.configured ? 'Connected; finalized invoices are not available yet.' : 'Not connected' }}</p>
          </article>
          <article class="provider-overview-card">
            <h3><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'provider', provider: 'hostinger' }, $event)">Hostinger <span class="metric-note">Fixed recurring commitments</span></button></h3>
            <div v-for="total in hostingerFixedTotals" :key="total.currency" class="provider-overview-value">{{ money(total.monthly, total.currency) }} <span>/ mo equivalent</span></div>
            <p v-if="!hostingerFixedTotals.length" class="metric-note">{{ connectionStatuses?.hostinger.configured ? 'Connected; eligible renewals appear after sync.' : 'Not connected' }}</p>
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
      <section id="subscriptions" class="subscriptions-section" aria-labelledby="subscriptions-title"><div class="section-header"><div><p class="eyebrow">Fixed recurring charges</p><h2 id="subscriptions-title">Subscriptions <span v-if="loaded" class="heading-count">{{ subscriptions.length }}</span></h2></div><div class="table-tools"><button class="secondary-button" type="button" :disabled="blocked" @click="downloadSubscriptions">Download subscriptions JSON</button><template v-if="subscriptions.length"><label class="sr-only" for="subscription-search">Search subscriptions</label><input id="subscription-search" v-model="search" type="search" placeholder="Search subscriptions" /><label class="sr-only" for="status-filter">Filter by status</label><select id="status-filter" v-model="statusFilter"><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></template></div></div>
        <p v-if="exportError" class="error-message" role="alert">{{ exportError }}</p>
        <div v-if="loaded && !subscriptions.length" class="subscriptions-empty"><h3>No manual subscriptions yet</h3><p>Connect a provider above to sync your costs, or add services such as Bitwarden Premium and ChatGPT Plus yourself.</p></div>
        <div v-else-if="subscriptions.length" class="table-scroll"><table><thead><tr><th scope="col">Subscription</th><th scope="col">Charge / cycle</th><th scope="col">Monthly equivalent</th><th scope="col">Next renewal</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr v-for="item in visibleSubscriptions" :key="item.id"><th scope="row"><button class="service-detail-trigger" type="button" @click="openServiceDetails({ kind: 'subscription', id: item.id }, $event)"><strong>{{ item.name }}</strong><span class="cell-note">{{ item.provider || 'Fixed subscription' }}</span></button></th><td><strong class="amount">{{ money(item.amount, item.currency) }}</strong><span class="cell-note">{{ recurrence(item) }}</span></td><td class="amount">{{ money(normalizeCost(item).monthly, item.currency) }}</td><td>{{ nextRenewalOnOrAfter(item, today) ? dateLabel(nextRenewalOnOrAfter(item, today)!) : '—' }}</td><td><span class="status-pill" :class="`status-${item.status}`">{{ item.status }}</span></td><td><div class="row-actions"><button class="text-button" :disabled="blocked" :aria-label="`Edit ${item.name}`" @click="openForm(item)">Edit</button><button class="text-button" :disabled="blocked" :aria-label="`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name} in subscriptions`" @click="setStatus(item)">{{ item.status === 'active' ? 'Pause' : 'Resume' }}</button><button class="text-button delete-button" :disabled="blocked" :aria-label="`Delete ${item.name}`" @click="remove(item)">Delete</button></div></td></tr><tr v-if="!visibleSubscriptions.length"><td colspan="6" class="no-results">No subscriptions match your filters.</td></tr></tbody></table></div>
      </section>
      <LegacyImport v-if="loaded" :disabled="blocked" :existing-subscriptions="subscriptions" :import-subscriptions="importLedger" />
      <KeepAlive><HostingerDiscovery v-if="currentSection === 'services' && hostingerStateResolved" ref="hostinger" :initial="hostingerState" :ledger="subscriptions" :configured="connectionStatuses?.hostinger.configured ?? false" @changed="reloadLedger" @loaded="hostingerState = $event" /></KeepAlive>
      <KeepAlive><InfrastructurePanel v-if="currentSection === 'services' && costFeedResolved && hostingerStateResolved" ref="infrastructure" :initial-feed="costFeed" :has-initial-feed="costFeedLoaded" :fixed-totals="totals" :configured-providers="configuredMeteredProviders" :today="today" @loaded="setCostFeed" @details="openProviderDetails($event)" /></KeepAlive>
      </section>
      <KeepAlive><ConnectionsPanel v-if="currentSection === 'connections' && connectionStatusesResolved" :initial-statuses="connectionStatuses" :cost-feed="costFeed" :hostinger-sync="hostingerState?.sync" @loaded="setConnectionStatuses" @changed="reloadFinancialViews" @details="openProviderDetails($event)" /></KeepAlive>
      <section v-if="currentSection === 'history'" class="history-screen">
        <div class="content-columns single-column"><SpendingTimeline :subscriptions="confirmedSubscriptions" :snapshots="costFeed.snapshots" :today="today" @select="openServiceDetails($event)" /></div>
        <CostHistory :snapshots="costFeed.snapshots" />
      </section>
      <footer class="app-footer"><span>StackDues</span><p>Fixed subscriptions are saved privately to your account. Existing browser data remains untouched.</p></footer>
    </main>
  </div>
  <SubscriptionForm v-if="showForm" :subscription="editing" :today="today" :save-error="storageError" :saving="busy" :aria-busy="busy" @save="save" @close="showForm = false" />
  <ServiceDetail v-if="serviceSelection" :selection="serviceSelection" :feed="costFeed" :subscriptions="subscriptions" :subscriptions-loaded="loaded" :today="today" :hostinger-sync="hostingerState?.sync" :hostinger-rows="hostingerState?.subscriptions" @close="closeServiceDetails" @edit="editDetailedSubscription" />
</template>
