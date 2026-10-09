<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { latestCostSnapshots, type CostBreakdown, type CostProvider, type CostSnapshot } from '../domain/usage-costs'
import { overviewInsights } from '../domain/overview-insights'
import type { ServiceSelection } from '../domain/service-selection'
import { nextRenewalOnOrAfter, normalizeCost, type Subscription } from '../domain/subscriptions'
import { isProviderStale, type CostFeed } from '../lib/cost-feed'
import type { HostingerDiscovery, HostingerDiscoveryRow } from '../lib/hostinger-api'

const props = defineProps<{
  selection: ServiceSelection
  feed: CostFeed
  subscriptions: readonly Subscription[]
  subscriptionsLoaded: boolean
  today: string
  hostingerSync?: HostingerDiscovery['sync']
  hostingerRows?: readonly HostingerDiscovery['subscriptions'][number][]
}>()
const emit = defineEmits<{ close: []; edit: [subscription: Subscription] }>()
const dialog = ref<HTMLDialogElement>()
const nameByProvider: Record<CostProvider | 'hostinger' | 'github', string> = {
  aws: 'Amazon Web Services', cloudflare: 'Cloudflare', openai: 'OpenAI API', digitalocean: 'DigitalOcean', hostinger: 'Hostinger', github: 'GitHub',
}
const subscription = computed(() => {
  const selection = props.selection
  return selection.kind === 'subscription' ? props.subscriptions.find(item => item.id === selection.id) : undefined
})
const provider = computed(() => props.selection.kind === 'provider' ? props.selection.provider : subscription.value?.provider?.toLowerCase() === 'hostinger' ? 'hostinger' : undefined)
const title = computed(() => subscription.value?.name ?? (props.selection.kind === 'subscription' ? props.subscriptionsLoaded ? 'Subscription unavailable' : 'Loading subscription' : provider.value ? nameByProvider[provider.value] : 'Service details'))
const providerSnapshots = computed(() => provider.value && provider.value !== 'hostinger' && provider.value !== 'github'
  ? latestCostSnapshots(props.feed.snapshots.filter(snapshot => snapshot.provider === provider.value)).sort((a, b) => b.periodStart.localeCompare(a.periodStart) || b.capturedAt.localeCompare(a.capturedAt))
  : [])
const actuals = computed(() => providerSnapshots.value.filter(snapshot => snapshot.kind === 'actual'))
const forecasts = computed(() => providerSnapshots.value.filter(snapshot => snapshot.kind === 'forecast'))
const comparisons = computed(() => provider.value && provider.value !== 'hostinger' && provider.value !== 'github' ? overviewInsights(props.feed.snapshots).filter(row => row.provider === provider.value) : [])
const hostingerRow = computed(() => props.hostingerRows?.find(row => row.linkedSubscriptionId === subscription.value?.id))
const hostingerSubscriptions = computed(() => props.subscriptions.filter(item => item.provider === 'Hostinger'))
const nextRenewal = computed(() => subscription.value ? nextRenewalOnOrAfter(subscription.value, props.today) : null)
const normalized = computed(() => subscription.value ? normalizeCost(subscription.value) : null)
const syncStatus = computed(() => provider.value && provider.value !== 'hostinger' && provider.value !== 'github' ? props.feed.providers[provider.value] : undefined)
const dataDescription = computed(() => {
  if (props.selection.kind === 'subscription' && !subscription.value) return props.subscriptionsLoaded ? 'This fixed subscription is no longer available in your account.' : 'Loading the saved subscription details.'
  if (provider.value === 'aws') return 'AWS Cost Explorer reported usage. Forecasts are full-period estimates and are shown separately from actuals.'
  if (provider.value === 'cloudflare') return 'Cloudflare billing-period usage. A full-month forecast and imported invoices are unavailable.'
  if (provider.value === 'openai') return 'Organization-reported API costs by day. This does not include ChatGPT Plus, invoice finality, or a full-month forecast.'
  if (provider.value === 'digitalocean') return 'Finalized monthly invoice totals only. Previews, account balance, payment and credit events, and nightly estimates are excluded.'
  if (provider.value === 'hostinger') return 'Fixed recurring commitments from Hostinger renewal discovery. Renewal amounts are not imported invoices.'
  if (provider.value === 'github') return 'Billing amounts and currency are unavailable from the currently supported GitHub billing API; no cost data is inferred.'
  return 'A fixed recurring commitment entered by you. This is separate from provider-reported metered usage.'
})
function money(amount: number, currency: string) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) }
  catch { return `${currency} ${amount.toFixed(2)}` }
}
function hostingerStatus(item: HostingerDiscoveryRow) {
  if (item.excluded) return 'Excluded'
  if (!item.seenInLatestSync) return 'Stale · absent from latest sync'
  if (item.linkedSubscriptionId) return item.automaticallyLinked ? 'Tracked automatically' : 'Linked to manual subscription'
  if (item.possibleMatches.length || item.providerNameCollision) return 'Needs review'
  return item.renewalAvailable ? 'Available to track' : 'Unsupported / not renewing'
}
function period(snapshot: CostSnapshot) {
  if (snapshot.metadata?.scope === 'finalized-invoice-total') return `Finalized invoice · ${snapshot.periodStart.slice(0, 7)}`
  if (snapshot.kind === 'forecast') return 'Full-period forecast · includes actuals'
  if (snapshot.metadata?.period === 'previous-comparable') return 'Previous comparable actual'
  if (snapshot.metadata?.period === 'current' || snapshot.metadata?.scope === 'billing-period-to-date') return 'Actual · reported to date'
  return 'Provider-reported actual'
}
function breakdown(snapshot: CostSnapshot): readonly CostBreakdown[] {
  const rows = snapshot.metadata?.breakdown
  if (!Array.isArray(rows)) return []
  return rows.filter((row): row is CostBreakdown => !!row && typeof row === 'object' && typeof row.service === 'string' && typeof row.amount === 'number' && typeof row.currency === 'string')
}
function close() { emit('close') }
function onClosed() { emit('close') }
onMounted(async () => {
  await nextTick()
  if (dialog.value && !dialog.value.open) dialog.value.showModal()
})
onUnmounted(() => { if (dialog.value?.open) dialog.value.close() })
</script>

