import { LedgerError } from '../data/ledger.ts'

export type CredentialProvider = 'aws' | 'cloudflare' | 'hostinger' | 'openai'
export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export type CloudflareCredentials = { accountId: string; apiToken: string }
export type HostingerCredentials = { apiToken: string }
export type OpenAiCredentials = { adminApiKey: string }
export type ProviderCredentials = { aws: AwsCredentials; cloudflare: CloudflareCredentials; hostinger: HostingerCredentials; openai: OpenAiCredentials }
export type ConnectionStatus = { configured: boolean; revision: number; updatedAt?: string }
export type ConnectionStatuses = Record<CredentialProvider, ConnectionStatus>
type CredentialRow = { provider: CredentialProvider; version: number; iv: string | null; ciphertext: string | null; revision: number; updated_at: string }
type StatusRow = { provider: CredentialProvider; configured: number; revision: number; updated_at: string }
const providers = ['aws', 'cloudflare', 'hostinger', 'openai'] as const
const statusColumns = 'provider, ciphertext IS NOT NULL AS configured, revision, updated_at'
const encoder = new TextEncoder()

export function validateCredentialProvider(value: unknown): CredentialProvider {
  if (typeof value !== 'string' || !providers.includes(value as CredentialProvider)) throw new LedgerError(400, 'Unsupported provider connection.')
  return value as CredentialProvider
}
export function validateProviderCredentials<P extends CredentialProvider>(provider: P, input: unknown): ProviderCredentials[P] {
  validateCredentialProvider(provider)
  const invalid = () => { throw new LedgerError(400, 'Check the required provider credential fields and their lengths.') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid()
  const record = input as Record<string, unknown>
  const fields = provider === 'aws' ? ['accessKeyId', 'secretAccessKey', 'sessionToken'] : provider === 'cloudflare' ? ['accountId', 'apiToken'] : provider === 'openai' ? ['adminApiKey'] : ['apiToken']
  if (Object.keys(record).some(field => !fields.includes(field))) return invalid()
  function text(field: string, limit: number): string {
    const value = record[field]
    if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\s\u0000-\u001f\u007f]/.test(value.trim())) return invalid()
    return value.trim()
  }
  if (provider === 'aws') return { accessKeyId: text('accessKeyId', 256), secretAccessKey: text('secretAccessKey', 1024), ...(record.sessionToken === undefined ? {} : { sessionToken: text('sessionToken', 4096) }) } as ProviderCredentials[P]
  if (provider === 'cloudflare') {
    const accountId = text('accountId', 32)
    if (!/^[a-f\d]{32}$/i.test(accountId)) return invalid()
    return { accountId: accountId.toLowerCase(), apiToken: text('apiToken', 4096) } as ProviderCredentials[P]
  }
  if (provider === 'openai') return { adminApiKey: text('adminApiKey', 4096) } as ProviderCredentials[P]
  return { apiToken: text('apiToken', 4096) } as ProviderCredentials[P]
}
function expectedRevision(input: unknown, allowZero = false): number {
  if (!Number.isSafeInteger(input) || Number(input) < (allowZero ? 0 : 1) || Number(input) >= Number.MAX_SAFE_INTEGER) throw new LedgerError(400, 'A valid connection revision is required.')
  return input as number
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') }
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f\d]{2})+$/i.test(value)) throw new Error('Invalid encoded material')
  return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16))
}
async function encryptionKey(value: string | undefined): Promise<CryptoKey> {
  if (typeof value !== 'string' || !/^[a-f\d]{64}$/i.test(value)) throw new LedgerError(503, 'Provider credential encryption is unavailable. Check server configuration.')
  return crypto.subtle.importKey('raw', bytes(value), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
function aad(provider: CredentialProvider, version = 1): Uint8Array<ArrayBuffer> { return encoder.encode(`stackdues:credentials:v${version}:${provider}`) }
function status(row: StatusRow): ConnectionStatus { return { configured: row.configured === 1, revision: row.revision, updatedAt: row.updated_at } }
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) { if (error instanceof LedgerError) throw error; throw new LedgerError(503, 'Provider credential storage is unavailable. Try again later.') }
}

