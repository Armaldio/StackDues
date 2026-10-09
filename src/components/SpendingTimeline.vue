<script setup lang="ts">
import { computed, ref } from 'vue'
import { overviewInsights } from '../domain/overview-insights'
import { spendingTimeline } from '../domain/spending-timeline'
import type { ServiceSelection } from '../domain/service-selection'
import type { Subscription } from '../domain/subscriptions'
import type { CostProvider, CostSnapshot } from '../domain/usage-costs'

const props = defineProps<{ subscriptions: readonly Subscription[]; snapshots: readonly CostSnapshot[]; today: string }>()
const emit = defineEmits<{ select: [selection: ServiceSelection] }>()
type ProviderFilter = 'all' | 'manual' | CostProvider | 'hostinger'
const days = ref<30 | 90 | 365>(30)
const providerFilter = ref<ProviderFilter>('all')
const typeFilter = ref<'all' | 'renewal' | 'actual' | 'forecast'>('all')
const currencyFilter = ref('all')
const windows = [30, 90, 365] as const
const data = computed(() => spendingTimeline(props.subscriptions, props.snapshots, props.today, days.value))
const currencies = computed(() => [...new Set([...props.subscriptions.map(item => item.currency), ...props.snapshots.map(item => item.currency)])].sort())
function matchesCurrency(currency: string) { return currencyFilter.value === 'all' || currency === currencyFilter.value }
function matchesProvider(provider: string) {
  if (providerFilter.value === 'all') return true
  if (providerFilter.value === 'manual') return provider !== 'Hostinger'
  return provider.toLowerCase() === providerFilter.value
}
const renewals = computed(() => data.value.renewals.filter(row => matchesProvider(row.subscription.provider ?? 'manual') && matchesCurrency(row.currency)))
const actuals = computed(() => data.value.actuals.filter(row => (providerFilter.value === 'all' || row.provider === providerFilter.value) && matchesCurrency(row.currency)).sort((a, b) => b.periodStart.localeCompare(a.periodStart) || a.provider.localeCompare(b.provider)))
const forecasts = computed(() => data.value.forecasts.filter(row => (providerFilter.value === 'all' || row.provider === providerFilter.value) && matchesCurrency(row.currency)).sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.provider.localeCompare(b.provider)))
const visibleRenewals = computed(() => typeFilter.value === 'all' || typeFilter.value === 'renewal' ? renewals.value : [])
const visibleActuals = computed(() => typeFilter.value === 'all' || typeFilter.value === 'actual' ? actuals.value : [])
const visibleForecasts = computed(() => typeFilter.value === 'all' || typeFilter.value === 'forecast' ? forecasts.value : [])
const insightRows = computed(() => overviewInsights(props.snapshots).filter(row =>
  (providerFilter.value === 'all' || row.provider === providerFilter.value)
  && matchesCurrency(row.currency),
))
const largestCosts = computed(() => {
  if (typeFilter.value === 'forecast' || typeFilter.value === 'renewal') return []
  const largest = new Map<string, (typeof insightRows.value)[number]>()
  for (const row of insightRows.value) {
    if (row.actual <= 0) continue
    const existing = largest.get(row.currency)
    if (!existing || row.actual > existing.actual) largest.set(row.currency, row)
  }
  return [...largest.values()].sort((a, b) => a.currency.localeCompare(b.currency))
})
const largestServices = computed(() => {
  if (typeFilter.value === 'forecast' || typeFilter.value === 'renewal') return []
  const largest = new Map<string, { provider: CostProvider; service: string; currency: string; amount: number }>()
  for (const row of insightRows.value) for (const driver of row.drivers) {
    const current = largest.get(row.currency)
    if (!current || driver.amount > current.amount) largest.set(row.currency, { provider: row.provider, service: driver.service, currency: row.currency, amount: driver.amount })
  }
  return [...largest.values()].sort((a, b) => a.currency.localeCompare(b.currency))
})
const comparableChanges = computed(() => typeFilter.value === 'forecast' || typeFilter.value === 'renewal' ? [] : insightRows.value.filter(row => row.previousComparable !== null))
const upcomingCounts = computed(() => {
  if (typeFilter.value === 'actual' || typeFilter.value === 'forecast') return []
  const counts = new Map<string, number>()
  for (const row of renewals.value) counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => a.localeCompare(b))
})
function name(provider: CostProvider) { return provider === 'aws' ? 'AWS' : provider === 'cloudflare' ? 'Cloudflare' : provider === 'openai' ? 'OpenAI API' : 'DigitalOcean' }
function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) }
  catch { return `${currency} ${amount.toFixed(2)}` }
}
function date(value: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) }
function captured(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function period(snapshot: CostSnapshot) {
  if (snapshot.metadata?.scope === 'finalized-invoice-total') return `Finalized invoice · ${snapshot.periodStart.slice(0, 7)}`
  if (snapshot.metadata?.scope === 'billing-period-to-date') return 'Billing period to date'
  if (snapshot.metadata?.scope === 'organization-api-costs') return 'Organization API costs · to date'
  if (snapshot.metadata?.period === 'previous-comparable') return 'Previous comparable period'
  if (snapshot.metadata?.period === 'current') return 'Current reported period · to date'
  return 'Provider-reported period'
}
function nextDate(value: string) { return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) }
</script>

