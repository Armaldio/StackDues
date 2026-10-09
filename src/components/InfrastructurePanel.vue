<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { latestCostSnapshots, normalizeUsageAmount, trackedSpendingTotals, usageTotals, type CostBreakdown, type CostProvider, type CostSnapshot } from '../domain/usage-costs'
import type { CurrencyTotal } from '../domain/subscriptions'
import { currentCostSnapshots, emptyCostFeed, parseCostFeed, isProviderStale, type CostFeed } from '../lib/cost-feed'

import { ConnectionApiError, refreshProviders } from '../lib/connection-api'

const props = defineProps<{ fixedTotals: CurrencyTotal[]; configuredProviders: CostProvider[]; today: string }>()
const emit = defineEmits<{ loaded: [feed: CostFeed]; details: [provider: CostProvider] }>()
const feed = ref(emptyCostFeed())
const loading = ref(false)
const error = ref('')
const refreshing = ref(false)
const refreshError = ref('')
const expired = ref(false)
const providers: CostProvider[] = ['aws', 'cloudflare', 'openai', 'digitalocean']
let feedLoaded = false
let staleRefreshStarted = false
const activeSnapshots = computed(() => currentCostSnapshots(feed.value))
const totals = computed(() => usageTotals(activeSnapshots.value, props.today, forecastProviders.value))
const latest = computed(() => latestCostSnapshots(activeSnapshots.value).filter(row => row.kind === 'actual' && (row.metadata?.period === 'current' || row.metadata?.scope === 'finalized-invoice-total')))
const connectedProviders = computed(() => providers.filter(provider => feed.value.providers[provider].status !== 'not-configured'))
// DigitalOcean reports finalized invoice periods, not a current-month forecast; it must not suppress other providers' projections.
const forecastProviders = computed(() => connectedProviders.value.filter(provider => provider !== 'digitalocean'))
const combined = computed(() => trackedSpendingTotals(props.fixedTotals, totals.value, forecastProviders.value, activeSnapshots.value))
function money(amount: number, currency: string) { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount) }
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function name(provider: CostProvider) { return provider === 'aws' ? 'Amazon Web Services' : provider === 'cloudflare' ? 'Cloudflare' : provider === 'openai' ? 'OpenAI API' : 'DigitalOcean' }
function current(provider: CostProvider): CostSnapshot[] {
  const rows = latest.value.filter(row => row.provider === provider)
  const newest = Math.max(...rows.map(row => Date.parse(row.capturedAt)))
  const captured = rows.filter(row => Date.parse(row.capturedAt) === newest)
  if (provider !== 'openai') return captured
  const byCurrency = new Map<string, (typeof captured)[number][]>()
  for (const row of captured) byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row])
  return [...byCurrency].map(([currency, group]) => {
    const services = new Map<string, number>()
    for (const row of group) for (const item of breakdown(row.metadata?.breakdown)) {
      services.set(item.service, normalizeUsageAmount((services.get(item.service) ?? 0) + item.amount))
    }
    const reportedThrough = group.map(row => row.metadata?.reportedThrough).filter((value): value is string => typeof value === 'string').sort().at(-1)
    return {
      ...group[0]!,
      id: `openai:current:${currency}:${newest}`,
      periodStart: group.map(row => row.periodStart).sort()[0]!,
      periodEnd: group.map(row => row.periodEnd).sort().at(-1)!,
      amount: normalizeUsageAmount(group.reduce((sum, row) => sum + row.amount, 0)),
      metadata: { period: 'current', scope: 'organization-api-costs', ...(reportedThrough ? { reportedThrough } : {}), breakdown: [...services].map(([service, amount]) => ({ service, amount, currency })) },
    } as CostSnapshot
  })
}
function previous(provider: CostProvider, currency: string) {
  return latestCostSnapshots(feed.value.snapshots).filter(row => row.provider === provider && row.currency === currency && row.metadata?.period === 'previous-comparable').at(-1)
}
function forecast(provider: CostProvider, currency: string) {
  const rows = activeSnapshots.value.filter(row => row.provider === provider)
  const newest = Math.max(...rows.map(row => Date.parse(row.capturedAt)))
  return rows.find(row => row.kind === 'forecast' && row.currency === currency && Date.parse(row.capturedAt) === newest)
}
function breakdown(value: unknown): readonly CostBreakdown[] { return Array.isArray(value) ? value as CostBreakdown[] : [] }
async function reload() {
  if (loading.value) return
  loading.value = true
  try {
    const response = await fetch('/api/costs', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    if (response.status === 401) throw new ConnectionApiError('Your session expired. Sign in again, then reload.', 401)
    if (!response.ok) throw new Error('Cost data unavailable')
    feed.value = parseCostFeed(await response.json()); error.value = ''; expired.value = false; emit('loaded', feed.value)
    feedLoaded = true
  }
  catch (cause) { expired.value = cause instanceof ConnectionApiError && cause.status === 401; error.value = expired.value ? 'Your session expired. Sign in again, then reload.' : 'Infrastructure data could not be loaded. Previous observations are still displayed. Try again.' }
  finally { loading.value = false }
}
async function refresh(provider?: CostProvider) {
  if (refreshing.value || loading.value) return
  refreshing.value = true; refreshError.value = ''
  try { await refreshProviders(provider); await reload() }
  catch (cause) { refreshError.value = cause instanceof Error ? cause.message : 'Provider refresh failed. Previous observations are retained.'; expired.value = cause instanceof ConnectionApiError && cause.status === 401 }
  finally { refreshing.value = false }
}
async function refreshStaleProviders() {
  if (!feedLoaded || staleRefreshStarted) return
  const now = Date.now()
  const stale = props.configuredProviders.filter(provider => {
    const status = feed.value.providers[provider]
    const lastAttempt = status.lastAttemptAt ? Date.parse(status.lastAttemptAt) : 0
    const hasNoSuccessfulSync = !status.lastSyncedAt
    return (hasNoSuccessfulSync || isProviderStale(status)) && now - lastAttempt >= 6 * 60 * 60 * 1000
  })
  if (!stale.length) return
  staleRefreshStarted = true
  await refresh(stale.length === providers.length ? undefined : stale[0])
}
defineExpose({ reload })
let timer: ReturnType<typeof setInterval> | undefined
onMounted(async () => { await reload(); void refreshStaleProviders(); timer = setInterval(() => { if (!refreshing.value) void reload() }, 15 * 60 * 1000) })
onUnmounted(() => { if (timer !== undefined) clearInterval(timer) })
watch(() => props.configuredProviders.join(','), () => { void refreshStaleProviders() })
</script>

<template>
  <section id="infrastructure" class="infrastructure-section" aria-labelledby="infra-heading">
    <div class="section-header"><div><p class="eyebrow">Metered usage</p><h2 id="infra-heading">Infrastructure</h2></div><div class="provider-refresh-actions"><button type="button" class="secondary-button" :disabled="loading || refreshing" @click="reload">{{ loading ? 'Loading…' : 'Reload cost data' }}</button><button type="button" class="primary-button" :disabled="loading || refreshing" @click="refresh()">{{ refreshing ? 'Refreshing…' : 'Refresh providers' }}</button></div></div>
    <p class="section-description">Reported provider spend stays separate from your fixed commitments. Forecasts include actual spend; they are never added to it. Disconnected providers are excluded from tracked totals.</p>
    <p class="metric-note refresh-description">Refresh providers fetches reported costs from connected AWS, Cloudflare, OpenAI API and DigitalOcean accounts. DigitalOcean provides finalized invoice totals only; previews, estimates, balances and cash events are not included. Reload cost data reads stored observations.</p>
    <p v-if="error" role="alert" class="feed-warning">{{ error }}</p><p v-if="refreshError" role="alert" class="feed-warning">{{ refreshError }}</p><p v-if="expired"><a href="/login">Sign in</a></p>
    <div v-if="totals.length" class="usage-summary">
      <div v-for="total in combined" :key="total.currency" class="usage-total">
        <p class="eyebrow">{{ total.currency }} · current reported period</p><strong>{{ total.meteredActual === null ? 'Unavailable' : money(total.meteredActual, total.currency) }}</strong><span>Actual metered spend</span>
        <p v-if="total.meteredForecast !== null">{{ money(total.meteredForecast, total.currency) }} forecast / month</p>
        <p v-else>Monthly forecast unavailable</p>
        <p v-if="total.combinedMonthlyEstimate !== null" class="combined-total">{{ money(total.combinedMonthlyEstimate, total.currency) }} tracked estimated monthly total, including fixed commitments</p>
        <p v-else-if="connectedProviders.length" class="feed-warning">Combined estimate unavailable until every connected provider reports a complete forecast in this currency.</p>
        <p v-else class="metric-note">Fixed commitments only; no metered providers are connected.</p>
        <p v-if="total.meteredYearlyForecast !== null" class="combined-total">{{ Number.isFinite(total.fixedYearly + total.meteredYearlyForecast) ? money(total.fixedYearly + total.meteredYearlyForecast, total.currency) : 'Annual total unavailable' }} tracked annualized estimate</p>
      </div>
    </div>
    <div class="provider-grid">
      <article v-for="provider in providers" :key="provider" class="provider-panel">
        <header><div><span class="provider-mark" aria-hidden="true">{{ provider === 'aws' ? 'a' : provider === 'cloudflare' ? 'c' : 'o' }}</span><h3><button class="service-detail-trigger" type="button" @click="emit('details', provider)">{{ name(provider) }}</button></h3></div><span class="status-label" :class="feed.providers[provider].status">{{ feed.providers[provider].status === 'not-configured' ? 'Not connected' : feed.providers[provider].status === 'error' ? 'Sync failed' : 'Connected' }}</span></header>
        <p v-if="feed.providers[provider].error" class="feed-warning" role="status">{{ feed.providers[provider].error }}</p>
        <p v-if="isProviderStale(feed.providers[provider])" class="feed-warning">Data is over 36 hours old. The last successful observations are retained.</p>
        <template v-if="current(provider).length">
          <div v-for="snapshot in current(provider)" :key="snapshot.id" class="provider-cost">
            <strong>{{ money(snapshot.amount, snapshot.currency) }}</strong><span>{{ provider === 'digitalocean' ? `Finalized invoice total · ${snapshot.periodStart.slice(0, 7)}` : provider === 'cloudflare' ? 'Billing period to date' : provider === 'openai' ? 'Organization-reported API costs · month to date' : 'Month to date' }}</span>
            <p>{{ snapshot.periodStart }} → {{ snapshot.periodEnd }} (end exclusive)</p>
            <p v-if="previous(provider, snapshot.currency)">{{ money(previous(provider, snapshot.currency)!.amount, snapshot.currency) }} in the comparable previous-month period</p>
            <p v-if="forecast(provider, snapshot.currency)">{{ money(forecast(provider, snapshot.currency)!.amount, snapshot.currency) }} whole-month forecast</p>
            <p v-if="snapshot.metadata?.estimated">Provider marks these charges as estimated.</p>
            <p v-if="snapshot.metadata?.comparisonUnavailable">Previous-period data is unavailable.</p>
            <p v-if="snapshot.metadata?.forecastUnavailable">Forecast unavailable; actual costs are retained.</p>
            <dl v-if="breakdown(snapshot.metadata?.breakdown).length" class="service-breakdown"><div v-for="service in breakdown(snapshot.metadata?.breakdown)" :key="service.service"><dt>{{ service.service }}</dt><dd>{{ money(service.amount, service.currency) }}</dd></div></dl>
          </div>
        </template>
        <p v-else class="provider-empty">{{ feed.providers[provider].status === 'not-configured' ? 'Connect your account to see reported usage costs here.' : 'No reported charges are available yet.' }}</p>
        <footer><span v-if="feed.providers[provider].lastSyncedAt">Last synced {{ date(feed.providers[provider].lastSyncedAt!) }}</span><span v-else>No successful sync yet</span><span v-if="feed.providers[provider].lastAttemptAt && feed.providers[provider].status === 'error'">Last attempted {{ date(feed.providers[provider].lastAttemptAt!) }}</span></footer>
      </article>
    </div>
    <p class="provider-setup">Manage private credentials in <a href="#connections">Connections</a>. Provider refresh failures keep previous observations and history.</p>
  </section>
</template>

<style scoped>
.infrastructure-section{scroll-margin-top:2rem}.section-description{max-width:65ch;color:var(--muted,#6b706d);font-size:.9rem;margin-bottom:1.5rem}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.provider-panel{border:1px solid var(--line,#d9dcd5);border-radius:8px;padding:1.5rem;background:var(--surface,#fff)}.provider-panel header,.provider-panel header>div{display:flex;align-items:center;gap:.65rem}.provider-panel header{justify-content:space-between;flex-wrap:wrap}.provider-panel h3{font-size:1rem;margin:0}.provider-mark{width:1.8rem;height:1.8rem;display:grid;place-items:center;border:1px solid var(--line,#d9dcd5);font:italic bold 1.3rem Georgia,serif}.status-label{font-size:.72rem;padding:.3rem .55rem;background:#f1f1eb;border-radius:4px}.status-label.synced{background:#e9f2ea;color:#24532e}.status-label.error,.feed-warning{color:#9f3d20}.provider-empty{padding:2rem 0;line-height:1.7;max-width:35ch;color:var(--muted,#6b706d)}.provider-panel footer{border-top:1px solid var(--line,#d9dcd5);padding-top:1rem;color:var(--muted,#6b706d);font-size:.75rem}.provider-cost{margin:1.5rem 0}.provider-cost>strong{font-size:2rem;display:block;font-variant-numeric:tabular-nums}.provider-cost>span,.provider-cost>p{font-size:.8rem;color:var(--muted,#6b706d);margin:.35rem 0}.service-breakdown{font-size:.8rem}.service-breakdown>div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-bottom:1px solid var(--line,#d9dcd5)}.service-breakdown dd{margin:0;white-space:nowrap}.provider-setup{font-size:.85rem;margin-top:1rem;border:1px solid var(--line,#d9dcd5);padding:1rem;border-radius:6px}.provider-setup summary{cursor:pointer;font-weight:600}.provider-setup p{margin:.8rem 0;max-width:80ch;line-height:1.6}.provider-setup a{color:inherit;text-decoration:underline}.usage-summary{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem}.usage-total{flex:1;min-width:200px;padding:1.2rem;border:1px solid var(--line,#d9dcd5);background:var(--surface,#fff)}.usage-total>strong{display:block;font-size:2rem}.usage-total>span,.usage-total>p:not(.eyebrow){font-size:.8rem;margin:.4rem 0}.feed-warning{font-size:.85rem;line-height:1.5}.combined-total{font-weight:600}@media(max-width:700px){.provider-grid{grid-template-columns:1fr}.provider-panel{padding:1.1rem}}
</style>
