import { pathToFileURL } from 'node:url'

const productionOrigin = 'https://dues.armaldio.xyz'
const defaultAttempts = 5
const defaultDelayMs = 2_000

async function retryProbe(name, url, isExpected, fetchImpl, attempts, delayMs) {
  let lastResult = 'no response'

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'manual',
        headers: { Accept: url.pathname.startsWith('/api/') ? 'application/json' : 'text/html' },
        signal: AbortSignal.timeout(10_000),
      })
      if (isExpected(response)) return
      lastResult = `HTTP ${response.status}`
    } catch {
      lastResult = 'network error'
    }

    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  throw new Error(`${name} did not pass after ${attempts} attempts (${lastResult})`)
}
export async function verifyAuthenticationBoundary(
  baseUrl = productionOrigin,
  {
    fetchImpl = fetch,
    attempts = defaultAttempts,
    delayMs = defaultDelayMs,
  } = {},
) {
  const origin = new URL(baseUrl)
  const rootUrl = new URL('/', origin)

  await retryProbe(
    'GET / redirect',
    rootUrl,
    (response) => {
      if (![301, 302, 303, 307, 308].includes(response.status)) return false
      const location = response.headers.get('location')
      if (!location) return false
      const destination = new URL(location, rootUrl)
      return destination.origin === origin.origin && destination.pathname === '/login'
    },
    fetchImpl,
    attempts,
    delayMs,
  )

  await retryProbe(
    'GET /login',
    new URL('/login', origin),
    (response) => response.status === 200,
    fetchImpl,
    attempts,
    delayMs,
  )

  for (const path of ['/api/costs', '/api/subscriptions']) {
    await retryProbe(
      `GET ${path}`,
      new URL(path, origin),
      (response) => response.status === 401,
      fetchImpl,
      attempts,
      delayMs,
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyAuthenticationBoundary()
    console.log('Anonymous production auth-boundary smoke tests passed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Anonymous auth-boundary smoke test failed.')
    process.exitCode = 1
  }
}