<template>
  <section id="timeline" class="spending-timeline" aria-labelledby="timeline-heading">
    <div class="section-header"><div><p class="eyebrow">What’s due and what providers reported</p><h2 id="timeline-heading">Spending timeline</h2></div><div class="timeline-windows" role="group" aria-label="Timeline date window"><button v-for="window in windows" :key="window" type="button" :aria-pressed="days === window" @click="days = window">{{ window }} days</button></div></div>
    <p class="timeline-description">Upcoming fixed renewals are scheduled charges, not invoices. Past provider observations are period reports, not separate payments. Provider forecasts are estimates and are kept in their own lane.</p>
    <div class="timeline-filters" role="group" aria-label="Filter timeline entries">
      <label>Provider<select v-model="providerFilter"><option value="all">All providers</option><option value="aws">AWS</option><option value="cloudflare">Cloudflare</option><option value="hostinger">Hostinger</option><option value="openai">OpenAI API</option><option value="digitalocean">DigitalOcean</option><option value="manual">Manual subscriptions</option></select></label>
      <label>Type<select v-model="typeFilter"><option value="all">All entry types</option><option value="renewal">Fixed renewal</option><option value="actual">Reported actual</option><option value="forecast">Provider forecast</option></select></label>
      <label>Currency<select v-model="currencyFilter"><option value="all">All currencies</option><option v-for="currency in currencies" :key="currency" :value="currency">{{ currency }}</option></select></label>
      <button v-if="providerFilter !== 'all' || typeFilter !== 'all' || currencyFilter !== 'all'" type="button" class="text-button" @click="providerFilter = 'all'; typeFilter = 'all'; currencyFilter = 'all'">Clear filters</button>
    </div>

    <div class="timeline-insights" aria-label="Timeline insights">
      <article><span class="eyebrow">Scheduled charges · {{ days }} days</span><strong>{{ renewals.length }}</strong><span>upcoming renewals</span><small v-for="[currency, count] in upcomingCounts" :key="currency">{{ count }} · {{ currency }}</small></article>
      <article v-for="row in largestCosts" :key="`provider-${row.currency}`"><span class="eyebrow">Largest current provider amount</span><strong>{{ money(row.actual, row.currency) }}</strong><span>{{ name(row.provider) }} · {{ row.currency }}</span><small v-if="row.previousComparable !== null">{{ row.changePercent === null ? 'Change unavailable' : `${row.changePercent > 0 ? '+' : ''}${row.changePercent.toFixed(1)}% versus aligned prior period` }}</small><small v-else>Not enough aligned history for comparison</small></article>
      <article v-for="row in comparableChanges" :key="`change-${row.provider}-${row.currency}`"><span class="eyebrow">Comparable period change</span><strong>{{ row.changePercent === null ? 'Change unavailable' : `${row.changePercent > 0 ? '+' : ''}${row.changePercent.toFixed(1)}%` }}</strong><span>{{ name(row.provider) }} · {{ row.currency }}</span><small>{{ money(row.actual, row.currency) }} now · {{ money(row.previousComparable!, row.currency) }} in the aligned prior period</small></article>
      <article v-for="row in largestServices" :key="`service-${row.currency}`"><span class="eyebrow">Largest reported service line</span><strong>{{ money(row.amount, row.currency) }}</strong><span>{{ row.service }} · {{ name(row.provider) }} · {{ row.currency }}</span><small>Provider breakdown detail; not added again to the reported total</small></article>
      <p v-if="!largestCosts.length" class="timeline-insight-empty">No positive current provider actuals are available for a largest-cost comparison.</p>
    </div>

    <div class="timeline-lanes">
      <section class="timeline-lane" aria-labelledby="renewal-lane-heading"><header><div><p class="eyebrow">Scheduled · not billed</p><h3 id="renewal-lane-heading">Upcoming fixed renewals</h3></div><span class="metric-note">{{ date(props.today) }}–{{ date(data.windowEnd) }} UTC</span></header>
        <p v-if="!visibleRenewals.length" class="timeline-empty" role="status">{{ renewals.length ? 'No renewals match these filters.' : `No active renewal is scheduled in the next ${days} days.` }}</p>
        <ol v-else class="timeline-list renewal-list renewal-timeline-list"><li v-for="row in visibleRenewals" :key="`${row.subscription.id}-${row.date}`"><time :datetime="row.date"><span>{{ nextDate(row.date) }}</span><strong>{{ row.date.slice(8) }}</strong></time><div><button class="timeline-service-link" type="button" @click="emit('select', { kind: 'subscription', id: row.subscription.id })"><strong>{{ row.subscription.name }}</strong><span>{{ row.subscription.provider ?? 'Manual subscription' }} · every {{ row.subscription.recurrenceInterval }} {{ row.subscription.recurrenceUnit }}{{ row.subscription.recurrenceInterval === 1 ? '' : 's' }}</span></button></div><strong class="amount">{{ money(row.amount, row.currency) }}</strong></li></ol>
      </section>

      <section class="timeline-lane" aria-labelledby="actual-lane-heading"><header><div><p class="eyebrow">Historical provider reports · not payment records</p><h3 id="actual-lane-heading">Reported actuals</h3></div><span class="metric-note">{{ date(data.windowStart) }}–{{ date(props.today) }} UTC</span></header>
        <p v-if="!visibleActuals.length" class="timeline-empty" role="status">{{ actuals.length ? 'No actuals match these filters.' : 'No provider-reported actual period overlaps this date window.' }}</p>
        <ol v-else class="timeline-list report-timeline-list"><li v-for="snapshot in visibleActuals" :key="snapshot.id"><time :datetime="snapshot.periodStart"><span>{{ snapshot.periodStart.slice(0, 7) }}</span><strong>{{ snapshot.periodStart.slice(8) }}</strong></time><div><button class="timeline-service-link" type="button" @click="emit('select', { kind: 'provider', provider: snapshot.provider })"><strong>{{ name(snapshot.provider) }} · {{ money(snapshot.amount, snapshot.currency) }}</strong><span>{{ period(snapshot) }} · {{ snapshot.periodStart }}–{{ snapshot.periodEnd }} (end exclusive)</span></button><small>Captured {{ captured(snapshot.capturedAt) }}</small></div><span class="timeline-kind">Actual</span></li></ol>
      </section>

      <section class="timeline-lane forecast-lane" aria-labelledby="forecast-lane-heading"><header><div><p class="eyebrow">Estimate · not a scheduled payment</p><h3 id="forecast-lane-heading">Provider forecasts</h3></div><span class="metric-note">Current reports</span></header>
        <p v-if="!visibleForecasts.length" class="timeline-empty" role="status">{{ forecasts.length ? 'No forecasts match these filters.' : 'No provider forecast overlaps this selected window.' }}</p>
        <ol v-else class="timeline-list report-timeline-list"><li v-for="snapshot in visibleForecasts" :key="snapshot.id"><time :datetime="snapshot.periodStart"><span>{{ snapshot.periodStart.slice(0, 7) }}</span><strong>{{ snapshot.periodStart.slice(8) }}</strong></time><div><button class="timeline-service-link" type="button" @click="emit('select', { kind: 'provider', provider: snapshot.provider })"><strong>{{ name(snapshot.provider) }} · {{ money(snapshot.amount, snapshot.currency) }}</strong><span>Full-period forecast · includes reported actuals · {{ snapshot.periodStart }}–{{ snapshot.periodEnd }}</span></button><small>Captured {{ captured(snapshot.capturedAt) }}</small></div><span class="timeline-kind forecast-kind">Forecast</span></li></ol>
      </section>
    </div>
  </section>
