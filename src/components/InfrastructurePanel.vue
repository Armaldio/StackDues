<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { latestCostSnapshots, usageTotals, type CostBreakdown, type CostProvider } from '../domain/usage-costs'
import type { CurrencyTotal } from '../domain/subscriptions'
import { currentCostSnapshots, emptyCostFeed, fetchCostFeed, isProviderStale, type CostFeed } from '../lib/cost-feed'

const props = defineProps<{ fixedTotals: CurrencyTotal[]; today: string }>()
const emit = defineEmits<{ loaded: [feed: CostFeed] }>()
const feed = ref(emptyCostFeed())
const loading = ref(false)
const error = ref('')
const providers: CostProvider[] = ['aws', 'cloudflare']
const activeSnapshots = computed(() => currentCostSnapshots(feed.value))
const totals = computed(() => usageTotals(activeSnapshots.value, props.today))
const latest = computed(() => latestCostSnapshots(activeSnapshots.value).filter(row => row.kind === 'actual' && row.metadata?.period === 'current'))
const combined = computed(() => totals.value.map(total => ({ ...total, fixed: props.fixedTotals.find(row => row.currency === total.currency)?.monthly ?? 0, fixedYearly: props.fixedTotals.find(row => row.currency === total.currency)?.yearly ?? 0 })))
function money(amount: number, currency: string) { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount) }
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function name(provider: CostProvider) { return provider === 'aws' ? 'Amazon Web Services' : 'Cloudflare' }
function current(provider: CostProvider) {
  const rows = latest.value.filter(row => row.provider === provider)
  const newest = Math.max(...rows.map(row => Date.parse(row.capturedAt)))
  return rows.filter(row => Date.parse(row.capturedAt) === newest)
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
  try { feed.value = await fetchCostFeed('/api/costs'); error.value = ''; emit('loaded', feed.value) }
  catch { error.value = 'Infrastructure data could not be loaded. Previous observations are still displayed. Try again.' }
  finally { loading.value = false }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { void reload(); timer = setInterval(() => { void reload() }, 15 * 60 * 1000) })
onUnmounted(() => { if (timer !== undefined) clearInterval(timer) })
</script>

<template>
  <section id="infrastructure" class="infrastructure-section" aria-labelledby="infra-heading">
    <div class="section-header"><div><p class="eyebrow">Metered usage</p><h2 id="infra-heading">Infrastructure</h2></div><button type="button" class="secondary-button" :disabled="loading" @click="reload">{{ loading ? 'Loading…' : 'Reload cost data' }}</button></div>
    <p class="section-description">Reported provider spend stays separate from your fixed commitments. Forecasts include actual spend; they are never added to it. Disconnected providers are excluded from tracked totals.</p>
    <p v-if="error" role="alert" class="feed-warning">{{ error }}</p>
    <div v-if="totals.length" class="usage-summary">
      <div v-for="total in combined" :key="total.currency" class="usage-total">
        <p class="eyebrow">{{ total.currency }} · current reported period</p><strong>{{ total.hasActual ? money(total.actual, total.currency) : 'Unavailable' }}</strong><span>Actual metered spend</span>
        <p v-if="total.hasForecast">{{ money(total.estimatedMonthly, total.currency) }} forecast / month · {{ money(total.estimatedYearly, total.currency) }} annualized estimate</p>
        <p v-else>Monthly forecast unavailable</p>
        <p v-if="total.hasForecast && total.estimationComplete" class="combined-total">{{ money(total.fixed + total.estimatedMonthly, total.currency) }} tracked estimated monthly total, including fixed commitments</p>
        <p v-if="total.hasForecast && total.estimationComplete" class="combined-total">{{ Number.isFinite(total.fixedYearly + total.estimatedYearly) ? money(total.fixedYearly + total.estimatedYearly, total.currency) : 'Annual total unavailable' }} tracked annualized estimate</p>
        <p v-if="total.hasForecast && !total.estimationComplete" class="feed-warning">Forecast covers only some providers. A combined total is unavailable.</p>
      </div>
    </div>
    <div class="provider-grid">
      <article v-for="provider in providers" :key="provider" class="provider-panel">
        <header><div><span class="provider-mark" aria-hidden="true">{{ provider === 'aws' ? 'a' : 'c' }}</span><h3>{{ name(provider) }}</h3></div><span class="status-label" :class="feed.providers[provider].status">{{ feed.providers[provider].status === 'not-configured' ? 'Not connected' : feed.providers[provider].status === 'error' ? 'Sync failed' : 'Connected' }}</span></header>
        <p v-if="feed.providers[provider].error" class="feed-warning" role="status">{{ feed.providers[provider].error }}</p>
        <p v-if="isProviderStale(feed.providers[provider])" class="feed-warning">Data is over 36 hours old. The last successful observations are retained.</p>
        <template v-if="current(provider).length">
          <div v-for="snapshot in current(provider)" :key="snapshot.id" class="provider-cost">
            <strong>{{ money(snapshot.amount, snapshot.currency) }}</strong><span>{{ provider === 'cloudflare' ? 'Billing period to date' : 'Month to date' }}</span>
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
    <details class="provider-setup"><summary>Connect AWS or Cloudflare</summary><p>Provider credentials are stored in GitHub repository secrets and used by scheduled jobs. Never enter provider keys in this dashboard.</p><p>This site is public. Publishing provider costs makes those cost snapshots public; manual subscriptions stay in your browser.</p><p>Follow the <a href="https://github.com/Armaldio/billing#provider-setup">provider setup guide</a>, then run the <a href="https://github.com/Armaldio/billing/actions/workflows/pages.yml">refresh and deployment workflow</a>. Reloading this page reads the latest published observations; it does not call your provider.</p></details>
  </section>
