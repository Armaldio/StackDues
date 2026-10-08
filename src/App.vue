<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import SubscriptionForm from './components/SubscriptionForm.vue'
import InfrastructurePanel from './components/InfrastructurePanel.vue'
import CostHistory from './components/CostHistory.vue'
import LegacyImport from './components/LegacyImport.vue'
import { emptyCostFeed } from './lib/cost-feed'
import { createSubscription, nextRenewalOnOrAfter, normalizeCost, normalizedTotals, renewalChargeTotals, upcomingRenewals, type Subscription, type Renewal } from './domain/subscriptions'
import { createStoredSubscription, deleteStoredSubscription, fetchSubscriptions, importStoredSubscriptions, updateStoredSubscription, type StoredSubscription, type ImportResult } from './lib/subscription-api'

const costFeed = ref(emptyCostFeed())
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
  catch (cause) { storageError.value = cause instanceof Error ? cause.message : 'The ledger could not be loaded. Reload before making changes.' }
  finally { loading.value = false }
}
onMounted(reloadLedger)
const notice = ref('')
const today = ref(new Date().toISOString().slice(0, 10))
const timer = window.setInterval(() => { today.value = new Date().toISOString().slice(0, 10) }, 60_000)
onUnmounted(() => window.clearInterval(timer))
const showForm = ref(false)
const editing = ref<StoredSubscription>()
const windowDays = ref(30)
const search = ref('')
const statusFilter = ref('all')
const activeCount = computed(() => subscriptions.value.filter((item) => item.status === 'active').length)
const totals = computed(() => normalizedTotals(subscriptions.value))
function endDate(days: number) { const date = new Date(`${today.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days - 1); return date.toISOString().slice(0, 10) }
const renewals = computed(() => upcomingRenewals(subscriptions.value, today.value, endDate(windowDays.value)))
function chargeTotals(charges: Renewal[]): { currency: string; amount: number | null }[] {
  try { return renewalChargeTotals(charges) }
  catch { return [...new Set(charges.map(charge => charge.currency))].sort().map(currency => ({ currency, amount: null })) }
}
const due30 = computed(() => chargeTotals(upcomingRenewals(subscriptions.value, today.value, endDate(30))))
const due365 = computed(() => chargeTotals(upcomingRenewals(subscriptions.value, today.value, endDate(365))))
const due90 = computed(() => chargeTotals(upcomingRenewals(subscriptions.value, today.value, endDate(90))))
const visibleSubscriptions = computed(() => subscriptions.value.filter((item) => (statusFilter.value === 'all' || item.status === statusFilter.value) && `${item.name} ${item.provider ?? ''}`.toLowerCase().includes(search.value.toLowerCase())))
function money(amount: number | null, currency: string) { if (amount === null) return `${currency} total unavailable`; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount) } catch { return `${currency} ${amount.toFixed(2)}` } }
function dateLabel(date: string) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`)) }
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
    notice.value = `${item.name} ${status === 'active' ? 'resumed' : 'paused'} in your ledger.`
  } catch (cause) { mutationError(cause) }
  finally { busy.value = false }
}
async function remove(item: StoredSubscription) {
  if (blocked.value || !window.confirm(`Delete ${item.name} from your ledger? This does not cancel the service.`)) return
  busy.value = true
  try { await deleteStoredSubscription(item.id, item.revision); subscriptions.value = subscriptions.value.filter(({ id }) => id !== item.id); notice.value = `${item.name} deleted.` }
  catch (cause) { mutationError(cause) }
  finally { busy.value = false }
}
async function importLedger(items: Subscription[]): Promise<ImportResult> {
  if (blocked.value) throw new Error('Reload the ledger before importing.')
  busy.value = true
  try {
    const result = await importStoredSubscriptions(items)
    subscriptions.value = result.subscriptions; storageError.value = null; notice.value = `${result.createdIds.length} subscriptions imported.`
    return result
  } catch (cause) { mutationError(cause); throw cause }
  finally { busy.value = false }
}
async function loadExamples() {
  const examples = [
    { name: 'Bitwarden · example', amount: 10, recurrenceInterval: 1, recurrenceUnit: 'year' as const },
    { name: 'Hostinger · example', amount: 192, recurrenceInterval: 4, recurrenceUnit: 'year' as const },
    { name: 'VPS · example', amount: 12, recurrenceInterval: 1, recurrenceUnit: 'month' as const },
  ].map((item) => createSubscription({ ...item, id: crypto.randomUUID(), billingType: 'fixed', currency: 'USD', nextRenewalAt: today.value, status: 'active' }))
  try { await importLedger(examples); notice.value = 'Example subscriptions loaded. Edit or delete them before adding your real costs.' }
  catch { /* The request error is shown above the ledger. */ }
}