/** Expose presence and revision only. Never return plaintext, IVs, ciphertext or keys. */
export async function listProviderConnections(db: D1Database): Promise<ConnectionStatuses> {
  return storage(async () => {
    const result = await db.prepare(`SELECT ${statusColumns} FROM provider_credentials`).all<StatusRow>()
    const statuses: ConnectionStatuses = { aws: { configured: false, revision: 0 }, cloudflare: { configured: false, revision: 0 }, hostinger: { configured: false, revision: 0 }, openai: { configured: false, revision: 0 } }
    for (const row of result.results) statuses[row.provider] = status(row)
    return statuses
  })
}
export async function saveProviderCredentials<P extends CredentialProvider>(db: D1Database, provider: P, input: unknown, revision: unknown, key: string | undefined): Promise<ConnectionStatus> {
  const credentials = validateProviderCredentials(provider, input)
  const expected = expectedRevision(revision, true)
  let iv: string, ciphertext: string
  try {
    const imported = await encryptionKey(key)
    const random = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: random, additionalData: aad(provider), tagLength: 128 }, imported, encoder.encode(JSON.stringify(credentials)))
    iv = hex(random); ciphertext = hex(new Uint8Array(encrypted))
  } catch { throw new LedgerError(503, 'Provider credential encryption is unavailable. Check server configuration.') }
  return storage(async () => {
    const updatedAt = new Date().toISOString()
    const statement = expected === 0
      ? db.prepare(`INSERT INTO provider_credentials (provider, version, iv, ciphertext, revision, updated_at) VALUES (?, 1, ?, ?, 1, ?) ON CONFLICT(provider) DO NOTHING RETURNING ${statusColumns}`).bind(provider, iv, ciphertext, updatedAt)
      : db.prepare(`UPDATE provider_credentials SET version = 1, iv = ?, ciphertext = ?, revision = revision + 1, updated_at = ? WHERE provider = ? AND revision = ? RETURNING ${statusColumns}`).bind(iv, ciphertext, updatedAt, provider, expected)
    const row = await statement.first<StatusRow>()
    if (!row) throw new LedgerError(409, 'This connection changed. Reload before saving credentials.')
    return status(row)
  })
}
export async function removeProviderCredentials(db: D1Database, provider: CredentialProvider, revision: unknown): Promise<ConnectionStatus> {
  validateCredentialProvider(provider)
  const expected = expectedRevision(revision)
  return storage(async () => {
    const row = await db.prepare(`UPDATE provider_credentials SET iv = NULL, ciphertext = NULL, revision = revision + 1, updated_at = ? WHERE provider = ? AND revision = ? AND ciphertext IS NOT NULL RETURNING ${statusColumns}`)
      .bind(new Date().toISOString(), provider, expected).first<StatusRow>()
    if (!row) throw new LedgerError(409, 'This connection changed. Reload before disconnecting it.')
    return status(row)
  })
}

/** Server-only use by provider refresh. Missing/tombstoned credentials need no key. */
export async function loadProviderCredentials<P extends CredentialProvider>(db: D1Database, provider: P, key: string | undefined): Promise<ProviderCredentials[P] | null> {
  validateCredentialProvider(provider)
  const row = await storage(() => db.prepare('SELECT * FROM provider_credentials WHERE provider = ?').bind(provider).first<CredentialRow>())
  if (!row || (row.ciphertext === null && row.iv === null)) return null
  try {
    if (row.version !== 1 || !row.iv || row.iv.length !== 24 || !row.ciphertext) throw new Error('Invalid encrypted record')
    const imported = await encryptionKey(key)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(row.iv), additionalData: aad(provider, row.version), tagLength: 128 }, imported, bytes(row.ciphertext))
    return validateProviderCredentials(provider, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted)))
  } catch { throw new LedgerError(503, 'Provider credentials could not be read. Check server configuration.') }
}
