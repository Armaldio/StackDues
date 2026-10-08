import { jwtVerify, SignJWT } from 'jose'

export const SESSION_COOKIE = '__Host-stackdues_session'
export const SESSION_MAX_AGE = 8 * 60 * 60
const issuer = 'https://dues.armaldio.xyz'
const audience = 'stackdues'
const iterations = 100_000
const encoder = new TextEncoder()
const passwordPattern = /^pbkdf2-sha256\$100000\$([a-f\d]{32})\$([a-f\d]{64})$/

export type AuthConfig = { ownerEmail?: string, passwordHash?: string, sessionSecret?: string }

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
function bytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(encoded.match(/../g)!, byte => parseInt(byte, 16))
}
function validPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= 16 && password.length <= 1024
}
function configured(config: AuthConfig | undefined): config is Required<AuthConfig> {
  return !!config
    && typeof config.ownerEmail === 'string' && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(config.ownerEmail)
    && typeof config.passwordHash === 'string' && passwordPattern.test(config.passwordHash)
    && typeof config.sessionSecret === 'string' && /^[a-f\d]{64}$/.test(config.sessionSecret)
}
async function derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}
async function credentialVersion(passwordHash: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(passwordHash))))
}

async function equalDigests(actual: Uint8Array<ArrayBuffer>, expected: Uint8Array<ArrayBuffer>): Promise<boolean> {
  // Native HMAC verification compares fixed-size digests without a JS early exit.
  // Standard Web Crypto also works where timingSafeEqual is not exposed.
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const signature = await crypto.subtle.sign('HMAC', key, expected)
  return crypto.subtle.verify('HMAC', key, signature, actual)
}

export async function secureEqual(provided: string, expected: string): Promise<boolean> {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false
  const [actual, wanted] = await Promise.all([provided, expected].map(async value =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
  ))
  return equalDigests(actual!, wanted!)
}

export async function hashPassword(password: string): Promise<string> {
  if (!validPassword(password)) throw new Error('Password must contain 16 to 1024 characters.')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `pbkdf2-sha256$${iterations}$${hex(salt)}$${hex(await derive(password, salt))}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!validPassword(password) || typeof encoded !== 'string') return false
  const match = passwordPattern.exec(encoded)
  if (!match) return false
  try {
    const actual = await derive(password, bytes(match[1]!))
    const expected = bytes(match[2]!)
    return await equalDigests(actual, expected)
  } catch {
    return false
  }
}

export async function createSession(config: AuthConfig | undefined, now = new Date()): Promise<string | null> {
  if (!configured(config) || !Number.isFinite(now.getTime())) return null
  try {
    const issuedAt = Math.floor(now.getTime() / 1000)
    return await new SignJWT({ version: await credentialVersion(config.passwordHash) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(issuer).setAudience(audience).setSubject(config.ownerEmail)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + SESSION_MAX_AGE)
      .sign(bytes(config.sessionSecret))
  } catch {
    return null
  }
}

export async function verifySession(
  token: string | null | undefined,
  config: AuthConfig | undefined,
  now = new Date(),
): Promise<{ email: string } | null> {
  if (!configured(config) || typeof token !== 'string' || !token || token.length > 4096
    || !Number.isFinite(now.getTime())) return null
  try {
    const { payload } = await jwtVerify(token, bytes(config.sessionSecret), {
      algorithms: ['HS256'], issuer, audience, subject: config.ownerEmail,
      requiredClaims: ['exp', 'iat', 'sub', 'version'], currentDate: now,
    })
    if (payload.aud !== audience || typeof payload.iat !== 'number' || typeof payload.exp !== 'number'
      || payload.iat > Math.floor(now.getTime() / 1000) || payload.exp - payload.iat !== SESSION_MAX_AGE
      || payload.version !== await credentialVersion(config.passwordHash)) return null
    return { email: config.ownerEmail }
  } catch {
    return null
  }
}
