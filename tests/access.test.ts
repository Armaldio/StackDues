import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { verifyAccessToken } from '../server/security/access.ts'

const now = new Date('2026-10-08T12:00:00Z')
const seconds = Math.floor(now.getTime() / 1000)
const config = {
  teamDomain: 'https://stackdues.cloudflareaccess.com',
  audience: 'a'.repeat(64),
  ownerEmail: 'owner@example.com',
}
const { privateKey, publicKey } = await generateKeyPair('RS256')
const jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'access-key', alg: 'RS256' }] })
const options = { jwks, now }

async function signed(claims: JWTPayload = {}) {
  return new SignJWT({
    iss: config.teamDomain, aud: [config.audience], email: config.ownerEmail,
    exp: seconds + 60, nbf: seconds - 60, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'access-key' }).sign(privateKey)
}

test('accepts a signed current Access token for the configured owner and application', async () => {
  assert.deepEqual(await verifyAccessToken(await signed(), config, options), { email: config.ownerEmail })
  assert.deepEqual(await verifyAccessToken(await signed({ aud: config.audience }), config, options), { email: config.ownerEmail })
})

test('denies absent and malformed tokens', async () => {
  for (const token of [null, undefined, '', 'invalid.jwt.token', 'not a JWT']) {
    assert.equal(await verifyAccessToken(token, config, options), null)
  }
})

test('denies expired, not-yet-valid and missing-expiry tokens', async () => {
  for (const claims of [{ exp: seconds }, { nbf: seconds + 60 }, { exp: undefined }]) {
    assert.equal(await verifyAccessToken(await signed(claims), config, options), null)
  }
})

test('denies tokens issued by another team or for another application', async () => {
  for (const claims of [
    { iss: 'https://another.cloudflareaccess.com' },
    { aud: 'b'.repeat(64) },
    { aud: `${config.audience}-suffix` },
    { aud: [config.audience, 'b'.repeat(64)] },
  ]) {
    assert.equal(await verifyAccessToken(await signed(claims), config, options), null)
  }
})

test('denies validly signed tokens without the exact owner email', async () => {
  for (const email of ['stranger@example.com', 'Owner@example.com', undefined, [config.ownerEmail]]) {
    assert.equal(await verifyAccessToken(await signed({ email }), config, options), null)
  }
})

test('denies a forged owner claim even when the original token was signed', async () => {
  const token = await signed({ email: 'stranger@example.com' })
  const [header, , signature] = token.split('.')
  const claims = Buffer.from(JSON.stringify({
    iss: config.teamDomain, aud: [config.audience], email: config.ownerEmail, exp: seconds + 60,
  })).toString('base64url')
  assert.equal(await verifyAccessToken(`${header}.${claims}.${signature}`, config, options), null)
})

test('denies unsigned tokens and tokens signed by an untrusted key', async () => {
  const payload = Buffer.from(JSON.stringify({
    iss: config.teamDomain, aud: [config.audience], email: config.ownerEmail, exp: seconds + 60,
  })).toString('base64url')
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
  assert.equal(await verifyAccessToken(`${header}.${payload}.`, config, options), null)
  const attacker = await generateKeyPair('RS256')
  const token = await new SignJWT({
    iss: config.teamDomain, aud: [config.audience], email: config.ownerEmail, exp: seconds + 60,
  }).setProtectedHeader({ alg: 'RS256', kid: 'access-key' }).sign(attacker.privateKey)
  assert.equal(await verifyAccessToken(token, config, options), null)
  const symmetricToken = await new SignJWT({
    iss: config.teamDomain, aud: [config.audience], email: config.ownerEmail, exp: seconds + 60,
  }).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32))
  assert.equal(await verifyAccessToken(symmetricToken, config, options), null)
})

test('fails closed before looking up keys when configuration is absent or malformed', async () => {
  let lookups = 0
  const noLookup = { now, jwks: async () => { lookups++; throw new Error('must not fetch') } }
  const token = await signed()
  for (const invalid of [
    undefined, {}, { ...config, teamDomain: undefined }, { ...config, audience: undefined },
    { ...config, ownerEmail: undefined }, { ...config, teamDomain: 'http://stackdues.cloudflareaccess.com' },
    { ...config, teamDomain: 'https://stackdues.cloudflareaccess.com.attacker.example' },
    { ...config, teamDomain: 'https://stackdues.cloudflareaccess.com/path' },
    { ...config, teamDomain: 'https://user@stackdues.cloudflareaccess.com' },
    { ...config, audience: ' ' }, { ...config, ownerEmail: 'owner@example.com,attacker@example.com' },
  ]) {
    assert.equal(await verifyAccessToken(token, invalid, noLookup), null)
  }
  assert.equal(lookups, 0)
})

test('denies requests when key retrieval fails without exposing the upstream error', async () => {
  assert.equal(await verifyAccessToken(await signed(), config, {
    now, jwks: async () => { throw new Error('private upstream details') },
  }), null)
})
