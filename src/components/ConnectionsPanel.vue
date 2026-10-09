<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ConnectionApiError, deleteConnection, fetchConnections, refreshProviders, saveConnection, type ConnectionProvider, type ConnectionStatuses, type ProviderCredentials } from '../lib/connection-api'
import { syncHostinger } from '../lib/hostinger-api'
import type { CostFeed } from '../lib/cost-feed'
import type { HostingerDiscovery } from '../lib/hostinger-api'
const props = defineProps<{ costFeed: CostFeed; hostingerSync?: HostingerDiscovery['sync'] }>()
const emit = defineEmits<{ changed: []; loaded: [statuses: ConnectionStatuses] }>()
const providers: ConnectionProvider[] = ['aws', 'cloudflare', 'openai', 'hostinger']
const names = { aws: 'Amazon Web Services', cloudflare: 'Cloudflare', hostinger: 'Hostinger', openai: 'OpenAI API' }
const coverage: Record<ConnectionProvider, string> = {
  aws: 'Actual usage, comparable period and full-month forecast when available; invoices are not imported',
  cloudflare: 'Billing-period actuals and service breakdown; no full-month forecast or invoice import',
  hostinger: 'Fixed renewal price, recurrence, auto-renewal and next billing date; invoices are not imported',
  openai: 'Organization-reported API costs by day and currency; no invoice finality or forecast',
}
const permissions: Record<ConnectionProvider, string> = {
  aws: 'Cost Explorer read-only access',
  cloudflare: 'Account billing read access',
  hostinger: 'Read-only access to the subscription list',
  openai: 'Organization Admin API key with organization cost read access',
}
const plannedProviders = [
  { name: 'GitHub', coverage: 'Personal billing usage; currency and payer details are not exposed by the current API, so money totals are not available yet', setup: 'Enhanced billing access may be required' },
  { name: 'DigitalOcean', coverage: 'Daily billing insights in USD; provider notes these may omit final month-end charges', setup: 'Read-only billing:read token required' },
]
const search = ref('')
const availability = ref<'all' | 'available' | 'coming-soon'>('all')
function matches(text: string) { return text.toLowerCase().includes(search.value.trim().toLowerCase()) }
const visibleProviders = computed(() => availability.value === 'coming-soon' ? [] : providers.filter(provider => matches(`${names[provider]} ${coverage[provider]} ${permissions[provider]}`)))
const visiblePlannedProviders = computed(() => availability.value === 'available' ? [] : plannedProviders.filter(provider => matches(`${provider.name} ${provider.coverage} ${provider.setup}`)))
const statuses = ref<ConnectionStatuses>()
const loading = ref(false)
const busy = ref<ConnectionProvider>()
const error = ref('')
const expired = ref(false)
const notice = ref('')
const syncState = reactive<Record<ConnectionProvider, 'idle' | 'syncing' | 'synced' | 'failed'>>({ aws: 'idle', cloudflare: 'idle', hostinger: 'idle', openai: 'idle' })
const syncError = reactive<Record<ConnectionProvider, string>>({ aws: '', cloudflare: '', hostinger: '', openai: '' })
const drafts = reactive<ProviderCredentials>({ aws: { accessKeyId: '', secretAccessKey: '', sessionToken: '' }, cloudflare: { accountId: '', apiToken: '' }, hostinger: { apiToken: '' }, openai: { adminApiKey: '' } })
function clear(provider: ConnectionProvider) {
  if (provider === 'aws') { drafts.aws.accessKeyId = ''; drafts.aws.secretAccessKey = ''; drafts.aws.sessionToken = '' }
  else if (provider === 'cloudflare') { drafts.cloudflare.accountId = ''; drafts.cloudflare.apiToken = '' }
  else if (provider === 'openai') drafts.openai.adminApiKey = ''
  else drafts.hostinger.apiToken = ''
}
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'The request failed. Reload connections before trying again.'; expired.value = cause instanceof ConnectionApiError && cause.status === 401 }
function lastRefresh(provider: ConnectionProvider) { return provider === 'hostinger' ? props.hostingerSync?.lastSyncedAt : props.costFeed.providers[provider].lastSyncedAt }
function lastAttempt(provider: ConnectionProvider) { return provider === 'hostinger' ? props.hostingerSync?.lastAttemptAt : props.costFeed.providers[provider].lastAttemptAt }
function refreshStatus(provider: ConnectionProvider) { return provider === 'hostinger' ? props.hostingerSync?.status : props.costFeed.providers[provider].status }
function formatTime(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function connectionLabel(provider: ConnectionProvider) {
  if (busy.value === provider && syncState[provider] === 'idle') return 'Connecting…'
  if (syncState[provider] === 'syncing') return 'Syncing…'
  if (syncState[provider] === 'failed' || refreshStatus(provider) === 'error') return 'Sync failed'
  if (syncState[provider] === 'synced' || refreshStatus(provider) === 'synced') return 'Synced'
  return statuses.value ? statuses.value[provider].configured ? 'Credentials saved' : 'Not connected' : loading.value ? 'Loading…' : 'Unavailable'
}
async function reload() {
  if (loading.value || busy.value) return
  loading.value = true
  try { statuses.value = await fetchConnections(); error.value = ''; expired.value = false; emit('loaded', statuses.value) }
  catch (cause) { fail(cause) }
  finally { loading.value = false }
}
async function save(provider: ConnectionProvider) {
  if (!statuses.value || loading.value || busy.value || error.value) return
  busy.value = provider; notice.value = ''
  try {
    const credentials = provider === 'aws' ? { accessKeyId: drafts.aws.accessKeyId.trim(), secretAccessKey: drafts.aws.secretAccessKey.trim(), ...(drafts.aws.sessionToken?.trim() ? { sessionToken: drafts.aws.sessionToken.trim() } : {}) } : provider === 'cloudflare' ? { accountId: drafts.cloudflare.accountId.trim(), apiToken: drafts.cloudflare.apiToken.trim() } : provider === 'hostinger' ? { apiToken: drafts.hostinger.apiToken.trim() } : { adminApiKey: drafts.openai.adminApiKey.trim() }
    statuses.value[provider] = await saveConnection(provider, credentials, statuses.value[provider].revision)
    const synced = await runSync(provider)
    notice.value = synced ? `${names[provider]} connection saved and initial sync completed.` : `${names[provider]} connection saved, but its initial sync failed. Previous data is retained; retry below.`
    emit('loaded', statuses.value)
    emit('changed')
  } catch (cause) { fail(cause) }
  finally { clear(provider); busy.value = undefined }
}
async function runSync(provider: ConnectionProvider): Promise<boolean> {
  syncState[provider] = 'syncing'; syncError[provider] = ''
  try {
    if (provider === 'hostinger') await syncHostinger()
    else await refreshProviders(provider)
    syncState[provider] = 'synced'; return true
  } catch (cause) {
    syncState[provider] = 'failed'
    syncError[provider] = cause instanceof Error ? cause.message : 'Initial sync failed. Previous data is retained.'
    return false
  }
}
async function retrySync(provider: ConnectionProvider) {
  if (busy.value || syncState[provider] !== 'failed') return
  busy.value = provider
  try {
    const synced = await runSync(provider)
    notice.value = synced ? `${names[provider]} sync completed.` : ''
    emit('changed')
  } finally { busy.value = undefined }
}
async function disconnect(provider: ConnectionProvider) {
  if (!statuses.value || loading.value || busy.value || error.value || !window.confirm(`Disconnect ${names[provider]}? Stored credentials will be removed. Previous cost observations will be kept.`)) return
  busy.value = provider; notice.value = ''
  try {
    statuses.value[provider] = await deleteConnection(provider, statuses.value[provider].revision)
    await runSync(provider)
    syncState[provider] = 'idle'; syncError[provider] = ''
    notice.value = `${names[provider]} disconnected. Previous cost observations are retained.`
    emit('loaded', statuses.value); emit('changed')
  }
  catch (cause) { fail(cause) }
  finally { clear(provider); busy.value = undefined }
}
onMounted(reload)
onUnmounted(() => providers.forEach(clear))
</script>

<template>
  <section id="connections" class="connections-section" aria-labelledby="connections-heading">
    <div class="section-header"><div><p class="eyebrow">Private provider access</p><h2 id="connections-heading">Connections</h2></div><button type="button" class="secondary-button" :disabled="loading || !!busy" @click="reload">{{ loading ? 'Loading…' : 'Reload connections' }}</button></div>
    <p class="section-description">Credentials are encrypted on the server. Saved secrets are never returned to this dashboard. Replacing credentials replaces the entire connection; previous cost history is kept.</p>
    <p v-if="error" class="error-message" role="alert">{{ error }} <a v-if="expired" href="/login">Sign in</a></p><p v-if="notice" class="connection-notice" role="status">{{ notice }}</p>
    <div class="catalog-tools">
      <label for="provider-search">Search providers<input id="provider-search" v-model="search" type="search" placeholder="Name, data or permission" autocomplete="off" /></label>
      <label for="provider-availability">Provider availability<select id="provider-availability" v-model="availability"><option value="all">All providers</option><option value="available">Available now</option><option value="coming-soon">Coming soon</option></select></label>
      <button class="text-button" type="button" :disabled="!search && availability === 'all'" @click="search = ''; availability = 'all'">Clear filters</button>
    </div>
    <p v-if="!visibleProviders.length && !visiblePlannedProviders.length" class="catalog-empty" role="status">No providers match your search.</p>
    <div v-if="visibleProviders.length" class="connection-grid">
      <article v-for="provider in visibleProviders" :key="provider" class="connection-card">
        <header><h3>{{ names[provider] }}</h3><span class="status-pill">{{ connectionLabel(provider) }}</span></header>
        <p><strong>Data available:</strong> {{ coverage[provider] }}</p>
        <p><strong>Setup and access:</strong> {{ permissions[provider] }}. {{ provider === 'hostinger' ? 'Review discovered renewals in Hostinger subscriptions below.' : '' }}</p>
        <details class="connection-editor"><summary>{{ statuses?.[provider].configured ? 'Replace credentials' : 'Connect account' }}</summary>
          <form autocomplete="off" @submit.prevent="save(provider)"><fieldset :disabled="loading || !!busy || !statuses || !!error">
            <template v-if="provider === 'aws'"><label :for="`${provider}-key`">Access key ID<input :id="`${provider}-key`" v-model="drafts.aws.accessKeyId" type="password" autocomplete="off" required maxlength="256" /></label><label :for="`${provider}-secret`">Secret access key<input :id="`${provider}-secret`" v-model="drafts.aws.secretAccessKey" type="password" autocomplete="off" required maxlength="4096" /></label><label :for="`${provider}-session`">Session token (optional)<input :id="`${provider}-session`" v-model="drafts.aws.sessionToken" type="password" autocomplete="off" maxlength="4096" /></label></template>
            <template v-else-if="provider === 'cloudflare'"><label :for="`${provider}-account`">Account ID<input :id="`${provider}-account`" v-model="drafts.cloudflare.accountId" type="password" autocomplete="off" required maxlength="128" /></label><label :for="`${provider}-token`">API token<input :id="`${provider}-token`" v-model="drafts.cloudflare.apiToken" type="password" autocomplete="off" required maxlength="4096" /></label></template>
            <template v-else-if="provider === 'openai'"><p class="metric-note">This key can read organization administration data. It is not a standard project API key. ChatGPT Plus is not included; add it separately as a manual subscription if needed.</p><label :for="`${provider}-key`">Organization Admin API key<input :id="`${provider}-key`" v-model="drafts.openai.adminApiKey" type="password" autocomplete="off" required maxlength="4096" /></label></template>
            <label v-else :for="`${provider}-token`">API token<input :id="`${provider}-token`" v-model="drafts.hostinger.apiToken" type="password" autocomplete="off" required maxlength="4096" /></label>
            <button type="submit" class="primary-button">{{ busy === provider ? 'Saving…' : `Save ${names[provider]} connection` }}</button>
          </fieldset></form>
        </details>
        <button v-if="statuses?.[provider].configured" class="text-button delete-button" type="button" :disabled="loading || !!busy || !!error" @click="disconnect(provider)">Disconnect {{ names[provider] }}</button>
        <p v-if="syncState[provider] === 'failed'" class="error-message" role="status">{{ syncError[provider] }}</p>
        <button v-if="syncState[provider] === 'failed'" class="secondary-button" type="button" :disabled="loading || !!busy" @click="retrySync(provider)">{{ busy === provider ? 'Retrying…' : `Retry ${names[provider]} sync` }}</button>
        <p v-if="syncState[provider] === 'synced'" class="connection-next-step">{{ provider === 'hostinger' ? 'Next: review eligible fixed renewals in Hostinger subscriptions below.' : 'Next: review current charges in Overview and Infrastructure.' }}</p>
        <p v-else-if="statuses?.[provider].configured" class="connection-next-step">Next: review saved {{ provider === 'hostinger' ? 'renewals' : 'billing data' }} in Overview.</p>
        <p v-if="lastRefresh(provider)" class="metric-note">Last billing sync · {{ formatTime(lastRefresh(provider)!) }}</p>
        <p v-if="!lastRefresh(provider) && refreshStatus(provider) === 'error'" class="metric-note">Last sync failed; previous data is retained.</p>
        <p v-if="lastAttempt(provider) && refreshStatus(provider) === 'error'" class="metric-note">Last sync attempt · {{ formatTime(lastAttempt(provider)!) }}</p>
        <p v-if="!lastRefresh(provider) && refreshStatus(provider) !== 'error' && statuses?.[provider].updatedAt" class="metric-note">Credentials saved · {{ formatTime(statuses[provider].updatedAt!) }}. No successful billing sync yet.</p>
      </article>
    </div>
    <div v-if="visiblePlannedProviders.length" class="connection-grid planned-grid" aria-label="Coming soon providers">
      <article v-for="provider in visiblePlannedProviders" :key="provider.name" class="connection-card coming-soon-card">
        <header><h3>{{ provider.name }}</h3><span class="status-pill planned-pill">Coming soon</span></header>
        <p><strong>Planned data:</strong> {{ provider.coverage }}</p>
        <p><strong>Setup prerequisite:</strong> {{ provider.setup }}</p>
        <p class="metric-note">This provider is not connected and has no active credential or sync controls.</p>
      </article>
    </div>
  </section>
</template>
