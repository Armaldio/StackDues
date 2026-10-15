<script setup lang="ts">
import { computed, ref } from 'vue'
import type { StoredSubscription } from '../lib/subscription-api'
import type { HostingerDiscoveryRow } from '../lib/hostinger-api'
import type { CloudflareRegistration } from '../lib/cloudflare-registrar-api'
import type { CostProvider } from '../domain/usage-costs'
import type { ProviderPresentation } from '../domain/provider-presentation'

export type InventoryProvider = { id: CostProvider | 'hostinger'; name: string; status: string; summary: string; searchTerms?: string; presentation: ProviderPresentation; lastSyncedAt?: string }
const props = defineProps<{
  subscriptions: StoredSubscription[]
  providers: InventoryProvider[]
  discovered: HostingerDiscoveryRow[]
  registrarRegistrations: CloudflareRegistration[]
  blocked: boolean
  loading: boolean
  formatMoney: (amount: number | null, currency: string) => string
  recurrence: (item: StoredSubscription) => string
  monthly: (item: StoredSubscription) => number
  renewal: (item: StoredSubscription) => string
}>()
const emit = defineEmits<{
  details: [selection: { kind: 'subscription'; id: string } | { kind: 'provider'; provider: CostProvider | 'hostinger' }]
  edit: [item: StoredSubscription]
  toggle: [item: StoredSubscription]
  remove: [item: StoredSubscription]
  review: []
}>()
const query = defineModel<string>('query', { required: true })
const status = defineModel<string>('status', { required: true })
const entryKind = ref<'all' | 'fixed' | 'provider' | 'discovered'>('all')
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase())
const visibleSubscriptions = computed(() => entryKind.value !== 'provider' && entryKind.value !== 'discovered' ? props.subscriptions.filter(item => (status.value === 'all' || item.status === status.value) && `${item.name} ${item.provider ?? ''} ${item.currency} ${item.status}`.toLocaleLowerCase().includes(normalizedQuery.value)) : [])
const visibleProviders = computed(() => entryKind.value !== 'fixed' && entryKind.value !== 'discovered' ? props.providers.filter(item => `${item.name} ${item.id} ${item.status} ${item.summary} ${item.searchTerms ?? ''}`.toLocaleLowerCase().includes(normalizedQuery.value)) : [])
const visibleDiscovered = computed(() => entryKind.value !== 'fixed' && entryKind.value !== 'provider' ? props.discovered.filter(item => !item.linkedSubscriptionId && `${item.name} Hostinger ${item.status} ${item.currency} ${item.renewalPrice ?? ''} ${item.excluded ? 'excluded uncounted' : item.renewalAvailable ? 'needs review uncounted' : 'unavailable uncounted'}`.toLocaleLowerCase().includes(normalizedQuery.value)) : [])
const visibleRegistrations = computed(() => entryKind.value !== 'fixed' && entryKind.value !== 'provider' ? props.registrarRegistrations.filter(item => `${item.domainName} Cloudflare Registrar ${item.status} ${item.autoRenew ? 'auto renew enabled' : 'auto renew off'} ${item.expiresAt ?? ''}`.toLocaleLowerCase().includes(normalizedQuery.value)) : [])
const visibleCount = computed(() => visibleSubscriptions.value.length + visibleProviders.value.length + visibleDiscovered.value.length + visibleRegistrations.value.length)
function hostingerOrigin(id: string) {
  const linked = props.discovered.find(item => item.linkedSubscriptionId === id)
  if (linked?.automaticallyLinked) return 'Added automatically from the Hostinger connection.'
  if (linked) return 'Manually saved subscription · linked to this Hostinger service.'
  return 'Manually saved subscription · not linked to the Hostinger connection.'
}
function timestamp(value?: string) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '' }
</script>

