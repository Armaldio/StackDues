import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('Worker protects app/assets/API and supports single-owner registration, login, logout and CSRF checks', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stackdues-auth-'))
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'))
  delete config.routes; delete config.account_id
  config.main = resolve('worker/index.ts'); config.assets.directory = resolve('.output/public')
  config.d1_databases[0].migrations_dir = resolve('migrations')
  config.vars = { OWNER_EMAIL: 'owner@example.com', SESSION_SECRET: 'a'.repeat(64), SETUP_TOKEN: 'local-test-setup-code', CREDENTIALS_KEY: 'b'.repeat(64) }
  const configPath = join(directory, 'wrangler.jsonc'), statePath = join(directory, 'state')
  await writeFile(configPath, JSON.stringify(config))
  execFileSync('node', ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'stackdues', '--local', '--config', configPath, '--persist-to', statePath], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe' })
  const worker = spawn('node', ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', configPath, '--local', '--port', '8797', '--inspector-port', '9237', '--persist-to', statePath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  worker.stdout.on('data', chunk => { output += chunk }); worker.stderr.on('data', chunk => { output += chunk })
  const base = 'http://127.0.0.1:8797'
  const request = (path: string, init?: RequestInit) => fetch(base + path, { redirect: 'manual', ...init })
  const post = (path: string, fields: Record<string, string>, origin = base) => request(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
  try {
    const deadline = Date.now() + 40_000
    while (!output.includes('Ready on')) { if (worker.exitCode !== null || Date.now() > deadline) throw new Error(`Worker startup failed: ${output}`); await new Promise(resolve => setTimeout(resolve, 100)) }
    assert.equal((await request('/')).status, 303)
    for (const path of ['/favicon.svg', '/_nuxt/example.js', '/api/costs', '/api/connections', '/data/costs.json']) assert.equal((await request(path)).status, 401, path)
    for (const [method, path] of [
      ['POST', '/api/subscriptions?import=1'],
      ['PATCH', '/api/subscriptions/bitwarden?revision=1'],
      ['DELETE', '/api/subscriptions/bitwarden?revision=1'],
      ['POST', '/api/connections/aws?replace=1'],
    ]) assert.equal((await request(path, { method, headers: { Origin: base } })).status, 401, `${method} ${path}`)
    assert.match(await (await request('/register')).text(), /One-time setup code/)
    assert.equal((await post('/auth/register', {}, 'https://foreign.example')).status, 403)
    const opaqueOriginPost = (fields: Record<string, string>, site: string) => request('/auth/register', { method: 'POST', headers: { Origin: 'null', 'Sec-Fetch-Site': site, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) })
    assert.equal((await opaqueOriginPost({}, 'cross-site')).status, 403)
    const fields = { email: 'owner@example.com', password: 'a-safe-local-test-password', code: 'local-test-setup-code' }
    const wrong = await post('/auth/register', { ...fields, code: 'wrong-code' })
    assert.equal(wrong.headers.get('set-cookie'), null)
    const registered = await opaqueOriginPost(fields, 'same-origin')
    assert.equal(registered.status, 303, await registered.clone().text())
    const setCookie = registered.headers.get('set-cookie')!
    assert.match(setCookie, /__Host-stackdues_session=/); assert.match(setCookie, /Secure; HttpOnly; SameSite=Strict/)
    const cookie = setCookie.split(';')[0]!
    const dashboard = await request('/', { headers: { Cookie: cookie } })
    assert.equal(dashboard.status, 200)
    assert.match(await dashboard.text(), /StackDues/)
    assert.equal((await request('/favicon.svg', { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await request('/api/costs', { headers: { Cookie: cookie } })).status, 200)
    const item = { id: 'api-bitwarden', name: 'Bitwarden', billingType: 'fixed', amount: 10, currency: 'USD', recurrenceInterval: 1, recurrenceUnit: 'year', nextRenewalAt: '2026-10-08', status: 'active' }
    const jsonRequest = (path: string, method: string, value: unknown) => request(path, { method, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
    const connection = { credentials: { apiToken: 'test-hostinger-secret-never-return' }, revision: 0 }
    assert.equal((await request('/api/connections/hostinger', { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify(connection) })).status, 403)
    const connected = await jsonRequest('/api/connections/hostinger', 'PUT', connection)
    assert.equal(connected.status, 200, await connected.clone().text())
    assert.equal((await connected.text()).includes(connection.credentials.apiToken), false)
    const connectionStatus = await request('/api/connections', { headers: { Cookie: cookie } })
    assert.equal((await connectionStatus.clone().text()).includes(connection.credentials.apiToken), false)
    assert.equal((await connectionStatus.json() as { hostinger: { configured: boolean } }).hostinger.configured, true)
    assert.equal((await jsonRequest('/api/connections/hostinger', 'PUT', connection)).status, 409)
    const disconnected = await request('/api/connections/hostinger', { method: 'DELETE', headers: { Cookie: cookie, Origin: base, 'If-Match': '"1"' } })
    assert.equal(disconnected.status, 200, await disconnected.clone().text())
    const refreshed = await jsonRequest('/api/costs/refresh', 'POST', {})
    assert.equal(refreshed.status, 200, await refreshed.clone().text())
    const refreshedFeed = await refreshed.json() as { providers: { aws: { status: string }, cloudflare: { status: string } } }
    assert.equal(refreshedFeed.providers.aws.status, 'not-configured')
    assert.equal(refreshedFeed.providers.cloudflare.status, 'not-configured')
    const scheduled = await request('/cdn-cgi/local/scheduled?cron=17+*%2F6+*+*+*')
    assert.equal(scheduled.status, 200, await scheduled.clone().text())
    const scheduledFeed = await request('/api/costs', { headers: { Cookie: cookie } })
    const scheduledProviders = (await scheduledFeed.json() as { providers: { aws: { status: string; lastAttemptAt?: string } } }).providers
    assert.equal(scheduledProviders.aws.status, 'not-configured')
    assert.ok(scheduledProviders.aws.lastAttemptAt)
    const created = await jsonRequest('/api/subscriptions', 'POST', item)
    assert.equal(created.status, 200, await created.clone().text())
    assert.equal((await created.json() as { revision: number }).revision, 1)
    const edited = await jsonRequest('/api/subscriptions/api-bitwarden', 'PATCH', { subscription: { ...item, amount: 20 }, revision: 1 })
    assert.equal(edited.status, 200, await edited.clone().text())
    assert.equal((await jsonRequest('/api/subscriptions/api-bitwarden', 'PATCH', { subscription: item, revision: 1 })).status, 409)
    const imported = await jsonRequest('/api/subscriptions/import', 'POST', { subscriptions: [item, { ...item, id: 'api-vps', name: 'VPS' }] })
    assert.equal(imported.status, 200, await imported.clone().text())
    const importedResult = await imported.json() as { createdIds: string[], subscriptions: { id: string, amount: number }[] }
    assert.deepEqual(importedResult.createdIds, ['api-vps'])
    assert.equal(importedResult.subscriptions.find(row => row.id === item.id)!.amount, 20)
    const ledger = await request('/api/subscriptions', { headers: { Cookie: cookie } })
    assert.equal((await ledger.json() as unknown[]).length, 2)
    assert.match(ledger.headers.get('cache-control')!, /private, no-store/)
    const deleteRequest = (id: string, revision: number) => request(`/api/subscriptions/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Cookie: cookie, Origin: base, 'If-Match': `"${revision}"` },
    })
    // Nitro's Cloudflare adapter forwards POST/PATCH bodies, but not DELETE.
    // Revisions travel in If-Match so the deployed runtime can enforce conflicts.
    assert.equal((await deleteRequest(item.id, 1)).status, 409)
    const deleted = await deleteRequest(item.id, 2)
    assert.equal(deleted.status, 200, await deleted.clone().text())
    assert.deepEqual(await deleted.json(), { deleted: true })
    for (const id of ['legacy/aws', 'legacy%25item']) {
      const escaped = { ...item, id, name: 'Imported escaped ID' }
      const added = await jsonRequest('/api/subscriptions', 'POST', escaped)
      assert.equal(added.status, 200, await added.clone().text())
      const changed = await jsonRequest(`/api/subscriptions/${encodeURIComponent(id)}`, 'PATCH', {
        subscription: { ...escaped, amount: 30 }, revision: 1,
      })
      assert.equal(changed.status, 200, await changed.clone().text())
      assert.equal((await changed.json() as { id: string }).id, id)
      assert.equal((await deleteRequest(id, 1)).status, 409)
      const removed = await deleteRequest(id, 2)
      assert.equal(removed.status, 200, await removed.clone().text())
      assert.deepEqual(await removed.json(), { deleted: true })
    }
    const remaining = await request('/api/subscriptions', { headers: { Cookie: cookie } })
    assert.deepEqual((await remaining.json() as { id: string }[]).map(row => row.id), ['api-vps'])
    const oversized = await jsonRequest('/api/subscriptions/import', 'POST', { oversized: 'x'.repeat(1024 * 1024) })
    assert.equal(oversized.status, 413)

    assert.equal((await request('/api/costs', { headers: { Cookie: '__Host-stackdues_session=forged' } })).status, 401)
    const repeated = await post('/auth/register', { ...fields, password: 'another-local-test-password' })
    assert.equal(repeated.headers.get('set-cookie'), null)
    assert.equal((await post('/auth/login', { email: fields.email, password: 'incorrect-test-password' })).headers.get('set-cookie'), null)
    assert.equal((await post('/auth/login', fields)).status, 303)
    assert.equal((await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://foreign.example' } })).status, 403)
    const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: base } })
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/)
    // The same rate-limit key also bounds retries when credentials are invalid.
    let limited = false
    for (let count = 0; count < 12; count++) if ((await post('/auth/login', fields)).status === 429) { limited = true; break }
    assert.equal(limited, true)
  } finally {
    worker.kill('SIGTERM'); if (worker.exitCode === null) await once(worker, 'exit')
    await rm(directory, { recursive: true, force: true })
  }
})
