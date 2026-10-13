<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { deleteSupabaseConnection, fetchSupabaseUsage, refreshSupabaseUsage, saveSupabaseConnection, type SupabaseUsageObservation, type SupabaseUsageState } from '../lib/supabase-telemetry-api'

const state = ref<SupabaseUsageState>()
const token = ref('')
const organizationSlug = ref('')
const busy = ref(false)
const error = ref('')
const notice = ref('')
const latestByProject = computed(() => {
  const projects = new Map<string, SupabaseUsageObservation>()
  for (const item of state.value?.observations ?? []) {
    const previous = projects.get(item.projectRef)
    if (!previous || item.observedAt > previous.observedAt) projects.set(item.projectRef, item)
  }
  return [...projects.values()].sort((a, b) => a.projectName.localeCompare(b.projectName))
})
function formatTime(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
async function load() { busy.value = true; try { state.value = await fetchSupabaseUsage(); organizationSlug.value = state.value.observations[0]?.organizationSlug ?? organizationSlug.value; error.value = '' } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Supabase telemetry could not be loaded.' } finally { busy.value = false } }
async function connect() {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const current = state.value ?? await fetchSupabaseUsage()
    const saved = await saveSupabaseConnection({ apiToken: token.value.trim(), organizationSlug: organizationSlug.value.trim() }, current.status.revision)
    token.value = ''
    state.value = { ...current, configured: true, status: saved }
    state.value = await refreshSupabaseUsage()
    notice.value = 'Supabase connected. Request counters are separate from financial totals.'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Supabase could not be connected.' }
  finally { busy.value = false }
}
async function refresh() { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { state.value = await refreshSupabaseUsage(); notice.value = 'Supabase request counters updated.' } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Supabase telemetry refresh failed.' } finally { busy.value = false } }
async function disconnect() {
  if (!state.value || busy.value || !window.confirm('Disconnect Supabase? Stored credentials will be removed. Previous telemetry history is retained.')) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await deleteSupabaseConnection(state.value.status.revision); state.value = await fetchSupabaseUsage(); notice.value = 'Supabase disconnected. Previous telemetry history is retained.' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Supabase could not be disconnected.' }
  finally { busy.value = false }
}
onMounted(() => void load())
</script>

<template>
  <article class="connection-card supabase-telemetry-card">
    <header><h3>Supabase</h3><span class="status-pill">{{ busy ? 'Checking…' : state?.configured ? 'Connected' : state ? 'Not connected' : 'Status unavailable' }}</span></header>
    <p title="Request counts only. No billable amounts are retrieved or calculated."><strong>Data available:</strong> Per-project API request counters reported by Supabase. Telemetry only; no billable amounts.</p>
    <p><strong>Invoices:</strong> Not imported. Supabase invoices are not included in financial totals.</p>
    <p><strong>Access:</strong> Organization-scoped, read-only personal access token.</p>
    <p class="connection-guidance">Create a scoped PAT for the selected organization with only <code>organization_projects_read</code> and <code>analytics_usage_read</code>. Enter the organization slug from Supabase. The token is encrypted on the server and never returned. <a href="https://supabase.com/docs/guides/platform/personal-access-tokens" target="_blank" rel="noopener noreferrer">Scoped PAT permissions</a> · <a href="https://supabase.com/docs/reference/api/v1-get-project-usage-api-count" target="_blank" rel="noopener noreferrer">Request-count API</a></p>
    <template v-if="!state?.configured">
      <form autocomplete="off" @submit.prevent="connect"><fieldset :disabled="busy || !state">
        <label for="supabase-organization">Organization slug<input id="supabase-organization" v-model="organizationSlug" required maxlength="128" autocomplete="off" /></label>
        <label for="supabase-token">Scoped personal access token<input id="supabase-token" v-model="token" type="password" required maxlength="4096" autocomplete="new-password" /></label>
        <button class="primary-button" type="submit">{{ busy ? 'Connecting…' : 'Connect Supabase' }}</button>
      </fieldset></form>
    </template>
    <template v-else>
      <p v-if="latestByProject.length" class="metric-note">Latest daily request-count bucket · {{ formatTime(latestByProject[0]!.observedAt) }}</p>
      <p v-else class="metric-note">Connected. No request-count observations have been returned yet.</p>
      <div v-if="latestByProject.length" class="supabase-project-list" role="list" aria-label="Supabase project request counters">
        <article v-for="project in latestByProject" :key="project.projectRef" role="listitem" class="supabase-project-row">
          <h4>{{ project.projectName }}</h4><p class="metric-note">{{ project.projectRef }} · {{ formatTime(project.observedAt) }}</p>
          <dl aria-label="Request counts only; no billing amounts"><div><dt>Auth requests</dt><dd>{{ project.authRequests.toLocaleString() }}</dd></div><div><dt>Realtime requests</dt><dd>{{ project.realtimeRequests.toLocaleString() }}</dd></div><div><dt>REST requests</dt><dd>{{ project.restRequests.toLocaleString() }}</dd></div><div><dt>Storage requests</dt><dd>{{ project.storageRequests.toLocaleString() }}</dd></div></dl>
        </article>
      </div>
      <div class="provider-refresh-actions"><button class="secondary-button" type="button" :disabled="busy" @click="refresh">{{ busy ? 'Checking…' : 'Check request counts' }}</button><button class="text-button delete-button" type="button" :disabled="busy" @click="disconnect">Disconnect Supabase</button></div>
      <p v-if="state.status.updatedAt" class="metric-note">Credentials saved · {{ formatTime(state.status.updatedAt) }}</p>
    </template>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="notice" class="connection-notice" role="status">{{ notice }}</p>
  </article>
</template>
