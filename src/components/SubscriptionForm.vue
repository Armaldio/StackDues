<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { createSubscription, type Subscription } from '../domain/subscriptions'
const props = defineProps<{ subscription?: Subscription; today: string; saveError?: string | null }>()
const emit = defineEmits<{ save: [subscription: Subscription]; close: [] }>()
const dialog = ref<HTMLDialogElement>()
const error = ref('')
const draft = reactive<Subscription>(props.subscription ? { ...props.subscription } : {
  id: crypto.randomUUID(), name: '', provider: '', billingType: 'fixed', amount: 0,
  currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'month', nextRenewalAt: props.today, status: 'active',
})
onMounted(() => dialog.value?.showModal())
function save() {
  try { emit('save', createSubscription({ ...draft, currency: draft.currency.toUpperCase(), provider: draft.provider?.trim() || undefined })) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Check the subscription details.' }
}
</script>

<template>
  <dialog ref="dialog" class="subscription-dialog" aria-labelledby="dialog-title" @cancel.prevent="emit('close')">
    <form @submit.prevent="save">
      <div class="dialog-header"><div><p class="eyebrow">Fixed subscription</p><h2 id="dialog-title">{{ subscription ? 'Edit subscription' : 'Add a subscription' }}</h2></div><button type="button" class="icon-button" aria-label="Close subscription form" @click="emit('close')">×</button></div>
      <p class="form-intro">Enter the full amount charged each billing cycle.</p>
      <label for="subscription-name">Name<input id="subscription-name" v-model="draft.name" autofocus required maxlength="120" placeholder="e.g. Bitwarden" /></label>
      <label for="subscription-provider">Provider <span class="muted">(optional)</span><input id="subscription-provider" v-model="draft.provider" maxlength="120" placeholder="e.g. Hostinger" /></label>
      <div class="form-grid"><label for="subscription-amount">Amount per charge<input id="subscription-amount" v-model.number="draft.amount" type="number" required min="0" step="any" inputmode="decimal" /></label><label for="subscription-currency">Currency<input id="subscription-currency" v-model="draft.currency" required pattern="[A-Za-z]{3}" maxlength="3" placeholder="USD" /></label></div>
      <div class="form-grid"><label for="subscription-interval">Repeats every<input id="subscription-interval" v-model.number="draft.recurrenceInterval" type="number" required min="1" step="1" /></label><label for="subscription-unit">Time unit<select id="subscription-unit" v-model="draft.recurrenceUnit" aria-label="Time unit"><option value="day">Days</option><option value="week">Weeks</option><option value="month">Months</option><option value="year">Years</option></select></label></div>
      <div class="form-grid"><label for="subscription-renewal">Next renewal date<input id="subscription-renewal" v-model="draft.nextRenewalAt" type="date" required max="9999-12-31" /></label><label for="subscription-status">Status<select id="subscription-status" v-model="draft.status" aria-label="Status"><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select></label></div>
      <p class="form-note">Pausing or cancelling removes future charges from your totals. This only updates your ledger; it does not cancel the service.</p>
      <p v-if="error" class="error-message" role="alert">{{ error }}</p>
      <p v-if="saveError" class="error-message" role="alert">{{ saveError }}</p>
      <div class="dialog-actions"><button type="button" class="secondary-button" @click="emit('close')">Close</button><button class="primary-button" type="submit">Save subscription</button></div>
    </form>
  </dialog>
</template>
