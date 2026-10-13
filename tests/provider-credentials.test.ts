import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCredentialProvider, validateProviderCredentials } from '../server/security/provider-credentials.ts'
import { LedgerError } from '../server/data/ledger.ts'

test('credentials accept only explicit bounded provider-specific fields', () => {
  assert.deepEqual(validateProviderCredentials('aws', { accessKeyId: ' TESTACCESSKEY ', secretAccessKey: 'test-secret', sessionToken: 'test-session' }), { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'test-secret', sessionToken: 'test-session' })
  assert.deepEqual(validateProviderCredentials('cloudflare', { accountId: 'a'.repeat(32), apiToken: 'test-token' }), { accountId: 'a'.repeat(32), apiToken: 'test-token' })
  assert.deepEqual(validateProviderCredentials('hostinger', { apiToken: 'test-token' }), { apiToken: 'test-token' })
  assert.deepEqual(validateProviderCredentials('openai', { adminApiKey: 'test-openai-admin-key' }), { adminApiKey: 'test-openai-admin-key' })
  assert.deepEqual(validateProviderCredentials('digitalocean', { apiToken: 'test-digitalocean-token' }), { apiToken: 'test-digitalocean-token' })
  assert.deepEqual(validateProviderCredentials('supabase', { apiToken: 'scoped-test-token', organizationSlug: 'team-stackdues' }), { apiToken: 'scoped-test-token', organizationSlug: 'team-stackdues' })
  for (const input of [null, [], {}, { accessKeyId: 'x', secretAccessKey: '' }, { accessKeyId: 'x', secretAccessKey: 'x\nprivate' }, { accessKeyId: 'x', secretAccessKey: 'x'.repeat(4097) }, { accessKeyId: 'x', secretAccessKey: 'x', unexpected: 'never-leak' }]) {
    assert.throws(() => validateProviderCredentials('aws', input), error => error instanceof LedgerError && error.statusCode === 400 && !error.message.includes('never-leak'))
  }
  assert.throws(() => validateProviderCredentials('cloudflare', { accountId: 'invalid', apiToken: 'never-leak' }), LedgerError)
  assert.throws(() => validateProviderCredentials('openai', { adminApiKey: '' }), LedgerError)
  assert.throws(() => validateProviderCredentials('supabase', { apiToken: 'never-leak', organizationSlug: 'bad/org' }), error => error instanceof LedgerError && !error.message.includes('never-leak'))
  assert.throws(() => validateCredentialProvider('unsupported'), LedgerError)
})
