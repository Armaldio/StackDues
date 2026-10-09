<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { StoredSubscription } from '../lib/subscription-api'
import { addHostingerSubscription, HostingerApiError, linkHostingerSubscription, readHostingerDiscovery, setHostingerSubscriptionExcluded, syncHostinger, type HostingerDiscovery as Discovery } from '../lib/hostinger-api'

const props = defineProps<{ ledger: StoredSubscription[]; initial?: Discovery }>()
const emit = defineEmits<{ changed: []; loaded: [value: Discovery] }>()
const state = ref<Discovery | undefined>(props.initial)
const loading = ref(false)
const busyId = ref('')
const error = ref('')
const notice = ref('')
const expired = ref(false)
const selected = ref<Record<string, string>>({})
const modes = ref<Record<string, 'keep-current' | 'use-provider'>>({})
let readVersion = 0
const availableLedger = computed(() => props.ledger.filter(item => !state.value?.subscriptions.some(source => source.linkedSubscriptionId === item.id)))
const number = (amount: number | null, currency: string) => amount === null ? 'Price unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency, currencyDisplay: 'code' }).format(amount)
const period = (item: Discovery['subscriptions'][number]) => item.recurrenceInterval && item.recurrenceUnit && item.recurrenceUnit !== 'unsupported' ? `Every ${item.recurrenceInterval} ${item.recurrenceUnit}${item.recurrenceInterval === 1 ? '' : 's'}` : 'Billing period not supported'
function unavailableReason(item: Discovery['subscriptions'][number]) {
  if (!item.isAutoRenewed || !['active', 'in_trial', 'paused'].includes(item.status)) return 'This service is not active and auto-renewing.'
  if (!item.recurrenceInterval || !item.recurrenceUnit || item.recurrenceUnit === 'unsupported') return 'Hostinger reported an unsupported billing period.'
  if (item.renewalPrice === null) return 'Hostinger did not report a renewal price.'
  if (!item.nextBillingAt) return 'Hostinger did not report a next billing date.'
  return 'This service does not have a supported upcoming recurring charge.'
}
async function load() {
  if (loading.value || busyId.value) return
  loading.value = true
  const version = ++readVersion
  try {
    const next = await readHostingerDiscovery()
    if (version === readVersion) { setState(next); error.value = ''; expired.value = false }
  }
  catch (cause) { if (version === readVersion) fail(cause) }
  finally { loading.value = false }
}
function setState(next: Discovery) {
  readVersion++
  state.value = next
  emit('loaded', next)
  for (const item of next.subscriptions) modes.value[item.externalId] ??= 'keep-current'
}
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'Hostinger data could not be loaded. Previous data is still available.'; expired.value = cause instanceof HostingerApiError && cause.status === 401 }
async function refresh() {
  if (loading.value || busyId.value) return
  loading.value = true; error.value = ''; notice.value = ''
  try { setState(await syncHostinger()); notice.value = 'Hostinger services and recurring commitments refreshed.'; emit('changed') }
  catch (cause) { fail(cause) }
  finally { loading.value = false }
}
async function setExcluded(item: Discovery['subscriptions'][number], excluded: boolean) {
  if (busyId.value || loading.value) return
  busyId.value = item.externalId; error.value = ''; notice.value = ''
  try { await setHostingerSubscriptionExcluded(item.externalId, excluded); setState(excluded ? await readHostingerDiscovery() : await syncHostinger()); notice.value = excluded ? `${item.name} excluded from automatic commitments.` : `${item.name} re-included; services without a manual match return automatically.`; emit('changed') }
  catch (cause) { fail(cause) }
  finally { busyId.value = '' }
}
async function add(item: Discovery['subscriptions'][number]) {
  if (!item.renewalAvailable || busyId.value || loading.value) return
  busyId.value = item.externalId; error.value = ''; notice.value = ''
  try { await addHostingerSubscription(item.externalId); setState(await readHostingerDiscovery()); notice.value = `${item.name} was added to fixed subscriptions.`; emit('changed') }
  catch (cause) { fail(cause) }
  finally { busyId.value = '' }
}
async function link(item: Discovery['subscriptions'][number]) {
  if (!item.renewalAvailable || busyId.value || loading.value) return
  const manual = props.ledger.find(row => row.id === selected.value[item.externalId])
  if (!manual) return
  busyId.value = item.externalId; error.value = ''; notice.value = ''
  try {
    await linkHostingerSubscription(item.externalId, manual, modes.value[item.externalId] ?? 'keep-current')
    setState(await readHostingerDiscovery()); notice.value = `${item.name} is now linked to ${manual.name}.`; emit('changed')
  } catch (cause) { fail(cause) }
  finally { busyId.value = '' }
}
onMounted(() => { if (!state.value) void load(); else emit('loaded', state.value) })
defineExpose({ reload: load })
watch(() => props.initial, next => { if (next) setState(next) })
</script>