<template>
  <dialog ref="dialog" class="service-detail-dialog" aria-labelledby="service-detail-title" @close="onClosed">
    <header class="dialog-header"><div><p class="eyebrow">Service details</p><h2 id="service-detail-title">{{ title }}</h2></div><button class="icon-button" type="button" aria-label="Close service details" @click="close">×</button></header>
    <p class="service-detail-intro">{{ dataDescription }}</p>

    <template v-if="subscription">
      <section class="detail-block" aria-labelledby="fixed-commitment-heading">
        <h3 id="fixed-commitment-heading">Fixed commitment</h3>
        <dl class="detail-metrics">
          <div><dt>Charge per cycle</dt><dd>{{ money(subscription.amount, subscription.currency) }}</dd></div>
          <div><dt>Recurrence</dt><dd>Every {{ subscription.recurrenceInterval }} {{ subscription.recurrenceUnit }}{{ subscription.recurrenceInterval === 1 ? '' : 's' }}</dd></div>
          <div><dt>Monthly equivalent</dt><dd>{{ money(normalized!.monthly, subscription.currency) }}</dd></div>
          <div><dt>Next renewal</dt><dd>{{ nextRenewal ?? 'No upcoming renewal' }}</dd></div>
          <div><dt>Status</dt><dd class="status-pill">{{ subscription.status }}</dd></div>
          <div v-if="hostingerRow"><dt>Hostinger link</dt><dd>{{ hostingerRow.excluded ? 'Excluded from commitments' : hostingerRow.seenInLatestSync ? 'Linked renewal is current' : 'Linked renewal details are stale' }}</dd></div>
        </dl>
        <p v-if="subscription.status !== 'active'" class="detail-note">Paused or cancelled commitments are not counted as upcoming active renewals.</p>
        <div class="detail-actions"><button v-if="subscription.provider !== 'Hostinger'" class="secondary-button" type="button" @click="emit('edit', subscription)">Edit subscription</button><a v-else class="secondary-button" href="/services" @click="close">Manage Hostinger renewal</a><a class="text-button" href="/services" @click="close">Back to services</a></div>
      </section>
    </template>

    <template v-else-if="selection.kind === 'subscription'">
      <p class="detail-note" role="status">{{ subscriptionsLoaded ? 'This fixed subscription is no longer available in your account.' : 'Loading the saved subscription details.' }}</p>
    </template>

    <template v-else-if="provider === 'hostinger'">
      <section class="detail-block"><h3>Renewal coverage</h3><p>{{ hostingerSync?.status === 'error' ? 'Hostinger sync failed; previously discovered services and commitments are retained.' : hostingerSync?.lastSyncedAt ? `Last successful sync · ${new Date(hostingerSync.lastSyncedAt).toLocaleString()}` : 'No successful Hostinger sync is available.' }}</p><p class="detail-note">Hostinger renewal amounts are fixed commitments, not provider-reported metered spend or imported invoices.</p><ul v-if="hostingerRows?.length" class="detail-observations"><li v-for="item in hostingerRows" :key="item.externalId"><span><strong>{{ item.name }} · {{ item.renewalPrice === null ? 'Price unavailable' : money(item.renewalPrice, item.currency) }}</strong><small>{{ hostingerStatus(item) }} · {{ item.recurrenceInterval && item.recurrenceUnit && item.recurrenceUnit !== 'unsupported' ? `Every ${item.recurrenceInterval} ${item.recurrenceUnit}${item.recurrenceInterval === 1 ? '' : 's'}` : 'Billing period unsupported' }} · next renewal {{ item.nextBillingAt?.slice(0, 10) ?? 'not reported' }}</small><small>{{ item.automaticallyLinked ? 'Origin: Hostinger · included once in fixed commitments.' : item.linkedSubscriptionId ? 'Origin: Hostinger · linked to your existing subscription.' : item.possibleMatches.length ? `Possible manual match: ${item.possibleMatches.map(match => match.name).join(', ')}.` : 'Origin: Hostinger account.' }}</small></span></li></ul><p v-else class="detail-note">No discovered Hostinger services are available.</p><p v-if="!hostingerSubscriptions.length" class="detail-note">No linked Hostinger fixed commitments are available.</p><ul v-else class="detail-observations"><li v-for="item in hostingerSubscriptions" :key="item.id"><span><strong>{{ item.name }} · {{ money(item.amount, item.currency) }}</strong><small>Every {{ item.recurrenceInterval }} {{ item.recurrenceUnit }}{{ item.recurrenceInterval === 1 ? '' : 's' }} · next renewal {{ nextRenewalOnOrAfter(item, today) ?? 'none scheduled' }} · {{ item.status }}</small></span></li></ul><a class="secondary-button" href="/services" @click="close">Review Hostinger subscriptions</a></section>
    </template>

    <template v-else-if="provider === 'github'">
      <section class="detail-block"><h3>Billing data unavailable</h3><p>GitHub's available billing data does not provide a supported monetary amount and currency for this account. StackDues does not estimate or invent a total.</p><p class="detail-note">No GitHub connection or billing observations are stored.</p><a class="text-button" href="/connections" @click="close">Back to provider catalog</a></section>
    </template>

    <template v-else>
      <section class="detail-block" aria-labelledby="provider-status-heading">
        <h3 id="provider-status-heading">Provider status</h3>
        <dl class="detail-metrics"><div><dt>Connection</dt><dd>{{ syncStatus?.status === 'not-configured' ? 'Not connected' : syncStatus?.status === 'error' ? 'Sync failed' : syncStatus?.status === 'synced' ? 'Connected' : 'Unavailable' }}</dd></div><div><dt>Last successful sync</dt><dd>{{ syncStatus?.lastSyncedAt ? new Date(syncStatus.lastSyncedAt).toLocaleString() : 'Unavailable' }}</dd></div><div><dt>Latest attempt</dt><dd>{{ syncStatus?.lastAttemptAt ? new Date(syncStatus.lastAttemptAt).toLocaleString() : 'Unavailable' }}</dd></div></dl>
        <p v-if="syncStatus?.status === 'error'" class="feed-warning" role="status">Sync failed. Previously saved observations remain visible.</p>
        <p v-else-if="syncStatus && isProviderStale(syncStatus)" class="feed-warning" role="status">The last successful sync is more than 36 hours old. Previously saved observations remain visible.</p>
        <div class="detail-actions"><a class="secondary-button" href="/connections" @click="close">Manage connection or retry</a><a class="text-button" href="/services" @click="close">View services</a></div>
      </section>
      <section class="detail-block" aria-labelledby="provider-actual-heading"><h3 id="provider-actual-heading">Reported actuals</h3><p v-if="!actuals.length" class="detail-note">No actual observations are available. This is unknown, not zero.</p><ul v-else class="detail-observations"><li v-for="snapshot in actuals" :key="snapshot.id"><span><strong>{{ money(snapshot.amount, snapshot.currency) }}</strong><small>{{ period(snapshot) }} · {{ snapshot.periodStart }}–{{ snapshot.periodEnd }} (end exclusive)</small></span><small>Captured {{ new Date(snapshot.capturedAt).toLocaleString() }}</small></li></ul></section>
      <section class="detail-block" aria-labelledby="provider-forecast-heading"><h3 id="provider-forecast-heading">Forecasts</h3><p v-if="!forecasts.length" class="detail-note">A full-period forecast is unavailable for this provider or period.</p><ul v-else class="detail-observations"><li v-for="snapshot in forecasts" :key="snapshot.id"><span><strong>{{ money(snapshot.amount, snapshot.currency) }}</strong><small>{{ period(snapshot) }} · {{ snapshot.periodStart }}–{{ snapshot.periodEnd }}</small></span><small>Captured {{ new Date(snapshot.capturedAt).toLocaleString() }}</small></li></ul></section>
      <section class="detail-block" aria-labelledby="provider-comparison-heading"><h3 id="provider-comparison-heading">Recent comparison</h3><ul v-if="comparisons.length" class="detail-observations"><li v-for="insight in comparisons" :key="insight.currency"><span><strong>{{ insight.changePercent === null ? 'Change unavailable' : `${insight.changePercent > 0 ? '+' : ''}${insight.changePercent.toFixed(1)}%` }}</strong><small>{{ insight.previousComparable === null ? 'No aligned prior period' : `${money(insight.previousComparable, insight.currency)} in the comparable period` }}</small></span><small>{{ insight.currency }}</small></li></ul><p v-else class="detail-note">Not enough aligned provider and currency history for a comparison.</p></section>
      <section v-if="actuals.some(snapshot => breakdown(snapshot).length)" class="detail-block"><h3>Reported service breakdown</h3><template v-for="snapshot in actuals.filter(row => breakdown(row).length)" :key="snapshot.id"><p class="detail-note">{{ snapshot.periodStart }}–{{ snapshot.periodEnd }} · {{ snapshot.currency }} · reported components, not added to the total above</p><ul class="detail-breakdown"><li v-for="item in breakdown(snapshot)" :key="`${item.service}-${item.currency}`"><span>{{ item.service }}</span><strong>{{ money(item.amount, item.currency) }}</strong></li></ul></template></section>
      <p class="detail-note">Observations are independent period reports, not separate payments. Currencies and periods are kept separate; this view does not sum captures.</p>
    </template>
  </dialog>