</template>

<style scoped>
.spending-timeline{border-top:1px solid var(--line);padding-top:2rem;scroll-margin-top:1.5rem}.timeline-description{max-width:80ch;color:var(--muted);font-size:.85rem;line-height:1.55}.timeline-windows{display:flex;gap:.35rem}.timeline-windows button{min-width:4rem;padding:.5rem .65rem;border:1px solid var(--line);border-radius:3px;background:var(--surface);color:var(--ink);font:inherit;font-size:.75rem}.timeline-windows button[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.timeline-filters{display:flex;flex-wrap:wrap;align-items:end;gap:.75rem;margin:1rem 0}.timeline-filters label{display:grid;gap:.3rem;font-size:.72rem;color:var(--muted)}.timeline-filters select{min-width:10rem}
.timeline-insights{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:.75rem;margin:1rem 0 1.5rem}.timeline-insights article,.timeline-insight-empty{display:grid;align-content:start;gap:.3rem;padding:1rem;border:1px solid var(--line);background:var(--surface);min-width:0}.timeline-insights article>strong{font-size:1.25rem;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.timeline-insights article>span:not(.eyebrow){font-size:.8rem}.timeline-insights small{font-size:.68rem;color:var(--muted)}.timeline-insight-empty{font-size:.8rem;color:var(--muted)}
.timeline-lanes{display:grid;gap:1rem}.timeline-lane{min-width:0;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:4px;background:var(--surface)}.timeline-lane>header{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--line)}.timeline-lane h3{margin:0;font-size:1.05rem}.timeline-lane header .eyebrow{margin:0 0 .25rem}.timeline-lane header .metric-note{font-size:.7rem;text-align:right}.timeline-empty{margin:0;padding:1.25rem 0;color:var(--muted);font-size:.82rem}.timeline-list{list-style:none;padding:0;margin:0}.timeline-list li{display:grid;grid-template-columns:3.5rem minmax(0,1fr) auto;align-items:center;gap:.9rem;padding:.8rem 0;border-bottom:1px solid var(--line)}.timeline-list li:last-child{border-bottom:0}.timeline-list time{display:grid;justify-items:center;gap:.1rem;border-right:1px solid var(--line);padding-right:.6rem;font-size:.7rem;color:var(--muted)}.timeline-list time strong{font:600 1.1rem var(--mono);color:var(--ink)}.timeline-list li>div{display:grid;min-width:0;gap:.2rem}.timeline-list li>div>small{font-size:.66rem;color:var(--muted)}.timeline-service-link{display:grid;justify-items:start;gap:.2rem;max-width:100%;padding:0;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.timeline-service-link:hover{text-decoration:underline;text-underline-offset:.15em}.timeline-service-link:focus-visible{outline:2px solid var(--ink);outline-offset:3px}.timeline-service-link strong{font-size:.82rem;overflow-wrap:anywhere}.timeline-service-link span{font-size:.68rem;color:var(--muted);overflow-wrap:anywhere}.timeline-kind{font-size:.65rem;padding:.3rem .45rem;border-radius:3px;background:#e9f2ea;color:#24532e;white-space:nowrap}.forecast-kind{background:#f1ead8;color:#765629}.forecast-lane{border-style:dashed}
@media(max-width:600px){.timeline-filters{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.timeline-filters label,.timeline-filters select{width:100%;min-width:0}.timeline-filters .text-button{grid-column:1/-1}.timeline-lane{padding:.85rem}.timeline-lane>header{align-items:flex-start}.timeline-lane header .metric-note{max-width:8rem}.timeline-list li{grid-template-columns:2.75rem minmax(0,1fr) auto;gap:.55rem}.timeline-list time{padding-right:.4rem}.timeline-list .amount{font-size:.75rem}.timeline-service-link strong{font-size:.76rem}}
</style>
