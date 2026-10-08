import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCredentialProvider, validateProviderCredentials } from '../server/security/provider-credentials.ts'
import { LedgerError } from '../server/data/ledger.ts'

test('credentials accept only explicit bounded provider-specific fields', () => {
  assert.deepEqual(validateProviderCredentials('aws', { accessKeyId: ' TESTACCESSKEY ', secretAccessKey: 'test-secret', sessionToken: 'test-session' }), { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'test-secret', sessionToken: 'test-session' })
  assert.deepEqual(validateProviderCredentials('cloudflare', { accountId: 'a'.repeat(32), apiToken: 'test-token' }), { accountId: 'a'.repeat(32), apiToken: 'test-token' })
  assert.deepEqual(validateProviderCredentials('hostinger', { apiToken: 'test-token' }), { apiToken: 'test-token' })
  for (const input of [null, [], {}, { accessKeyId: 'x', secretAccessKey: '' }, { accessKeyId: 'x', secretAccessKey: 'x\nprivate' }, { accessKeyId: 'x', secretAccessKey: 'x'.repeat(4097) }, { accessKeyId: 'x', secretAccessKey: 'x', unexpected: 'never-leak' }]) {
    assert.throws(() => validateProviderCredentials('aws', input), error => error instanceof LedgerError && error.statusCode === 400 && !error.message.includes('never-leak'))
  }
  assert.throws(() => validateProviderCredentials('cloudflare', { accountId: 'invalid', apiToken: 'never-leak' }), LedgerError)
  assert.throws(() => validateCredentialProvider('unsupported'), LedgerError)
})