</template>

<style scoped>
.service-detail-dialog{width:min(680px,calc(100vw - 1rem));max-height:calc(100dvh - 1rem);overflow:auto;padding:clamp(1rem,4vw,2rem);border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink)}
.service-detail-dialog::backdrop{background:#272e2966}
.service-detail-dialog .dialog-header{align-items:flex-start;margin-bottom:.75rem}
.service-detail-dialog h2{font-size:clamp(1.4rem,5vw,2rem);overflow-wrap:anywhere}
.service-detail-intro,.detail-block>p,.detail-note{font-size:.85rem;line-height:1.55;color:var(--muted)}
.detail-block{border-top:1px solid var(--line);padding-top:1rem;margin-top:1.25rem}
.detail-block h3{font-size:1rem;margin:0 0 .75rem}
.detail-metrics{margin:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1rem}
.detail-metrics>div{padding:.6rem 0;border-bottom:1px solid var(--line);min-width:0}
.detail-metrics dt,.detail-observations small{font-size:.72rem;color:var(--muted)}
.detail-metrics dd{margin:.25rem 0 0;overflow-wrap:anywhere;font-size:.85rem}
.detail-observations{list-style:none;padding:0;margin:0}
.detail-observations li{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;padding:.75rem 0;border-bottom:1px solid var(--line)}
.detail-observations li>span{display:grid;gap:.25rem;min-width:0}.detail-observations strong{font-variant-numeric:tabular-nums}.detail-observations small{overflow-wrap:anywhere}
.detail-breakdown{list-style:none;padding:0;margin:0}.detail-breakdown li{display:flex;justify-content:space-between;gap:.75rem;padding:.5rem 0;border-bottom:1px solid var(--line);font-size:.8rem}.detail-breakdown strong{font-variant-numeric:tabular-nums;white-space:nowrap}
.detail-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;margin-top:1rem}
.detail-note{margin:.75rem 0}.service-detail-dialog .feed-warning{font-size:.8rem}
@media(max-width:420px){.detail-metrics{grid-template-columns:1fr}.detail-observations li{display:grid}.detail-actions>*{max-width:100%;text-align:center}}
</style>
