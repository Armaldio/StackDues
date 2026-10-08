<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { createSubscription, normalizedTotals, type Subscription } from '../domain/subscriptions'
import { STORAGE_KEY } from '../lib/subscription-storage'
import type { ImportResult } from '../lib/subscription-api'
const props = defineProps<{ disabled: boolean; existingSubscriptions: Subscription[]; importSubscriptions: (records: Subscription[]) => Promise<ImportResult> }>()
const raw = ref('')
const localRaw = ref<string | null>(null)
const records = ref<Subscription[]>([])
const previewed = ref(false)
const backedUp = ref(false)
const error = ref('')
const success = ref('')
const verifiedRecords = ref<Subscription[]>([])
const importing = ref(false)
const keptCount = computed(() => records.value.filter(record => props.existingSubscriptions.some(existing => existing.id === record.id)).length)
watch(raw, () => { records.value = []; previewed.value = false; backedUp.value = false; error.value = ''; success.value = ''; verifiedRecords.value = [] })
onMounted(() => { try { localRaw.value = window.localStorage.getItem(STORAGE_KEY) } catch { /* File and paste imports remain available when browser storage is inaccessible. */ } })
function preview() {
  try {
    if (new TextEncoder().encode(raw.value).length > 1_048_576) throw new Error('Use a ledger export smaller than 1 MB.')
    const data: unknown = JSON.parse(raw.value)
    if (!Array.isArray(data)) throw new Error('The export must contain an array of subscriptions.')
    if (data.length > 1_000) throw new Error('Import at most 1,000 subscriptions at a time.')
    const validated = data.map(record => createSubscription(record as Subscription))
    if (new Set(validated.map(({ id }) => id)).size !== validated.length) throw new Error('The export contains duplicate subscription IDs.')
    normalizedTotals(validated)
    records.value = validated; previewed.value = true; error.value = ''
  } catch (cause) { records.value = []; previewed.value = false; error.value = cause instanceof Error ? cause.message : 'The export could not be read.' }
}
async function selectFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 1_048_576) { error.value = 'Use a ledger export smaller than 1 MB.'; return }
  try { raw.value = await file.text() } catch { error.value = 'The selected file could not be read.' }
}
function backup() {
  const url = URL.createObjectURL(new Blob([raw.value], { type: 'application/json' }))
  const link = document.createElement('a'); link.href = url; link.download = 'ledger-subscriptions-original-backup.json'; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
  backedUp.value = true
}
async function importLedger() {
  if (props.disabled || importing.value || !backedUp.value || !previewed.value || !records.value.length) return
  importing.value = true; error.value = ''
  try {
    const result = await props.importSubscriptions(records.value)
    verifiedRecords.value = result.subscriptions.filter(record => records.value.some(imported => imported.id === record.id))
    success.value = `${result.createdIds.length} subscriptions imported and verified. Existing IDs were kept. Your original browser ledger remains untouched.`
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Import failed. Keep your backup and reload before trying again.' }
  finally { importing.value = false }
}
</script>

<template>
  <details class="legacy-import">
    <summary>Import an existing browser ledger</summary>
    <p>Import is optional. Preview your JSON export and download its original backup before adding it to your private account. Existing subscription IDs are kept without being overwritten.</p>
    <p v-if="localRaw !== null">A saved ledger is available in this browser. <button class="text-button" type="button" :disabled="importing" @click="raw = localRaw!">Use this browser’s ledger</button></p>
    <p>The previous StackDues V1 browser app used a different website, so its saved data cannot be read here directly. Visit the <a href="https://armaldio.github.io/billing/" target="_blank" rel="noopener noreferrer">legacy StackDues V1 site</a> (it may show a 404 page), then inspect storage for the <code>https://armaldio.github.io</code> origin and copy the <code>ledger.subscriptions.v1</code> value from your browser’s Developer Tools → Application/Storage → Local Storage. Save that value as a JSON file or paste it below.</p>
    <label for="legacy-file">Choose a JSON export<input id="legacy-file" type="file" accept=".json,application/json" :disabled="importing" @change="selectFile" /></label>
    <label for="legacy-json">Or paste the exported JSON<textarea id="legacy-json" v-model="raw" rows="5" spellcheck="false" :disabled="importing" /></label>
    <button class="secondary-button" type="button" :disabled="!raw.trim() || importing" @click="preview">Preview import</button>
    <div v-if="previewed" class="import-preview">
      <p>{{ records.length }} valid subscriptions. {{ keptCount }} existing IDs will be kept; {{ records.length - keptCount }} new subscriptions will be added.</p>
      <ul><li v-for="record in records" :key="record.id">{{ record.name }} · {{ record.currency }} {{ record.amount }} every {{ record.recurrenceInterval }} {{ record.recurrenceUnit }}{{ record.recurrenceInterval === 1 ? '' : 's' }}</li></ul>
      <div class="import-actions"><button class="secondary-button" type="button" :disabled="importing || !records.length" @click="backup">Download original backup</button><button class="primary-button" type="button" :disabled="disabled || importing || !backedUp || !records.length || !!success" @click="importLedger">{{ importing ? 'Importing…' : 'Import to my account' }}</button></div>
      <p class="metric-note">{{ backedUp ? 'Original backup downloaded. You can now import.' : 'Download the original backup to enable import.' }}</p>
    </div>
    <p v-if="error" class="error-message" role="alert">{{ error }}</p><p v-if="success" role="status">{{ success }}</p><div v-if="success"><p>Verified account records:</p><ul><li v-for="record in verifiedRecords" :key="record.id">{{ record.name }} · {{ record.currency }} {{ record.amount }} every {{ record.recurrenceInterval }} {{ record.recurrenceUnit }}{{ record.recurrenceInterval === 1 ? '' : 's' }}</li></ul></div>
  </details>
</template>
