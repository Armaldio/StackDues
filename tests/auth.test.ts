import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignJWT } from 'jose'
import { createSession, hashPassword, secureEqual, SESSION_MAX_AGE, verifyPassword, verifySession } from '../server/security/auth.ts'

const password = 'a strong owner password'
const now = new Date('2026-10-08T12:00:00Z')
const passwordHash = await hashPassword(password)
const config = { ownerEmail: 'owner@example.com', passwordHash, sessionSecret: 'a'.repeat(64) }

test('secret comparison accepts exact values and rejects differing lengths or content', async () => {
  assert.equal(await secureEqual('one-time-bootstrap-code', 'one-time-bootstrap-code'), true)
  assert.equal(await secureEqual('one-time-bootstrap-code', 'one-time-bootstrap-codf'), false)
  assert.equal(await secureEqual('short', 'one-time-bootstrap-code'), false)
})

test('salted password hashes verify only the original password', async () => {
  assert.notEqual(await hashPassword(password), passwordHash)
  assert.match(passwordHash, /^pbkdf2-sha256\$100000\$[a-f\d]{32}\$[a-f\d]{64}$/)
  assert.equal(await verifyPassword(password, passwordHash), true)
  assert.equal(await verifyPassword('a different long password', passwordHash), false)
})

test('password creation enforces the 16 to 1024 character bounds', async () => {
  for (const input of ['', 'a'.repeat(15), 'a'.repeat(1025)]) {
    await assert.rejects(hashPassword(input), /Password must contain 16 to 1024 characters/)
    assert.equal(await verifyPassword(input, passwordHash), false)
  }
  const minimum = 'a'.repeat(16)
  assert.equal(await verifyPassword(minimum, await hashPassword(minimum)), true)
  const maximum = 'a'.repeat(1024)
  assert.equal(await verifyPassword(maximum, await hashPassword(maximum)), true)
})

test('malformed hashes fail closed instead of weakening the password derivation', async () => {
  for (const encoded of ['', 'plaintext', passwordHash.replace('$100000$', '$1$'),
    passwordHash.replace('$100000$', '$100001$'), `${passwordHash}$extra`,
    passwordHash.replace('pbkdf2-sha256', 'sha256'), passwordHash.slice(0, -1)]) {
    assert.equal(await verifyPassword(password, encoded), false)
    assert.equal(await createSession({ ...config, passwordHash: encoded }, now), null)
  }
})

test('owner sessions expire after eight hours and return only the owner identity', async () => {
  const token = await createSession(config, now)
  assert.ok(token)
  assert.deepEqual(await verifySession(token, config, now), { email: config.ownerEmail })
  assert.equal(await verifySession(token, config, new Date(now.getTime() + SESSION_MAX_AGE * 1000)), null)
})

test('sessions reject tampering, wrong signing keys and absent tokens', async () => {
  const token = await createSession(config, now)
  assert.ok(token)
  const [header, payload, signature] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
  claims.sub = 'attacker@example.com'
  assert.equal(await verifySession(`${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`, config, now), null)
  assert.equal(await verifySession(token, { ...config, sessionSecret: 'b'.repeat(64) }, now), null)
  for (const missing of [null, undefined, '', 'invalid.token']) assert.equal(await verifySession(missing, config, now), null)
})

test('password rotation revokes earlier sessions even with the same signing secret', async () => {
  const token = await createSession(config, now)
  const rotated = { ...config, passwordHash: await hashPassword('a replacement owner password') }
  assert.equal(await verifySession(token, rotated, now), null)
  assert.deepEqual(await verifySession(await createSession(rotated, now), rotated, now), { email: config.ownerEmail })
})

test('absent or malformed owner credentials prevent session creation and verification', async () => {
  const token = await createSession(config, now)
  for (const invalid of [undefined, {}, { ...config, ownerEmail: undefined }, { ...config, passwordHash: undefined },
    { ...config, sessionSecret: undefined }, { ...config, sessionSecret: 'weak-secret' },
    { ...config, sessionSecret: 'a'.repeat(63) }, { ...config, ownerEmail: 'owner@example.com,attacker@example.com' }]) {
    assert.equal(await createSession(invalid, now), null)
    assert.equal(await verifySession(token, invalid, now), null)
  }
  assert.equal(await createSession(config, new Date('invalid')), null)
  assert.equal(await verifySession(token, config, new Date('invalid')), null)
})

test('signed sessions still require the exact owner, issuer, audience, expiry and credential version', async () => {
  const token = await createSession(config, now)
  assert.ok(token)
  const original = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
  const key = Uint8Array.from(config.sessionSecret.match(/../g)!, byte => parseInt(byte, 16))
  for (const overrides of [{ sub: 'attacker@example.com' }, { iss: 'https://attacker.example' },
    { aud: 'other-app' }, { aud: ['stackdues', 'other-app'] }, { exp: undefined }, { version: undefined },
    { iat: undefined }, { iat: Math.floor(now.getTime() / 1000) + 60 }]) {
    const forged = await new SignJWT({ ...original, ...overrides }).setProtectedHeader({ alg: 'HS256' }).sign(key)
    assert.equal(await verifySession(forged, config, now), null)
  }
})
