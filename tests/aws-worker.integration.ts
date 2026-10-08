import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('AWS SDK signs and parses Cost Explorer requests in workerd with explicit server credentials', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-aws-worker-'))
  const fixture = JSON.parse(await readFile(new URL('./fixtures/aws-worker.wrangler.jsonc', import.meta.url), 'utf8'))
  const configPath = join(directory, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify({ ...fixture, main: fileURLToPath(new URL('./fixtures/aws-worker.ts', import.meta.url)) }))
  const workerProcess = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8798', '--inspector-port', '9238', '--persist-to', join(directory, 'state')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  let output = ''
  workerProcess.stdout.on('data', chunk => { output += chunk })
  workerProcess.stderr.on('data', chunk => { output += chunk })
  try {
    const deadline = Date.now() + 40_000
    while (!output.includes('Ready on')) {
      if (workerProcess.exitCode !== null) throw new Error(`AWS Worker startup failed: ${output}`)
      if (Date.now() > deadline) throw new Error(`AWS Worker startup timed out: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const response = await fetch('http://127.0.0.1:8798/')
    assert.equal(response.status, 200, await response.clone().text())
    const result = await response.json() as {
      missingCredentials: string
      requests: { target: string; signed: boolean; endpoint: string }[]
      snapshots: { provider: string; amount: number; currency: string; kind: string; period: string }[]
    }
    assert.equal(result.missingCredentials, 'Credential is missing')
    assert.deepEqual(result.requests.map(request => request.target), [
      'AWSInsightsIndexService.GetCostAndUsage',
      'AWSInsightsIndexService.GetCostAndUsage',
      'AWSInsightsIndexService.GetCostAndUsage',
      'AWSInsightsIndexService.GetCostForecast',
    ])
    assert.ok(result.requests.every(request => request.signed && request.endpoint === 'ce.us-east-1.amazonaws.com'))
    assert.deepEqual(result.snapshots, [
      { provider: 'aws', amount: 9, currency: 'USD', kind: 'actual', period: 'current' },
      { provider: 'aws', amount: 9, currency: 'USD', kind: 'actual', period: 'previous-comparable' },
      { provider: 'aws', amount: 9, currency: 'USD', kind: 'actual', period: 'previous-month' },
      { provider: 'aws', amount: 19, currency: 'USD', kind: 'forecast', period: 'current' },
    ])
  } finally {
    workerProcess.kill('SIGTERM')
    if (workerProcess.exitCode === null) await once(workerProcess, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
