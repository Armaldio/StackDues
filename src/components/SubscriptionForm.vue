<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { createSubscription, type Subscription } from '../domain/subscriptions'
import type { StoredSubscription, SubscriptionRequestFailure } from '../lib/subscription-api'
const props = defineProps<{ subscription?: StoredSubscription; today: string; saveFailure?: SubscriptionRequestFailure | null; recoveryNotice?: string; reviewRequired?: boolean; canRetry?: boolean; checkingSave?: boolean; saving?: boolean }>()
const emit = defineEmits<{ save: [subscription: Subscription]; checkSave: [subscription: Subscription]; confirmLatest: []; close: [] }>()
const dialog = ref<HTMLDialogElement>()
const errorMessage = ref<HTMLElement>()
const validationError = ref('')
const draft = reactive<Subscription>(props.subscription ? { ...props.subscription } : {
  id: crypto.randomUUID(), name: '', provider: '', billingType: 'fixed', amount: 0,
  currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: props.today, status: 'active',
})
const reviewedLatest = ref(false)
const draftCopy = ref('')
const copied = ref(false)
const latestDifferences = computed(() => {
  const latest = props.subscription
  if (!props.reviewRequired || !latest) return []
  const fields: [keyof Subscription, string][] = [
    ['name', 'Name'], ['provider', 'Provider'], ['amount', 'Amount per charge'], ['currency', 'Currency'],
    ['recurrenceInterval', 'Repeats every'], ['recurrenceUnit', 'Time unit'], ['nextRenewalAt', 'Next renewal date'], ['status', 'Status'],
  ]
  return fields.filter(([field]) => (draft[field] ?? '') !== (latest[field] ?? '')).map(([field, label]) => ({
    label, latest: String(latest[field] ?? 'Not set'), draft: String(draft[field] ?? 'Not set'),
  }))
})
watch(() => [props.subscription?.revision, props.reviewRequired], () => { reviewedLatest.value = false })
watch(() => props.saveFailure?.message, async message => {
  if (message) { await nextTick(); errorMessage.value?.focus() }
})
onMounted(() => dialog.value?.showModal())
function save() {
  if (props.saving || props.saveFailure || !props.canRetry || (props.reviewRequired && !reviewedLatest.value)) return
  try { emit('save', createSubscription({ ...draft, currency: draft.currency.toUpperCase(), provider: draft.provider?.trim() || undefined })) }
  catch (cause) { validationError.value = cause instanceof Error ? cause.message : 'Check the subscription details.' }
}
function reviewLatest() {
  reviewedLatest.value = true
  emit('confirmLatest')
}
function close() {
  if (!props.saving) emit('close')
}
async function preserveDraft() {
  const text = JSON.stringify({
    id: String(draft.id), name: String(draft.name), ...(draft.provider ? { provider: String(draft.provider) } : {}),
    billingType: 'fixed', amount: draft.amount, currency: String(draft.currency),
    recurrenceInterval: draft.recurrenceInterval, recurrenceUnit: draft.recurrenceUnit,
    nextRenewalAt: String(draft.nextRenewalAt), status: String(draft.status),
  }, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    draftCopy.value = ''
  } catch {
    draftCopy.value = text
    await nextTick()
    dialog.value?.querySelector<HTMLTextAreaElement>('[data-draft-copy]')?.select()
  }
}
</script>