</script>

<template>
  <a class="skip-link" href="#overview">Skip to dashboard</a>
  <div class="app-shell">
    <aside class="sidebar" aria-label="Primary navigation">
      <a class="brand" href="#overview"><span class="brand-mark" aria-hidden="true">L</span>ledger<span class="brand-period">.</span></a>
      <p class="workspace-label">Personal workspace</p>
      <nav><a href="#overview" class="nav-active"><span aria-hidden="true">◫</span> Overview</a><a href="#subscriptions"><span aria-hidden="true">≡</span> Subscriptions <span class="nav-count">{{ subscriptions.length }}</span></a><a href="#infrastructure"><span aria-hidden="true">▤</span> Infrastructure</a><a href="#history"><span aria-hidden="true">↻</span> History</a></nav>
      <div class="sidebar-note"><span class="local-indicator" aria-hidden="true"></span><strong>Your private ledger</strong><p>Fixed subscriptions are saved to your account and available across devices.</p></div>
    </aside>
    <main id="overview" tabindex="-1">
      <header class="page-header"><div><p class="eyebrow">Your costs, in one place</p><h1>Overview<span class="heading-period">.</span></h1><p class="muted">Know what you pay. See what’s coming.</p><form action="/auth/logout" method="post"><button class="text-button" type="submit">Sign out</button></form></div><button class="primary-button" :disabled="blocked" @click="openForm()"><span aria-hidden="true">＋</span> Add subscription</button></header>
      <div v-if="storageError" class="error-message storage-error" role="alert">{{ storageError }} <button class="text-button" type="button" :disabled="loading || busy" @click="reloadLedger">Reload ledger</button><a v-if="storageError.includes('session expired')" href="/login">Sign in</a></div>
      <p v-if="loading" role="status">Loading your private ledger…</p>
      <p v-else-if="busy" role="status">Saving your ledger…</p>
      <p class="sr-only" role="status" aria-live="polite">{{ notice }}</p>
      <section v-if="loaded" class="summary" aria-label="Fixed subscription summary">
        <div class="monthly-summary"><div class="metric-label"><span>Fixed monthly equivalent</span><span class="small-label">{{ activeCount }} active</span></div><template v-if="totals.length"><div v-for="total in totals" :key="total.currency" class="monthly-value">{{ money(total.monthly, total.currency) }}<span>/ mo</span></div></template><p v-else class="monthly-value">—<span>/ mo</span></p><p class="metric-note">Your active charges spread over their billing cycles.</p></div>
        <div class="secondary-metrics"><div class="metric"><p class="metric-label">Annual equivalent</p><p v-for="total in totals" :key="total.currency" class="metric-value">{{ money(total.yearly, total.currency) }}</p><p v-if="!totals.length" class="metric-value">—</p><p class="metric-note">Normalized rate, not this year’s bill.</p><p v-for="total in due365" :key="total.currency" class="metric-note">{{ money(total.amount, total.currency) }} due in 365 days.</p></div><div class="metric"><p class="metric-label">Due in 30 days</p><p v-for="total in due30" :key="total.currency" class="metric-value">{{ money(total.amount, total.currency) }}</p><p v-if="!due30.length" class="metric-value">—</p><p class="metric-note">Actual upcoming charges.</p></div><div class="metric"><p class="metric-label">Due in 90 days</p><p v-for="total in due90" :key="total.currency" class="metric-value">{{ money(total.amount, total.currency) }}</p><p v-if="!due90.length" class="metric-value">—</p><p class="metric-note">Includes the next 30 days.</p></div></div>
      </section>
      <p v-if="loaded" class="summary-footnote">Currencies are kept separate. Renewal windows include today · {{ dateLabel(today) }} UTC.</p>
      <div v-if="loaded" class="content-columns single-column">
        <section class="renewals-panel" aria-labelledby="renewals-title"><div class="section-header"><div><p class="eyebrow">On the horizon</p><h2 id="renewals-title">Upcoming renewals</h2></div><div class="segmented-control" aria-label="Renewal window"><button :aria-pressed="windowDays === 30" @click="windowDays = 30">30 days</button><button :aria-pressed="windowDays === 90" @click="windowDays = 90">90 days</button></div></div>
          <div v-if="!renewals.length" class="quiet-empty"><span class="calendar-icon" aria-hidden="true">□</span><h3>Nothing coming up</h3><p>{{ activeCount ? `No active renewals in the next ${windowDays} days.` : 'Add a subscription to see your next charges here.' }}</p></div>
          <ol v-else class="renewal-list"><li v-for="renewal in renewals" :key="`${renewal.subscription.id}-${renewal.date}`"><time :datetime="renewal.date" class="renewal-date"><span>{{ new Date(`${renewal.date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) }}</span><strong>{{ renewal.date.slice(8) }}</strong></time><div class="renewal-details"><strong>{{ renewal.subscription.name }}</strong><span>{{ recurrence(renewal.subscription) }}</span></div><strong class="amount">{{ money(renewal.amount, renewal.currency) }}</strong></li></ol>
        </section>

      </div>
      <section id="subscriptions" class="subscriptions-section" aria-labelledby="subscriptions-title"><div class="section-header"><div><p class="eyebrow">The fixed ledger</p><h2 id="subscriptions-title">Subscriptions <span v-if="loaded" class="heading-count">{{ subscriptions.length }}</span></h2></div><div v-if="subscriptions.length" class="table-tools"><label class="sr-only" for="subscription-search">Search subscriptions</label><input id="subscription-search" v-model="search" type="search" placeholder="Search subscriptions" /><label class="sr-only" for="status-filter">Filter by status</label><select id="status-filter" v-model="statusFilter"><option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></div></div>
        <div v-if="loaded && !subscriptions.length" class="ledger-empty"><span class="empty-mark" aria-hidden="true">＋</span><div><h3>Start with what you pay.</h3><p>Add a subscription, a domain, or a VPS. Monthly, yearly, or every four years — it all belongs here.</p><div class="empty-actions"><button class="primary-button" :disabled="blocked" @click="openForm()">Add your first subscription</button><button class="text-button" :disabled="blocked" @click="loadExamples">Try example subscriptions <span aria-hidden="true">↗</span></button></div></div></div>
        <div v-else-if="subscriptions.length" class="table-scroll"><table><thead><tr><th scope="col">Subscription</th><th scope="col">Charge / cycle</th><th scope="col">Monthly equivalent</th><th scope="col">Next renewal</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody><tr v-for="item in visibleSubscriptions" :key="item.id"><th scope="row"><strong>{{ item.name }}</strong><span class="cell-note">{{ item.provider || 'Fixed subscription' }}</span></th><td><strong class="amount">{{ money(item.amount, item.currency) }}</strong><span class="cell-note">{{ recurrence(item) }}</span></td><td class="amount">{{ money(normalizeCost(item).monthly, item.currency) }}</td><td>{{ nextRenewalOnOrAfter(item, today) ? dateLabel(nextRenewalOnOrAfter(item, today)!) : '—' }}</td><td><span class="status-pill" :class="`status-${item.status}`">{{ item.status }}</span></td><td><div class="row-actions"><button class="text-button" :disabled="blocked" :aria-label="`Edit ${item.name}`" @click="openForm(item)">Edit</button><button class="text-button" :disabled="blocked" :aria-label="`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name} in ledger`" @click="setStatus(item)">{{ item.status === 'active' ? 'Pause' : 'Resume' }}</button><button class="text-button delete-button" :disabled="blocked" :aria-label="`Delete ${item.name}`" @click="remove(item)">Delete</button></div></td></tr><tr v-if="!visibleSubscriptions.length"><td colspan="6" class="no-results">No subscriptions match your filters.</td></tr></tbody></table></div>
      </section>
      <LegacyImport :disabled="blocked" :existing-subscriptions="subscriptions" :import-subscriptions="importLedger" />
      <InfrastructurePanel :fixed-totals="totals" :today="today" @loaded="costFeed = $event" />
      <CostHistory :snapshots="costFeed.snapshots" />
      <footer class="app-footer"><span>ledger<span class="brand-period">.</span></span><p>Fixed subscriptions are saved privately to your account. Imported browser ledgers remain untouched.</p></footer>
    </main>
  </div>
  <SubscriptionForm v-if="showForm" :subscription="editing" :today="today" :save-error="storageError" :saving="busy" :aria-busy="busy" @save="save" @close="showForm = false" />
</template>
