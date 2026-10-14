import test from 'node:test'
import assert from 'node:assert/strict'
import { cloudflareCollectionFailureEvent, logCloudflareCollectionFailure } from '../server/providers/cloudflare-diagnostics.ts'

const attemptedAt = '2026-10-14T14:00:00.000Z'

test('Cloudflare collection diagnostics use bounded stages and sanitized failure categories', () => {
  const cases = [
    ['credentials', new Error('Provider credentials are unavailable.'), 'configuration'],
    ['billable_usage', new Error('Cloudflare authorization failed. Check the server token and Billing Read permission.'), 'authorization'],
    ['subscriptions', new Error('Cloudflare request timed out.'), 'timeout'],
    ['subscriptions', new Error('Cloudflare HTTP status 404.'), 'http_404'],
    ['subscriptions', new Error('Cloudflare provider rejected the request.'), 'provider_rejected'],
    ['subscriptions', new Error('Cloudflare returned invalid subscription data.'), 'invalid_response'],
    ['billable_usage', new Error('Cloudflare returned incomplete billing data.'), 'incomplete_response'],
    ['billable_usage', new Error('Cloudflare request failed.'), 'request_failed'],
    ['subscriptions', new Error('Cloudflare configuration is invalid.'), 'configuration'],
    ['billable_usage', new Error('credential=must-not-be-logged'), 'unknown'],
  ] as const

  for (const [stage, error, kind] of cases) {
    const event = cloudflareCollectionFailureEvent(stage, error, attemptedAt)
    assert.deepEqual(event, {
      event: 'cloudflare_collection_failed',
      provider: 'cloudflare',
      stage,
      kind,
      attemptedAt,
    })
    assert.doesNotMatch(JSON.stringify(event), /Provider credentials are unavailable|authorization failed|must-not-be-logged|Bearer/i)
  }
})

test('Cloudflare diagnostic logger emits only the sanitized event', () => {
  let line = ''
  logCloudflareCollectionFailure('subscriptions', new Error('provider body includes private detail'), attemptedAt, value => { line = value })
  assert.deepEqual(JSON.parse(line), {
    event: 'cloudflare_collection_failed',
    provider: 'cloudflare',
    stage: 'subscriptions',
    kind: 'unknown',
    attemptedAt,
  })
  assert.doesNotMatch(line, /provider body includes private detail/)
})