<template>
  <section class="service-inventory" aria-labelledby="inventory-heading">
    <div class="section-header"><div><p class="eyebrow">Everything you track</p><h2 id="inventory-heading">Services <span class="heading-count">{{ visibleCount }} entries</span></h2>
        <ul class="inventory-counts" aria-label="Matching entry counts"><li>Fixed subscriptions <strong>{{ visibleSubscriptions.length }}</strong></li><li>Provider entries <strong>{{ visibleProviders.length }}</strong></li><li>Uncounted discoveries <strong>{{ visibleDiscovered.length + visibleRegistrations.length }}</strong></li></ul>
      </div>
      <div class="table-tools inventory-tools"><label class="sr-only" for="service-search">Search services</label><input id="service-search" v-model="query" type="search" placeholder="Search services and providers" />
        <label class="sr-only" for="service-kind">Filter service entries by type</label><select id="service-kind" v-model="entryKind"><option value="all">All entry types</option><option value="fixed">Fixed subscriptions</option><option value="provider">Provider entries</option><option value="discovered">Uncounted discoveries</option></select>
        <label class="sr-only" for="service-status">Filter fixed subscriptions by status</label><select id="service-status" v-model="status"><option value="all">All subscription statuses</option><option value="active">Active subscriptions</option><option value="paused">Paused subscriptions</option><option value="cancelled">Cancelled subscriptions</option></select>
      </div>
    </div>
    <p class="inventory-filter-note">Search and entry type apply to all entries. Subscription status applies to fixed subscriptions only.</p>
    <p v-if="loading" class="metric-note" role="status">Loading tracked services…</p>
    <div v-else-if="visibleSubscriptions.length || visibleProviders.length || visibleDiscovered.length || visibleRegistrations.length" class="inventory-groups" aria-label="Tracked services">
      <section v-if="visibleSubscriptions.length" class="inventory-group" aria-labelledby="fixed-inventory-heading">
      <h3 id="fixed-inventory-heading">Fixed subscriptions <span>{{ visibleSubscriptions.length }}</span></h3>
      <div class="inventory-grid" role="list" aria-label="Fixed subscriptions">
      <article v-for="item in visibleSubscriptions" :key="`sub-${item.id}`" class="inventory-card subscription-inventory-card" role="listitem">
        <header><div><p class="eyebrow">{{ item.provider || 'Fixed subscription' }}</p><h3><button class="service-detail-trigger" type="button" @click="emit('details', { kind: 'subscription', id: item.id })">{{ item.name }}</button></h3></div><span class="status-pill" :class="`status-${item.status}`">{{ item.status }}</span></header>
        <p v-if="item.provider?.toLowerCase() === 'hostinger'" class="inventory-origin">{{ hostingerOrigin(item.id) }}</p>
        <dl><div><dt>Charge / cycle</dt><dd>{{ formatMoney(item.amount, item.currency) }} · {{ recurrence(item) }}</dd></div><div><dt>Monthly equivalent</dt><dd>{{ formatMoney(monthly(item), item.currency) }}</dd></div><div><dt>Next renewal</dt><dd>{{ renewal(item) }}</dd></div></dl>
        <div class="row-actions"><button class="text-button" :disabled="blocked" :aria-label="`Edit ${item.name}`" @click="emit('edit', item)">Edit</button><button class="text-button" :disabled="blocked" :aria-label="`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name} in subscriptions`" @click="emit('toggle', item)">{{ item.status === 'active' ? 'Pause' : 'Resume' }}</button><button class="text-button delete-button" :disabled="blocked" :aria-label="`Delete ${item.name}`" @click="emit('remove', item)">Delete</button></div>
      </article>
      </div>
      </section>
      <section v-if="visibleProviders.length" class="inventory-group" aria-labelledby="provider-inventory-heading">
      <h3 id="provider-inventory-heading">Provider accounts <span>{{ visibleProviders.length }}</span></h3>
      <div class="inventory-grid" role="list" aria-label="Provider accounts">
      <article v-for="item in visibleProviders" :key="`provider-${item.id}`" class="inventory-card provider-inventory-card" role="listitem">
        <header><div><p class="eyebrow">{{ item.id === 'hostinger' ? 'Fixed provider renewals' : item.id === 'digitalocean' ? 'Finalized invoices' : 'Metered provider' }}</p><h3><button class="service-detail-trigger" type="button" @click="emit('details', { kind: 'provider', provider: item.id })">{{ item.name }}</button></h3></div><span class="status-label" :class="`status-${item.presentation.state}`">{{ item.presentation.label === 'Updated' ? 'Synced' : item.presentation.label }}</span></header>
        <p v-if="item.presentation.label === 'Updated' && item.lastSyncedAt" class="provider-last-refresh">Last successful sync · {{ timestamp(item.lastSyncedAt) }}</p>
        <p>{{ item.summary }}</p><p v-if="!['updated', 'checked-empty', 'not-connected'].includes(item.presentation.state)" class="metric-note" role="status">{{ item.presentation.detail }}</p><p class="metric-note">{{ item.id === 'hostinger' ? 'Linked renewals are represented once by the saved fixed subscription; discoveries remain uncounted until reviewed.' : item.id === 'digitalocean' ? 'Finalized invoice totals are shown for their billing periods, not as current-month accrual.' : 'Reported usage and forecasts stay separate from fixed commitments.' }}</p><button class="text-button" type="button" @click="emit('details', { kind: 'provider', provider: item.id })">View provider details</button>
      </article>
      </div>
      </section>
      <section v-if="visibleRegistrations.length" class="inventory-group" aria-labelledby="registrar-inventory-heading">
      <h3 id="registrar-inventory-heading">Cloudflare domain renewals · price unavailable <span>{{ visibleRegistrations.length }}</span></h3>
      <div class="inventory-grid" role="list" aria-label="Cloudflare domain renewals, not included in financial totals">
      <article v-for="item in visibleRegistrations" :key="`registrar-${item.domainName}`" class="inventory-card discovered-inventory-card" role="listitem">
        <header><div><p class="eyebrow">Cloudflare Registrar</p><h3>{{ item.domainName }}</h3></div><span class="status-pill">{{ item.autoRenew ? 'Auto-renews' : 'Auto-renew off' }}</span></header>
        <p>{{ item.seenInLatestSync ? `Registrar status · ${item.status}` : `Last known · sync unconfirmed (${item.status})` }}</p>
        <dl><div><dt>Next renewal / expiry</dt><dd>{{ item.expiresAt ?? 'Date unavailable' }}</dd></div><div><dt>Renewal price</dt><dd>Unavailable from Cloudflare API</dd></div></dl>
        <p class="inventory-note">This domain is tracked by its renewal date and auto-renew setting. No estimated amount is added to monthly totals or the payment schedule.</p>
      </article>
      </div>
      </section>
      <section v-if="visibleDiscovered.length" class="inventory-group" aria-labelledby="discovered-inventory-heading">
      <h3 id="discovered-inventory-heading">Hostinger discoveries · not counted <span>{{ visibleDiscovered.length }}</span></h3>
      <div class="inventory-grid" role="list" aria-label="Uncounted Hostinger discoveries">
      <article v-for="item in visibleDiscovered" :key="`hostinger-${item.externalId}`" class="inventory-card discovered-inventory-card" role="listitem">
        <header><div><p class="eyebrow">Hostinger · {{ item.externalId }}</p><h3>{{ item.name }}</h3></div><span class="status-pill">{{ item.excluded ? 'Excluded' : item.renewalAvailable ? 'Needs review' : 'Unavailable' }}</span></header>
        <p>{{ item.excluded ? 'Excluded by you · uncounted and not included in fixed commitments.' : item.renewalAvailable ? 'Uncounted candidate · not included in fixed commitments.' : 'No supported recurring charge is available · uncounted.' }}</p>
        <dl><div><dt>Renewal</dt><dd>{{ formatMoney(item.upcomingCommitment, item.currency) }}</dd></div><div><dt>Provider status</dt><dd>{{ item.seenInLatestSync ? item.status : 'Last known · sync unconfirmed' }}</dd></div></dl>
        <button class="text-button" type="button" @click="emit('review')">Review Hostinger matches and actions</button>
      </article>
      </div>
      </section>
    </div>
    <p v-else class="quiet-empty" role="status">No entries match your search, entry type, or subscription status filter.</p>
    <p class="inventory-note">Cloudflare domains stay outside financial totals because their renewal price is unavailable. Unlinked Hostinger discoveries need review; linked services appear once as the saved subscription.</p>
  </section>
</template>

<style scoped>
.inventory-counts{display:flex;flex-wrap:wrap;gap:.35rem .9rem;list-style:none;padding:0;margin:.5rem 0 0;color:var(--muted);font-size:.75rem}
.inventory-counts li{display:flex;gap:.3rem;align-items:baseline}
.inventory-counts strong{font-variant-numeric:tabular-nums;color:var(--ink)}
.inventory-filter-note{margin:.5rem 0;color:var(--muted);font-size:.75rem}
.inventory-groups{display:grid;gap:1.5rem}
.inventory-group>h3{display:flex;align-items:baseline;gap:.45rem;margin:0 0 .65rem;font-size:1rem}
.inventory-group>h3 span{color:var(--muted);font: .8rem var(--mono)}
.inventory-origin,.provider-last-refresh{color:var(--muted);font-size:.8rem;line-height:1.45}
.inventory-card .inventory-origin{margin:.4rem 0 0}
.inventory-card .provider-last-refresh{margin:.4rem 0}
</style>
