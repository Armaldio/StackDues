<script setup lang="ts">
import { computed } from 'vue'
import type { CostSnapshot } from '../domain/usage-costs'
const props = defineProps<{ snapshots: readonly CostSnapshot[] }>()
const recent = computed(() => [...props.snapshots].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt) || a.id.localeCompare(b.id)).slice(0, 30))
function captured(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function money(amount: number, currency: string) { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) }
function period(snapshot: CostSnapshot) {
  return snapshot.metadata?.period === 'previous-comparable' ? 'Previous comparison' : snapshot.metadata?.period === 'previous-month' ? 'Previous month' : snapshot.provider === 'cloudflare' ? 'Billing period to date' : 'Current month'
}
</script>
<template>
  <section id="history" class="cost-history" aria-labelledby="history-title">
    <div class="section-header"><div><p class="eyebrow">Previously reported</p><h2 id="history-title">Cost history</h2></div><span class="muted">{{ snapshots.length }} observations</span></div>
    <p class="history-note">Reported charges and forecasts stay separate. Earlier observations are kept after refresh failures.</p>
    <div v-if="!recent.length" class="quiet-empty"><h3>No cost history yet</h3><p>Connect a provider to see reported spend over time.</p></div>
    <div v-else class="table-scroll"><table><caption class="sr-only">The 30 most recent provider cost observations</caption><thead><tr><th scope="col">Captured</th><th scope="col">Provider</th><th scope="col">Reported period</th><th scope="col">Type</th><th scope="col">Amount</th></tr></thead><tbody><tr v-for="snapshot in recent" :key="snapshot.id"><td>{{ captured(snapshot.capturedAt) }}</td><td>{{ snapshot.provider === 'aws' ? 'AWS' : 'Cloudflare' }}</td><td>{{ period(snapshot) }}<span class="cell-note">{{ snapshot.periodStart }} → {{ snapshot.periodEnd }} (end exclusive)</span></td><td><span class="status-pill">{{ snapshot.kind === 'forecast' ? 'Forecast' : 'Actual' }}</span></td><td class="amount">{{ money(snapshot.amount, snapshot.currency) }}</td></tr></tbody></table></div>
    <p v-if="snapshots.length > 30" class="history-note">Showing the 30 most recent observations.</p>
  </section>
</template>
<style scoped>
.cost-history{scroll-margin-top:1.5rem;border-top:1px solid var(--line);padding-top:2rem}.history-note{font-size:.85rem;color:var(--muted);margin:0 0 1.25rem}.cost-history .section-header{margin-bottom:.75rem}.cost-history .section-header>span{font-size:.8rem}.cost-history table{min-width:680px}.cost-history .quiet-empty{padding:2.5rem 1rem}
</style>
