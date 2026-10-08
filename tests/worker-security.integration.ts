import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

// Exercise the deployed entry and asset routing in real workerd, without credentials.
test('Worker denies app, static assets, API and legacy cost feed before routing', { timeout: 60_000 }, async () => {
  const process = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--local', '--port', '8797', '--inspector-port', '9237'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  process.stdout.on('data', chunk => { output += chunk })
  process.stderr.on('data', chunk => { output += chunk })
  try {
    const deadline = Date.now() + 40_000
    while (!output.includes('Ready on')) {
      if (process.exitCode !== null) throw new Error(`Worker startup failed: ${output}`)
      if (Date.now() > deadline) throw new Error(`Worker startup timed out: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (const path of ['/', '/favicon.svg', '/_nuxt/example.js', '/api/costs', '/data/costs.json']) {
      const response = await fetch(`http://127.0.0.1:8797${path}`)
      assert.equal(response.status, 403, path)
      assert.equal(await response.text(), 'Access denied')
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const forged = await fetch('http://127.0.0.1:8797/api/costs', { headers: { 'Cf-Access-Jwt-Assertion': 'forged', 'Cf-Access-Authenticated-User-Email': 'owner@example.com' } })
    assert.equal(forged.status, 403)
  } finally {
    process.kill('SIGTERM')
    if (process.exitCode === null) await once(process, 'exit')
  }
})