</template>

<style scoped>
.infrastructure-section{scroll-margin-top:2rem}.section-description{max-width:65ch;color:var(--muted,#6b706d);font-size:.9rem;margin-bottom:1.5rem}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.provider-panel{border:1px solid var(--line,#d9dcd5);border-radius:8px;padding:1.5rem;background:var(--surface,#fff)}.provider-panel header,.provider-panel header>div{display:flex;align-items:center;gap:.65rem}.provider-panel header{justify-content:space-between;flex-wrap:wrap}.provider-panel h3{font-size:1rem;margin:0}.provider-mark{width:1.8rem;height:1.8rem;display:grid;place-items:center;border:1px solid var(--line,#d9dcd5);font:italic bold 1.3rem Georgia,serif}.status-label{font-size:.72rem;padding:.3rem .55rem;background:#f1f1eb;border-radius:4px}.status-label.synced{background:#e9f2ea;color:#24532e}.status-label.error,.feed-warning{color:#9f3d20}.provider-empty{padding:2rem 0;line-height:1.7;max-width:35ch;color:var(--muted,#6b706d)}.provider-panel footer{border-top:1px solid var(--line,#d9dcd5);padding-top:1rem;color:var(--muted,#6b706d);font-size:.75rem}.provider-cost{margin:1.5rem 0}.provider-cost>strong{font-size:2rem;display:block;font-variant-numeric:tabular-nums}.provider-cost>span,.provider-cost>p{font-size:.8rem;color:var(--muted,#6b706d);margin:.35rem 0}.service-breakdown{font-size:.8rem}.service-breakdown>div{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-bottom:1px solid var(--line,#d9dcd5)}.service-breakdown dd{margin:0;white-space:nowrap}.provider-setup{font-size:.85rem;margin-top:1rem;border:1px solid var(--line,#d9dcd5);padding:1rem;border-radius:6px}.provider-setup summary{cursor:pointer;font-weight:600}.provider-setup p{margin:.8rem 0;max-width:80ch;line-height:1.6}.provider-setup a{color:inherit;text-decoration:underline}.usage-summary{display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem}.usage-total{flex:1;min-width:200px;padding:1.2rem;border:1px solid var(--line,#d9dcd5);background:var(--surface,#fff)}.usage-total>strong{display:block;font-size:2rem}.usage-total>span,.usage-total>p:not(.eyebrow){font-size:.8rem;margin:.4rem 0}.feed-warning{font-size:.85rem;line-height:1.5}.combined-total{font-weight:600}@media(max-width:700px){.provider-grid{grid-template-columns:1fr}.provider-panel{padding:1.1rem}}
</style>
