<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import SubscriptionForm from './components/SubscriptionForm.vue'
import { createSubscription, nextRenewalOnOrAfter, normalizeCost, normalizedTotals, upcomingRenewals, type Subscription, type Renewal } from './domain/subscriptions'
import { loadSubscriptions, saveSubscriptions, type LedgerStorage } from './lib/subscription-storage'

function browserStorage(): LedgerStorage {
  try { return window.localStorage } catch { return { getItem() { throw new Error('Storage unavailable') }, setItem() { throw new Error('Storage unavailable') }, removeItem() {} } }
}
const storage = browserStorage()
const loaded = loadSubscriptions(storage)
const subscriptions = ref(loaded.subscriptions)
const storageError = ref(loaded.error)
const blocked = ref(loaded.blocked)
const notice = ref('')
const today = ref(new Date().toISOString().slice(0, 10))
const timer = window.setInterval(() => { today.value = new Date().toISOString().slice(0, 10) }, 60_000)
onUnmounted(() => window.clearInterval(timer))
const showForm = ref(false)
const editing = ref<Subscription>()
const windowDays = ref(30)
const search = ref('')
const statusFilter = ref('all')
const activeCount = computed(() => subscriptions.value.filter((item) => item.status === 'active').length)
const totals = computed(() => normalizedTotals(subscriptions.value))
function endDate(days: number) { const date = new Date(`${today.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days - 1); return date.toISOString().slice(0, 10) }
const renewals = computed(() => upcomingRenewals(subscriptions.value, today.value, endDate(windowDays.value)))
function chargeTotals(charges: Renewal[]) {
  const values = new Map<string, number>()
  for (const charge of charges) values.set(charge.currency, (values.get(charge.currency) ?? 0) + charge.amount)
  return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }))
}
const due30 = computed(() => chargeTotals(upcomingRenewals(subscriptions.value, today.value, endDate(30))))
const due90 = computed(() => chargeTotals(upcomingRenewals(subscriptions.value, today.value, endDate(90))))
const visibleSubscriptions = computed(() => subscriptions.value.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value) && `${item.name} ${item.provider ?? ''}`.toLowerCase().includes(search.value.toLowerCase())))
function money(amount: number, currency: string) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) } catch { return `${currency} ${amount.toFixed(2)}` } }
function dateLabel(date: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) }
function recurrence(item: Subscription) { return `Every ${item.recurrenceInterval} ${item.recurrenceUnit}${item.recurrenceInterval === 1 ? '' : 's'}` }
function openForm(item?: Subscription) { editing.value = item; showForm.value = true }
function commit(items: Subscription[], message: string): boolean {
  const error = saveSubscriptions(storage, items)
  if (error) { storageError.value = error; return false }
  subscriptions.value = items; storageError.value = null; notice.value = message; return true
}
function save(item: Subscription) {
  const items = subscriptions.value.some(({ id }) => id === item.id) ? subscriptions.value.map((existing) => existing.id === item.id ? item : existing) : [...subscriptions.value, item]
  if (commit(items, `${item.name} saved.`)) showForm.value = false
}
function setStatus(item: Subscription) { const status = item.status === 'active' ? 'paused' : 'active'; commit(subscriptions.value.map((existing) => existing.id === item.id ? { ...existing, status } : existing), `${item.name} ${status === 'active' ? 'resumed' : 'paused'} in your ledger.`) }
function remove(item: Subscription) { if (window.confirm(`Delete ${item.name} from your ledger? This does not cancel the service.`)) commit(subscriptions.value.filter(({ id }) => id !== item.id), `${item.name} deleted.`) }
function loadExamples() {
  const examples = [
    { name: 'Bitwarden · example', amount: 10, recurrenceInterval: 1, recurrenceUnit: 'year' as const },
    { name: 'Hostinger · example', amount: 192, recurrenceInterval: 4, recurrenceUnit: 'year' as const },
    { name: 'VPS · example', amount: 12, recurrenceInterval: 1, recurrenceUnit: 'month' as const },
  ].map((item) => createSubscription({ ...item, id: crypto.randomUUID(), billingType: 'fixed', currency: 'USD', nextRenewalAt: today.value, status: 'active' }))
  commit(examples, 'Example subscriptions loaded. Edit or delete them before adding your real costs.')
}
</script>

<template>
  <a class="skip-link" href="#overview">Skip to dashboard</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Primary navigation">
      <a class="brand" href="#overview"><span class="brand-mark" aria-hidden="true">L</span>ledger<span class="brand-period">.</span></a>
      <p class="workspace-label">Personal workspace</p>
      <nav><a href="#overview" class="nav-active"><span aria-hidden="true">◫</span> Overview</a><a href="#subscriptions"><span aria-hidden="true">≡</span> Subscriptions <span class="nav-count">{{ subscriptions.length }}</span></a><a href="#infrastructure"><span aria-hidden="true">▤</span> Infrastructure</a><a href="#history"><span aria-hidden="true">↻</span> History</a></nav>
      <div class="sidebar-note"><span class="local-indicator" aria-hidden="true"></span><strong>Your browser, your ledger</strong><p>Fixed subscriptions stay on this device. No account required.</p></div>
    </aside>
    <main id="overview" tabindex="-1">
      <header class="page-header"><div><p class="eyebrow">Your costs, in one place</p><h1>Overview<span class="heading-period">.</span></h1><p class="muted">Know what you pay. See what’s coming.</p></div><button class="primary-button" :disabled="blocked" @click="openForm()"><span aria-hidden="true">＋</span> Add subscription</button></header>
      <div v-if="storageError" class="error-message storage-error" role="alert">{{ storageError }}</div>
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <section class="summary" aria-label="Fixed subscription summary">
        <div class="monthly-summary"><div class="metric-label"><span>Fixed monthly equivalent</span><span class="small-label">{{ activeCount }} active</span></div><template v-if="totals.length"><div v-for="total in totals" :key="total.currency" class="monthly-value">{{ money(total.monthly, total.currency) }}<span>/ mo</span></div></template><p v-else class="monthly-value">—<span>/ mo</span></p><p class="metric-note">Your active charges spread over their billing cycles.</p></div>
        <div class="secondary-metrics"><div class="metric"><p class="metric-label">Annual equivalent</p><p v-for="total in totals" :key="total.currency" class="metric-value">{{ money(total.yearly, total.currency) }}</p><p v-if="!totals.length" class="metric-value">—</p><p class="metric-note">Normalized rate, not this year’s bill.</p></div><div class="metric"><p class="metric-label">Due in 30 days</p><p v-for="total in due30" :key="total.currency" class="metric-value">{{ money(total.amount, total.currency) }}</p><p v-if="!due30.length" class="metric-value">—</p><p class="metric-note">Actual upcoming charges.</p></div><div class="metric"><p class="metric-label">Due in 90 days</p><p v-for="total in due90" :key="total.currency" class="metric-value">{{ money(total.amount, total.currency) }}</p><p v-if="!due90.length" class="metric-value">—</p><p class="metric-note">Includes the next 30 days.</p></div></div>
      </section>
      <p class="summary-footnote">Currencies are kept separate. Renewal windows include today · {{ dateLabel(today) }} UTC.</p>
      <div class="content-columns">
        <section class="renewals-panel" aria-labelledby="renewals-title"><div class="section-header"><div><p class="eyebrow">On the horizon</p><h2 id="renewals-title">Upcoming renewals</h2></div><div class="segmented-control" aria-label="Renewal window"><button :aria-pressed="windowDays === 30" @click="windowDays = 30">30 days</button><button :aria-pressed="windowDays === 90" @click="windowDays = 90">90 days</button></div></div>
          <div v-if="!renewals.length" class="quiet-empty"><span class="calendar-icon" aria-hidden="true">□</span><h3>Nothing coming up</h3><p>{{ activeCount ? `No active renewals in the next ${windowDays} days.` : 'Add a subscription to see your next charges here.' }}</p></div>
          <ol v-else class="renewal-list"><li v-for="renewal in renewals" :key="`${renewal.subscription.id}-${renewal.date}`"><time :datetime="renewal.date" class="renewal-date"><span>{{ new Date(`${renewal.date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) }}</span><strong>{{ renewal.date.slice(8) }}</strong></time><div class="renewal-details"><strong>{{ renewal.subscription.name }}</strong><span>{{ recurrence(renewal.subscription) }}</span></div><strong class="amount">{{ money(renewal.amount, renewal.currency) }}</strong></li></ol>
        </section>
        <section id="infrastructure" class="infrastructure-panel" aria-labelledby="infrastructure-title"><div class="section-header"><div><p class="eyebrow">Variable costs</p><h2 id="infrastructure-title">Infrastructure</h2></div></div><p class="panel-intro">Metered spend is tracked separately from fixed commitments.</p><div class="provider-placeholder"><span class="provider-letter">A</span><strong>AWS</strong><span class="status-pill">Not connected</span></div><div class="provider-placeholder"><span class="provider-letter">C</span><strong>Cloudflare</strong><span class="status-pill">Not connected</span></div><p class="small-note">Connectors will report actual usage and estimates without adding a fixed renewal charge.</p></section>
      </div>
      <section id="subscriptions" class="subscriptions-section" aria-labelledby="subscriptions-title"><div class="section-header"><div><p class="eyebrow">The fixed ledger</p><h2 id="subscriptions-title">Subscriptions <span class="heading-count">{{ subscriptions.length }}</span></h2></div><div v-if="subscriptions.length" class="table-tools"><label class="sr-only" for="subscription-search">Search subscriptions</label><input id="subscription-search" v-model="search" type="search" placeholder="Search subscriptions" /><label class="sr-only" for="status-filter">Filter by status</label><select id="status-filter" v-model="statusFilter"><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></div></div>
        <div v-if="!subscriptions.length" class="ledger-empty"><span class="empty-mark" aria-hidden="true">＋</span><div><h3>Start with what you pay.</h3><p>Add a subscription, a domain, or a VPS. Monthly, yearly, or every four years — it all belongs here.</p><div class="empty-actions"><button class="primary-button" :disabled="blocked" @click="openForm()">Add your first subscription</button><button class="text-button" :disabled="blocked" @click="loadExamples">Try example subscriptions <span aria-hidden="true">↗</span></button></div></div></div>
        <div v-else class="table-scroll"><table><thead><tr><th scope="col">Subscription</th><th scope="col">Charge / cycle</th><th scope="col">Monthly equivalent</th><th scope="col">Next renewal</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr v-for="item in visibleSubscriptions" :key="item.id"><th scope="row"><strong>{{ item.name }}</strong><span class="cell-note">{{ item.provider || 'Fixed subscription' }}</span></th><td><strong class="amount">{{ money(item.amount, item.currency) }}</strong><span class="cell-note">{{ recurrence(item) }}</span></td><td class="amount">{{ money(normalizeCost(item).monthly, item.currency) }}</td><td>{{ nextRenewalOnOrAfter(item, today) ? dateLabel(nextRenewalOnOrAfter(item, today)!) : '—' }}</td><td><span class="status-pill" :class="`status-${item.status}`">{{ item.status }}</span></td><td><div class="row-actions"><button class="text-button" :disabled="blocked" :aria-label="`Edit ${item.name}`" @click="openForm(item)">Edit</button><button class="text-button" :disabled="blocked" :aria-label="`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name} in ledger`" @click="setStatus(item)">{{ item.status === 'active' ? 'Pause' : 'Resume' }}</button><button class="text-button delete-button" :disabled="blocked" :aria-label="`Delete ${item.name}`" @click="remove(item)">Delete</button></div></td></tr><tr v-if="!visibleSubscriptions.length"><td colspan="6" class="no-results">No subscriptions match your filters.</td></tr></tbody></table></div>
      </section>
      <section id="history" class="history-placeholder" aria-labelledby="history-title"><h2 id="history-title">History</h2><p class="muted">Provider snapshots will appear here when infrastructure is connected.</p></section>
      <footer><span>ledger<span class="brand-period">.</span></span><p>Fixed subscriptions are saved in this browser. Clearing browser data removes them.</p></footer>
    </main>
  </div>
  <SubscriptionForm v-if="showForm" :subscription="editing" :today="today" :save-error="storageError" @save="save" @close="showForm = false" />
</template>
