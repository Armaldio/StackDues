import { createError, getHeader, getRequestWebStream, getRouterParam, setHeader, type H3Event } from 'h3'
import { LedgerError } from './ledger.ts'

/** Nitro supplies the trusted Worker bindings on the request context. Never use client config. */
export async function ledgerEndpoint<T>(event: H3Event, operation: (db: D1Database) => Promise<T>): Promise<T> {
  setHeader(event, 'Cache-Control', 'private, no-store')
  try {
    const db = (event.context.cloudflare?.env as Partial<CloudflareEnv> | undefined)?.DB
    if (!db) throw new LedgerError(503, 'Private storage is unavailable. Try again later.')
    return await operation(db)
  } catch (error) {
    const known = error instanceof LedgerError
    throw createError({ statusCode: known ? error.statusCode : 503, statusMessage: known ? error.message : 'Private storage is unavailable. Try again later.' })
  }
}
export async function ledgerBody(event: H3Event): Promise<Record<string, unknown>> {
  if (getHeader(event, 'Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new LedgerError(415, 'Use a JSON request body.')
  try {
    const reader = getRequestWebStream(event)?.getReader()
    if (!reader) throw new Error('Missing body')
    let length = 0
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 1024 * 1024) { await reader.cancel(); throw new Error('Invalid body size') }
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object')
    return value as Record<string, unknown>
  } catch { throw new LedgerError(400, 'Use a valid JSON object no larger than 1 MB.') }
}
export function subscriptionId(event: H3Event): string {
  const id = getRouterParam(event, 'id', { decode: true })
  if (!id || id.length > 256) throw new LedgerError(400, 'A valid subscription ID is required.')
  return id
}
export function subscriptionRevision(event: H3Event): number {
  const header = getHeader(event, 'If-Match')
  const value = typeof header === 'string' && /^"[1-9]\d*"$/.test(header) ? Number(header.slice(1, -1)) : NaN
  if (!Number.isSafeInteger(value)) throw new LedgerError(400, 'If-Match must contain one quoted positive subscription revision.')
  return value
}
