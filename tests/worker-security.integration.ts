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
  config.vars = { OWNER_EMAIL: 'owner@example.com', SESSION_SECRET: 'a'.repeat(64), SETUP_TOKEN: 'local-test-setup-code' }
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
    for (const path of ['/favicon.svg', '/_nuxt/example.js', '/api/costs', '/data/costs.json']) assert.equal((await request(path)).status, 401, path)
    assert.match(await (await request('/register')).text(), /One-time setup code/)
    assert.equal((await post('/auth/register', {}, 'https://foreign.example')).status, 403)
    const fields = { email: 'owner@example.com', password: 'a-safe-local-test-password', code: 'local-test-setup-code' }
    const wrong = await post('/auth/register', { ...fields, code: 'wrong-code' })
    assert.equal(wrong.headers.get('set-cookie'), null)
    const registered = await post('/auth/register', fields)
    assert.equal(registered.status, 303, await registered.clone().text())
    const setCookie = registered.headers.get('set-cookie')!
    assert.match(setCookie, /__Host-stackdues_session=/); assert.match(setCookie, /Secure; HttpOnly; SameSite=Strict/)
    const cookie = setCookie.split(';')[0]!
    const dashboard = await request('/', { headers: { Cookie: cookie } })
    assert.equal(dashboard.status, 200)
    assert.match(await dashboard.text(), /StackDues/)
    assert.equal((await request('/favicon.svg', { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await request('/api/costs', { headers: { Cookie: cookie } })).status, 200)
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
