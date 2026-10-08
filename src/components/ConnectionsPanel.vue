<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { ConnectionApiError, deleteConnection, fetchConnections, refreshProviders, saveConnection, type ConnectionProvider, type ConnectionStatuses, type ProviderCredentials } from '../lib/connection-api'
import { syncHostinger } from '../lib/hostinger-api'
const emit = defineEmits<{ changed: []; loaded: [statuses: ConnectionStatuses] }>()
const providers: ConnectionProvider[] = ['aws', 'cloudflare', 'hostinger']
const names = { aws: 'Amazon Web Services', cloudflare: 'Cloudflare', hostinger: 'Hostinger' }
const statuses = ref<ConnectionStatuses>()
const loading = ref(false)
const busy = ref<ConnectionProvider>()
const error = ref('')
const expired = ref(false)
const notice = ref('')
const syncState = reactive<Record<ConnectionProvider, 'idle' | 'syncing' | 'synced' | 'failed'>>({ aws: 'idle', cloudflare: 'idle', hostinger: 'idle' })
const syncError = reactive<Record<ConnectionProvider, string>>({ aws: '', cloudflare: '', hostinger: '' })
const drafts = reactive<ProviderCredentials>({ aws: { accessKeyId: '', secretAccessKey: '', sessionToken: '' }, cloudflare: { accountId: '', apiToken: '' }, hostinger: { apiToken: '' } })
function clear(provider: ConnectionProvider) {
  if (provider === 'aws') { drafts.aws.accessKeyId = ''; drafts.aws.secretAccessKey = ''; drafts.aws.sessionToken = '' }
  else if (provider === 'cloudflare') { drafts.cloudflare.accountId = ''; drafts.cloudflare.apiToken = '' }
  else drafts.hostinger.apiToken = ''
}
function fail(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'The request failed. Reload connections before trying again.'; expired.value = cause instanceof ConnectionApiError && cause.status === 401 }
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
    const credentials = provider === 'aws' ? { accessKeyId: drafts.aws.accessKeyId.trim(), secretAccessKey: drafts.aws.secretAccessKey.trim(), ...(drafts.aws.sessionToken?.trim() ? { sessionToken: drafts.aws.sessionToken.trim() } : {}) } : provider === 'cloudflare' ? { accountId: drafts.cloudflare.accountId.trim(), apiToken: drafts.cloudflare.apiToken.trim() } : { apiToken: drafts.hostinger.apiToken.trim() }
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
    <div class="connection-grid">
      <article v-for="provider in providers" :key="provider" class="connection-card">
        <header><h3>{{ names[provider] }}</h3><span class="status-pill">{{ busy === provider && syncState[provider] === 'idle' ? 'Connecting…' : syncState[provider] === 'syncing' ? 'Syncing…' : syncState[provider] === 'failed' ? 'Sync failed' : syncState[provider] === 'synced' ? 'Synced' : statuses ? statuses[provider].configured ? 'Credentials saved' : 'Not configured' : loading ? 'Loading…' : 'Unavailable' }}</span></header>
        <p v-if="provider === 'aws'">Use an AWS key with read-only Cost Explorer access.</p><p v-else-if="provider === 'cloudflare'">Use a Cloudflare token with account billing read access.</p><p v-else>Hostinger API tokens inherit your account permissions; StackDues only reads the subscription list. Review discovered renewals in Hostinger subscriptions below.</p>
        <details class="connection-editor"><summary>{{ statuses?.[provider].configured ? 'Replace credentials' : 'Connect account' }}</summary>
          <form autocomplete="off" @submit.prevent="save(provider)"><fieldset :disabled="loading || !!busy || !statuses || !!error">
            <template v-if="provider === 'aws'"><label :for="`${provider}-key`">Access key ID<input :id="`${provider}-key`" v-model="drafts.aws.accessKeyId" type="password" autocomplete="off" required maxlength="256" /></label><label :for="`${provider}-secret`">Secret access key<input :id="`${provider}-secret`" v-model="drafts.aws.secretAccessKey" type="password" autocomplete="off" required maxlength="4096" /></label><label :for="`${provider}-session`">Session token (optional)<input :id="`${provider}-session`" v-model="drafts.aws.sessionToken" type="password" autocomplete="off" maxlength="4096" /></label></template>
            <template v-else-if="provider === 'cloudflare'"><label :for="`${provider}-account`">Account ID<input :id="`${provider}-account`" v-model="drafts.cloudflare.accountId" type="password" autocomplete="off" required maxlength="128" /></label><label :for="`${provider}-token`">API token<input :id="`${provider}-token`" v-model="drafts.cloudflare.apiToken" type="password" autocomplete="off" required maxlength="4096" /></label></template>
            <label v-else :for="`${provider}-token`">API token<input :id="`${provider}-token`" v-model="drafts.hostinger.apiToken" type="password" autocomplete="off" required maxlength="4096" /></label>
            <button type="submit" class="primary-button">{{ busy === provider ? 'Saving…' : `Save ${names[provider]} connection` }}</button>
          </fieldset></form>
        </details>
        <button v-if="statuses?.[provider].configured" class="text-button delete-button" type="button" :disabled="loading || !!busy || !!error" @click="disconnect(provider)">Disconnect {{ names[provider] }}</button>
        <p v-if="syncState[provider] === 'failed'" class="error-message" role="status">{{ syncError[provider] }}</p>
        <button v-if="syncState[provider] === 'failed'" class="secondary-button" type="button" :disabled="loading || !!busy" @click="retrySync(provider)">{{ busy === provider ? 'Retrying…' : `Retry ${names[provider]} sync` }}</button>
        <p v-if="syncState[provider] === 'synced'" class="connection-next-step">{{ provider === 'hostinger' ? 'Next: review eligible fixed renewals in Hostinger subscriptions below.' : 'Next: review current charges in Overview and Infrastructure.' }}</p>
        <p v-else-if="statuses?.[provider].configured" class="connection-next-step">Next: review saved {{ provider === 'hostinger' ? 'renewals' : 'billing data' }} in Overview.</p>
        <p v-if="statuses?.[provider].updatedAt" class="metric-note">Updated {{ new Date(statuses[provider].updatedAt!).toLocaleString() }}</p>
      </article>
    </div>
  </section>
</template>
