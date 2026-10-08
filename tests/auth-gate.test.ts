import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authGate, type AuthBindings } from '../worker/auth-gate.ts'

test('auth rate limiting rejects before reading owner credentials from D1', async () => {
  let ownerReads = 0
  const env = {
    DB: { prepare() { ownerReads++; throw new Error('D1 should not be queried') } },
    SESSION_SECRET: 'a'.repeat(64),
    OWNER_EMAIL: 'owner@example.com',
    LOGIN_RATE_LIMIT: { async limit() { return { success: false } } },
  } as unknown as AuthBindings
  const response = await authGate(new Request('https://dues.example/auth/login', {
    method: 'POST',
    headers: { Origin: 'https://dues.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=owner%40example.com&password=guess',
  }), env)
  assert.equal(response?.status, 429)
  assert.equal(ownerReads, 0)
})
