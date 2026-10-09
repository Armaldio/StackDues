<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { latestCostSnapshots, type CostProvider, type CostSnapshot } from '../domain/usage-costs'

const props = defineProps<{ snapshots: readonly CostSnapshot[] }>()
const providerFilter = ref<'all' | CostProvider>('all')
const kindFilter = ref<'all' | CostSnapshot['kind']>('all')
const currencyFilter = ref('all')
const showPreviousCaptures = ref(false)
const visibleLimit = ref(30)
const currencies = computed(() => [...new Set(props.snapshots.map(item => item.currency))].sort())
const matchingSnapshots = computed(() => props.snapshots.filter(snapshot =>
  (providerFilter.value === 'all' || snapshot.provider === providerFilter.value)
  && (kindFilter.value === 'all' || snapshot.kind === kindFilter.value)
  && (currencyFilter.value === 'all' || snapshot.currency === currencyFilter.value),
))
const observations = computed(() => {
  const source = showPreviousCaptures.value ? matchingSnapshots.value : latestCostSnapshots(matchingSnapshots.value)
  return [...source].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || b.id.localeCompare(a.id))
})
const visible = computed(() => observations.value.slice(0, visibleLimit.value))
watch([providerFilter, kindFilter, currencyFilter, showPreviousCaptures], () => { visibleLimit.value = 30 })
function captured(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function money(amount: number, currency: string) { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) }
function period(snapshot: CostSnapshot) {
  const label = snapshot.metadata?.scope === 'billing-period-to-date' ? 'Billing period to date'
    : snapshot.metadata?.period === 'previous-comparable' ? 'Previous comparison'
      : snapshot.metadata?.period === 'previous-month' ? 'Previous month'
        : snapshot.metadata?.period === 'current' ? 'Current month' : 'Provider-reported period'
  return typeof snapshot.metadata?.reportedThrough === 'string' ? `${label} · through ${snapshot.metadata.reportedThrough}` : label
}
function kind(snapshot: CostSnapshot) {
  if (snapshot.kind === 'forecast') return 'Forecast · full month, includes actuals'
  return snapshot.metadata?.period === 'current' || snapshot.metadata?.scope === 'billing-period-to-date' ? 'Actual · to date' : 'Actual'
}
</script>
<template>
  <section id="history" class="cost-history" aria-labelledby="history-title">
    <div class="section-header"><div><p class="eyebrow">Previously reported</p><h2 id="history-title">Cost history</h2></div><span class="muted">{{ snapshots.length }} saved observations</span></div>
    <p class="history-note">Repeated captures for the same provider, period, type, and currency are revisions. The latest is shown by default. These observations are not separate payments.</p>
    <p class="history-note">Capture history begins when a provider first syncs; coverage depends on the periods that provider reports. This is not a complete invoice ledger.</p>
    <div v-if="!snapshots.length" class="quiet-empty"><h3>No cost history yet</h3><p>Connect a provider to see reported spend over time.</p></div>
    <template v-else>
      <div class="history-controls" role="group" aria-label="Filter cost history">
        <label>Provider<select v-model="providerFilter"><option value="all">All providers</option><option value="aws">AWS</option><option value="cloudflare">Cloudflare</option><option value="openai">OpenAI API</option></select></label>
        <label>Type<select v-model="kindFilter"><option value="all">All types</option><option value="actual">Actual</option><option value="forecast">Forecast</option></select></label>
        <label>Currency<select v-model="currencyFilter"><option value="all">All currencies</option><option v-for="currency in currencies" :key="currency" :value="currency">{{ currency }}</option></select></label>
        <button class="secondary-button" type="button" :aria-pressed="showPreviousCaptures" @click="showPreviousCaptures = !showPreviousCaptures">{{ showPreviousCaptures ? 'Hide previous captures' : 'Show previous captures' }}</button>
      </div>
      <p v-if="!observations.length" class="quiet-empty">No observations match these filters.</p>
      <template v-else>
        <p class="history-count" role="status">Showing {{ visible.length }} of {{ observations.length }} {{ showPreviousCaptures ? 'captures' : 'latest observations' }}.</p>
        <div class="table-scroll"><table><caption class="sr-only">Provider-reported cost observations; captures are not summed</caption><thead><tr><th scope="col">Captured</th><th scope="col">Provider</th><th scope="col">Reported period</th><th scope="col">Type</th><th scope="col">Amount</th></tr></thead><tbody><tr v-for="snapshot in visible" :key="snapshot.id"><td>{{ captured(snapshot.capturedAt) }}</td><td>{{ snapshot.provider === 'aws' ? 'AWS' : snapshot.provider === 'cloudflare' ? 'Cloudflare' : 'OpenAI API' }}</td><td>{{ period(snapshot) }}<span class="cell-note">{{ snapshot.periodStart }} → {{ snapshot.periodEnd }} (end exclusive)</span></td><td><span class="status-pill">{{ kind(snapshot) }}</span></td><td class="amount">{{ money(snapshot.amount, snapshot.currency) }}</td></tr></tbody></table></div>
        <button v-if="visible.length < observations.length" class="secondary-button history-more" type="button" @click="visibleLimit += 30">Show more older entries</button>
      </template>
    </template>
  </section>
</template>
<style scoped>
.cost-history{scroll-margin-top:1.5rem;border-top:1px solid var(--line);padding-top:2rem}.history-note{font-size:.85rem;color:var(--muted);margin:0 0 .75rem;max-width:900px}.cost-history .section-header{margin-bottom:.75rem}.cost-history .section-header>span{font-size:.8rem}.history-controls{display:flex;flex-wrap:wrap;align-items:end;gap:.75rem;margin:1.25rem 0}.history-controls label{display:grid;gap:.3rem;font-size:.75rem;color:var(--muted)}.history-controls select{min-width:9rem}.history-count{font-size:.75rem;color:var(--muted);margin:0 0 .5rem}.cost-history table{min-width:680px}.cost-history .quiet-empty{padding:2.5rem 1rem}.history-more{margin-top:1rem}
@media(max-width:600px){.history-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.history-controls label,.history-controls select{min-width:0;width:100%}.history-controls button{grid-column:1/-1}}
</style>