<template>
  <dialog ref="dialog" class="subscription-dialog" aria-labelledby="dialog-title" @cancel.prevent="close">
    <form @submit.prevent="save">
      <div class="dialog-header"><div><p class="eyebrow">Fixed subscription</p><h2 id="dialog-title">{{ subscription ? 'Edit subscription' : 'Add a subscription' }}</h2></div><button type="button" class="icon-button" aria-label="Close subscription form" :disabled="saving" @click="close">×</button></div>
      <p class="form-intro">Enter the full amount charged each billing cycle.</p>
      <label for="subscription-name">Name<input id="subscription-name" v-model="draft.name" autofocus required maxlength="120" placeholder="e.g. Bitwarden" /></label>
      <label for="subscription-provider">Provider <span class="muted">(optional)</span><input id="subscription-provider" v-model="draft.provider" maxlength="120" placeholder="e.g. Hostinger" /></label>
      <div class="form-grid"><label for="subscription-amount">Amount per charge<input id="subscription-amount" v-model.number="draft.amount" type="number" required min="0" step="any" inputmode="decimal" /></label><label for="subscription-currency">Currency<input id="subscription-currency" v-model="draft.currency" required pattern="[A-Za-z]{3}" maxlength="3" placeholder="USD" /></label></div>
      <div class="form-grid"><label for="subscription-interval">Repeats every<input id="subscription-interval" v-model.number="draft.recurrenceInterval" type="number" required min="1" step="1" /></label><label for="subscription-unit">Time unit<select id="subscription-unit" v-model="draft.recurrenceUnit" aria-label="Time unit"><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option><option value="year">Years</option></select></label></div>
      <div class="form-grid"><label for="subscription-renewal">Next renewal date<input id="subscription-renewal" v-model="draft.nextRenewalAt" type="date" required max="9999-12-31" /></label><label for="subscription-status">Status<select id="subscription-status" v-model="draft.status" aria-label="Status"><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></label></div>
      <p class="form-note">Pausing or cancelling removes future charges from your totals. This only updates your ledger; it does not cancel the service.</p>
      <p v-if="validationError" class="error-message" role="alert">{{ validationError }}</p>
      <section v-if="saveFailure" ref="errorMessage" class="error-message form-recovery-error" role="alert" tabindex="-1">
        <p>{{ saveFailure.message }}</p>
        <p v-if="saveFailure.kind === 'session'">Sign in in another tab to keep this draft open here.</p>
        <div class="form-recovery-actions">
          <a v-if="saveFailure.kind === 'session'" class="text-button" href="/login" target="_blank" rel="noopener">Sign in in a new tab</a>
          <button type="button" class="secondary-button" :disabled="checkingSave || saving" @click="emit('checkSave', { ...draft })">
            {{ checkingSave ? 'Checking…' : saveFailure.kind === 'conflict' ? 'Reload latest and review' : 'Check save status' }}
          </button>
          <button type="button" class="text-button" @click="preserveDraft">{{ copied ? 'Draft copied' : 'Copy draft' }}</button>
        </div>
      </section>
      <section v-if="reviewRequired && subscription" class="latest-version" aria-labelledby="latest-version-title">
        <h3 id="latest-version-title">Latest saved version · revision {{ subscription.revision }}</h3>
        <p>Your form still contains your draft. Review these differences before choosing which version to save.</p>
        <ul v-if="latestDifferences.length"><li v-for="difference in latestDifferences" :key="difference.label"><strong>{{ difference.label }}:</strong> latest “{{ difference.latest }}”; your draft “{{ difference.draft }}”</li></ul>
        <p v-else>The saved version matches your draft.</p>
        <button type="button" class="secondary-button" :disabled="reviewedLatest" @click="reviewLatest">{{ reviewedLatest ? 'Latest revision reviewed' : 'I reviewed this; save my draft on the latest version' }}</button>
      </section>
      <p v-if="recoveryNotice" class="form-recovery-notice" role="status" aria-live="polite">{{ recoveryNotice }}</p>
      <textarea v-if="draftCopy" data-draft-copy readonly aria-label="Subscription draft to copy" :value="draftCopy"></textarea>
      <div class="dialog-actions"><button type="button" class="secondary-button" :disabled="saving" @click="close">Close</button><button class="primary-button" type="submit" :disabled="saving || !!saveFailure || !canRetry || (reviewRequired && !reviewedLatest)">{{ saving ? 'Saving…' : 'Save subscription' }}</button></div>
    </form>
  </dialog>
</template>
