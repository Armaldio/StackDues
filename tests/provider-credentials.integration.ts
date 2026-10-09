import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const key = 'a'.repeat(64)
const aws = { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'TESTFAKESECRETNOTREAL', sessionToken: 'TESTSESSIONTOKEN' }
const cf = { accountId: 'a'.repeat(32), apiToken: 'TESTCLOUDFLARETOKEN' }
test('credential encryption, guarded writes and failure handling run in real workerd D1', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-credentials-'))
  const fixture = JSON.parse(await readFile(new URL('./fixtures/credentials-worker.wrangler.jsonc', import.meta.url), 'utf8'))
  const configPath = join(directory, 'wrangler.jsonc')
  await writeFile(configPath, JSON.stringify({ ...fixture, main: fileURLToPath(new URL('./fixtures/credentials-worker.ts', import.meta.url)) }))
  const worker = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8794', '--inspector-port', '9234', '--persist-to', join(directory, 'state')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''
  worker.stdout.on('data', chunk => { output += chunk }); worker.stderr.on('data', chunk => { output += chunk })
  async function call(action: string, input: Record<string, unknown> = {}, status = 200) {
    const response = await fetch('http://127.0.0.1:8794/', { method: 'POST', body: JSON.stringify({ action, ...input }) })
    const result = await response.json() as any
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  try {
    const deadline = Date.now() + 40_000
    while (!output.includes('Ready on')) { if (worker.exitCode !== null || output.includes('Build failed') || Date.now() > deadline) throw new Error(`Credentials Worker startup failed: ${output}`); await new Promise(resolve => setTimeout(resolve, 100)) }
    await t.test('missing storage fails closed and absent credentials require no encryption key', async () => {
      await call('load', { provider: 'aws' }, 503)
      await call('initialize')
      assert.equal(await call('load', { provider: 'aws' }), null)
      assert.deepEqual(await call('list'), { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 } })
    })
    await t.test('only ciphertext reaches D1 while status responses never include secrets', async () => {
      const saved = await call('save', { provider: 'aws', credentials: aws, revision: 0, key })
      assert.equal(saved.configured, true); assert.equal(saved.revision, 1)
      assert.deepEqual(await call('load', { provider: 'aws', key }), aws)
      const row = await call('inspect', { provider: 'aws' })
      assert.match(row.iv, /^[a-f\d]{24}$/); assert.match(row.ciphertext, /^[a-f\d]+$/)
      for (const secret of Object.values(aws)) { assert.ok(!JSON.stringify(row).includes(secret)); assert.ok(!JSON.stringify(await call('list')).includes(secret)) }
      await call('save', { provider: 'aws', credentials: aws, revision: 0, key }, 409)
      await call('save', { provider: 'aws', credentials: aws, revision: 1, key })
      const again = await call('inspect', { provider: 'aws' })
      assert.notEqual(again.iv, row.iv); assert.notEqual(again.ciphertext, row.ciphertext)
      await call('sql', { sql: `INSERT INTO cost_observations (id, provider, period_start, period_end, amount, currency, kind, captured_at, metadata_json) VALUES ('aws:legacy', 'aws', '2026-10-01', '2026-11-01', 1, 'USD', 'actual', '2026-10-08T12:00:00.000Z', '{"period":"current"}'); INSERT INTO provider_sync_status (provider, status, last_attempt_at, last_synced_at) VALUES ('aws', 'synced', '2026-10-08T12:00:00.000Z', '2026-10-08T12:00:00.000Z');` })
      await call('extend')
      assert.deepEqual(await call('load', { provider: 'aws', key }), aws, 'schema migration preserves existing encrypted provider data')
      const migratedFeed = await call('costs')
      assert.equal(migratedFeed.snapshots[0]?.id, 'aws:legacy', 'schema migration preserves immutable provider history')
      assert.equal(migratedFeed.providers.aws.status, 'synced')
      const openai = { adminApiKey: 'TEST_OPENAI_ADMIN_KEY' }
      await call('save', { provider: 'openai', credentials: openai, revision: 0, key })
      assert.deepEqual(await call('load', { provider: 'openai', key }), openai)
      assert.equal((await call('list')).openai.configured, true)
      const openaiRow = await call('inspect', { provider: 'openai' })
      assert.ok(!JSON.stringify(openaiRow).includes(openai.adminApiKey))
      assert.ok(!JSON.stringify(await call('list')).includes(openai.adminApiKey))
    })
    await t.test('wrong, malformed and missing keys fail without destroying saved credentials', async () => {
      for (const invalid of [undefined, '', 'short', 'g'.repeat(64), 'b'.repeat(64)]) {
        const error = await call('load', { provider: 'aws', key: invalid }, 503)
        assert.ok(!JSON.stringify(error).includes(aws.secretAccessKey))
      }
      await call('save', { provider: 'aws', credentials: aws, revision: 2 }, 503)
      await call('save', { provider: 'aws', credentials: { ...aws, secretAccessKey: '' }, revision: 2, key }, 400)
      assert.equal((await call('list')).aws.revision, 2)
      assert.deepEqual(await call('load', { provider: 'aws', key }), aws)
    })
    await t.test('concurrent saves cannot overwrite each other with the same revision', async () => {
      const results = await Promise.all([1, 2].map(number => fetch('http://127.0.0.1:8794/', { method: 'POST', body: JSON.stringify({ action: 'save', provider: 'aws', credentials: { ...aws, secretAccessKey: `TESTSECRET${number}` }, revision: 2, key }) })))
      assert.deepEqual(results.map(result => result.status).sort(), [200, 409])
      assert.equal((await call('list')).aws.revision, 3)
    })
    await t.test('disconnect clears material and retained revisions prevent stale reconnect overwrites', async () => {
      await call('remove', { provider: 'aws', revision: 2 }, 409)
      const removed = await call('remove', { provider: 'aws', revision: 3 })
      assert.equal(removed.configured, false); assert.equal(removed.revision, 4)
      const row = await call('inspect', { provider: 'aws' })
      assert.equal(row.ciphertext, null); assert.equal(row.iv, null)
      assert.equal(await call('load', { provider: 'aws' }), null)
      await call('save', { provider: 'aws', credentials: aws, revision: 0, key }, 409)
      await call('save', { provider: 'aws', credentials: aws, revision: 4, key })
      await call('save', { provider: 'aws', credentials: aws, revision: 1, key }, 409)
      await call('remove', { provider: 'aws', revision: 3 }, 409)
      assert.equal((await call('list')).aws.revision, 5)
    })
    await t.test('AES-GCM detects modified ciphertext and binds it to its provider', async () => {
      await call('save', { provider: 'cloudflare', credentials: cf, revision: 0, key })
      const awsRow = await call('inspect', { provider: 'aws' }), cfRow = await call('inspect', { provider: 'cloudflare' })
      const modified = (awsRow.ciphertext[0] === 'a' ? 'b' : 'a') + awsRow.ciphertext.slice(1)
      await call('sql', { sql: `UPDATE provider_credentials SET ciphertext = '${modified}' WHERE provider = 'aws';` })
      await call('load', { provider: 'aws', key }, 503)
      await call('sql', { sql: `UPDATE provider_credentials SET ciphertext = '${awsRow.ciphertext}' WHERE provider = 'aws';` })
      await call('sql', { sql: `UPDATE provider_credentials SET ciphertext = '${awsRow.ciphertext}', iv = '${awsRow.iv}' WHERE provider = 'cloudflare';` })
      await call('load', { provider: 'cloudflare', key }, 503)
      await call('sql', { sql: `UPDATE provider_credentials SET ciphertext = '${cfRow.ciphertext}', iv = '${cfRow.iv}' WHERE provider = 'cloudflare';` })
      assert.deepEqual(await call('load', { provider: 'cloudflare', key }), cf)
    })
    await t.test('failed database writes preserve the previous encrypted value and revision', async () => {
      const before = await call('inspect', { provider: 'aws' })
      await call('sql', { sql: "CREATE TRIGGER fail_credentials BEFORE UPDATE ON provider_credentials WHEN NEW.provider = 'aws' BEGIN SELECT RAISE(ABORT, 'private test error'); END;" })
      const failure = await call('save', { provider: 'aws', credentials: aws, revision: 5, key }, 503)
      assert.ok(!failure.message.includes('private test error'))
      assert.deepEqual(await call('inspect', { provider: 'aws' }), before)
      await call('sql', { sql: 'DROP TRIGGER fail_credentials;' })
      const hostinger = { apiToken: 'TESTHOSTINGERTOKEN' }
      await call('save', { provider: 'hostinger', credentials: hostinger, revision: 0, key })
      assert.deepEqual(await call('load', { provider: 'hostinger', key }), hostinger)
    })
  } finally { worker.kill('SIGTERM'); if (worker.exitCode === null) await once(worker, 'exit'); await rm(directory, { recursive: true, force: true }) }
})
