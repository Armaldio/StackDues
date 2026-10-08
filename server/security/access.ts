import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export type AccessConfig = {
  teamDomain?: string
  audience?: string
  ownerEmail?: string
}

type VerificationOptions = {
  jwks?: JWTVerifyGetKey
  now?: Date
}

// Reuse jose's bounded cache and key-rotation handling for the single owner team.
let remoteKeys: { issuer: string, resolve: JWTVerifyGetKey } | undefined

function configured(config: AccessConfig | undefined): config is Required<AccessConfig> {
  return !!config
    && typeof config.teamDomain === 'string'
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(config.teamDomain)
    && typeof config.audience === 'string' && /^[a-f\d]{64}$/.test(config.audience)
    && typeof config.ownerEmail === 'string' && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(config.ownerEmail)
}

/** Verify the signed assertion, never an email header or an unverified JWT claim. */
export async function verifyAccessToken(
  token: string | null | undefined,
  config: AccessConfig | undefined,
  options: VerificationOptions = {},
): Promise<{ email: string } | null> {
  if (!configured(config) || typeof token !== 'string' || !token || token.length > 32_768
    || (options.now && !Number.isFinite(options.now.getTime()))) return null

  try {
    let keys = options.jwks
    if (!keys) {
      if (remoteKeys?.issuer !== config.teamDomain) {
        remoteKeys = {
          issuer: config.teamDomain,
          resolve: createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`), { timeoutDuration: 5_000 }),
        }
      }
      keys = remoteKeys.resolve
    }
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'], issuer: config.teamDomain, audience: config.audience,
      requiredClaims: ['exp', 'email'], currentDate: options.now,
    })
    const exactAudience = payload.aud === config.audience
      || (Array.isArray(payload.aud) && payload.aud.length === 1 && payload.aud[0] === config.audience)
    if (!exactAudience || payload.email !== config.ownerEmail) return null
    return { email: config.ownerEmail }
  } catch {
    // Signature, claim, configuration and remote-key failures all deny access.
    return null
  }
}
