import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAuthenticationBoundary } from '../scripts/production-smoke.mjs'

test('production auth smoke checks require the login redirect and anonymous API denials', async () => {
  const paths: string[] = []
  const fetchImpl = async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    paths.push(url.pathname)

    if (url.pathname === '/') return new Response(null, { status: 303, headers: { location: '/login' } })
    if (url.pathname === '/login') return new Response('login page', { status: 200 })
    return new Response(null, { status: 401 })
  }

  await verifyAuthenticationBoundary('https://dues.armaldio.xyz', {
    fetchImpl,
    attempts: 1,
    delayMs: 0,
  })

  assert.deepEqual(paths, ['/', '/login', '/api/costs', '/api/subscriptions'])
})

test('production auth smoke checks reject a leaked private API response without logging its body', async () => {
  let attempts = 0
  const fetchImpl = async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    attempts += 1
    if (url.pathname === '/') return new Response(null, { status: 302, headers: { location: '/login' } })
    if (url.pathname === '/login') return new Response('login page', { status: 200 })
    return new Response('private billing payload', { status: 200 })
  }

  await assert.rejects(
    verifyAuthenticationBoundary('https://dues.armaldio.xyz', {
      fetchImpl,
      attempts: 2,
      delayMs: 0,
    }),
    (error: Error) => {
      assert.match(error.message, /GET \/api\/costs did not pass after 2 attempts \(HTTP 200\)/)
      assert.doesNotMatch(error.message, /private billing payload/)
      return true
    },
  )
  assert.equal(attempts, 4)
})

test('production auth smoke checks reject redirects to a different origin', async () => {
  const fetchImpl = async (input: URL | RequestInfo) => {
    const url = new URL(String(input))
    if (url.pathname === '/') return new Response(null, { status: 302, headers: { location: 'https://evil.example/login' } })
    return new Response(null, { status: 200 })
  }

  await assert.rejects(
    verifyAuthenticationBoundary('https://dues.armaldio.xyz', {
      fetchImpl,
      attempts: 1,
      delayMs: 0,
    }),
    /GET \/ redirect did not pass after 1 attempts \(HTTP 302\)/,
  )
})