<template>
  <section id="hostinger-discovery" class="hostinger-discovery" aria-labelledby="hostinger-discovery-heading">
    <div class="section-header"><div><p class="eyebrow">Fixed renewal discovery</p><h2 id="hostinger-discovery-heading">Hostinger subscriptions</h2></div></div>
    <p class="section-description">Eligible renewals are added automatically. Possible manual matches need your review; existing values are preserved when linked.</p>
    <p v-if="error" class="error-message" role="alert">{{ error }} <a v-if="expired" href="/login">Sign in</a><button v-else class="text-button" type="button" :disabled="loading" @click="load">Try again</button></p>
    <p v-if="notice" class="connection-notice" role="status">{{ notice }}</p>
    <p v-if="state?.sync.status === 'error'" class="error-message" role="status">Last Hostinger refresh failed. Previously discovered services and linked subscriptions are retained. <button class="text-button" type="button" :disabled="loading || !!busyId" @click="refresh">{{ loading ? 'Retrying…' : 'Retry sync' }}</button></p>
    <p v-else-if="state?.sync.status === 'not-configured'" class="metric-note">Save a Hostinger API token in Connections before syncing services.</p>
    <div v-if="state?.subscriptions.length" class="hostinger-service-list">
      <article v-for="item in state.subscriptions" :key="item.externalId" class="hostinger-service-card">
        <header><div><h3>{{ item.name }}</h3><p class="metric-note">{{ item.externalId }}</p></div><span class="status-pill">{{ item.excluded ? 'Excluded' : !item.seenInLatestSync ? 'Stale · absent from latest sync' : item.linkedSubscriptionId ? item.automaticallyLinked ? 'Tracked automatically' : 'Linked to manual subscription' : item.possibleMatches.length || item.providerNameCollision ? 'Needs review' : item.renewalAvailable ? 'Available to track' : 'Unsupported / not renewing' }}</span></header>
        <dl class="hostinger-service-details"><div><dt>Upcoming renewal</dt><dd>{{ item.upcomingCommitment === null ? 'No future recurring charge' : number(item.upcomingCommitment, item.currency) }}</dd></div><div><dt>Billing cycle</dt><dd>{{ period(item) }}</dd></div><div><dt>Next billing date</dt><dd>{{ item.nextBillingAt?.slice(0, 10) ?? (item.expiresAt ? `Expires ${item.expiresAt.slice(0, 10)}` : 'Not reported') }}</dd></div><div><dt>First term total</dt><dd>{{ number(item.totalPrice, item.currency) }}</dd></div><div><dt>Origin</dt><dd>{{ item.automaticallyLinked ? 'Hostinger · tracked automatically' : item.linkedSubscriptionId ? 'Hostinger · linked to your subscription' : 'Hostinger account' }}</dd></div></dl>
        <template v-if="item.linkedSubscriptionId"><p class="metric-note">{{ item.automaticallyLinked ? 'Tracked automatically and included once in fixed subscriptions and upcoming renewals.' : `Linked to ${props.ledger.find(row => row.id === item.linkedSubscriptionId)?.name ?? 'your existing subscription'}; that subscription remains the only ledger entry.` }} {{ item.seenInLatestSync ? 'Provider updates follow any values you changed manually.' : 'This service was absent from the latest successful sync; its displayed provider details are stale and the saved subscription was retained.' }}</p></template>
        <template v-else-if="item.excluded"><p class="metric-note">Excluded by you. It will stay out of automatic commitments.</p><button class="secondary-button" type="button" :disabled="loading || !!busyId" @click="setExcluded(item, false)">Include on next sync</button></template>
        <template v-else-if="item.renewalAvailable">
          <p v-if="item.providerNameCollision" class="metric-note">Other eligible Hostinger services share this name. Review or link them individually; none are included automatically.</p>
          <p v-if="item.possibleMatches.length" class="metric-note">Possible manual match{{ item.possibleMatches.length > 1 ? 'es' : '' }}: {{ item.possibleMatches.map(row => row.name).join(', ') }}. Review and link explicitly to avoid a duplicate.</p>
          <p v-else class="metric-note">{{ item.seenInLatestSync ? 'Eligible renewal; it is not yet included in fixed commitments.' : 'Last known renewal details are retained; this service was absent from the latest sync.' }}</p>
          <div class="hostinger-service-actions"><button v-if="!item.linkedSubscriptionId && !item.automaticallyLinked && !item.possibleMatches.length && !item.providerNameCollision" class="primary-button" type="button" :disabled="loading || !!busyId" @click="add(item)">{{ busyId === item.externalId ? 'Adding…' : 'Add as a commitment' }}</button>
            <details><summary>Link an existing subscription</summary><label :for="`hostinger-link-${item.externalId}`">Subscription to link<select :id="`hostinger-link-${item.externalId}`" v-model="selected[item.externalId]"><option value="">Choose an existing subscription</option><option v-for="row in availableLedger" :key="row.id" :value="row.id">{{ row.name }} · {{ number(row.amount, row.currency) }}</option></select></label><label class="hostinger-mode"><input v-model="modes[item.externalId]" type="radio" :name="`mode-${item.externalId}`" value="keep-current">Keep existing values as overrides</label><label class="hostinger-mode"><input v-model="modes[item.externalId]" type="radio" :name="`mode-${item.externalId}`" value="use-provider">Apply Hostinger values</label><button type="button" class="secondary-button" :disabled="!selected[item.externalId] || !!busyId" @click="link(item)">Link without a duplicate</button></details>
          </div>
        </template>
        <p v-else class="metric-note">{{ unavailableReason(item) }} This service is not included in future commitment totals.</p>
        <button v-if="!item.excluded && (item.renewalAvailable || item.linkedSubscriptionId)" class="text-button" type="button" :disabled="loading || !!busyId" @click="setExcluded(item, true)">Stop tracking this renewal</button>
      </article>
    </div>
    <p v-else-if="!loading && !error && state?.sync.status !== 'not-configured'" class="quiet-empty">No Hostinger subscriptions were returned on the latest successful sync.</p>
  </section>
</template>
