export type CloudflareCollectionStage = 'credentials' | 'billable_usage' | 'subscriptions'
export type CloudflareFailureKind = 'authorization' | 'timeout' | 'incomplete_response' | 'invalid_response' | 'request_failed' | 'configuration' | 'unknown'

export type CloudflareCollectionFailureEvent = Readonly<{
  event: 'cloudflare_collection_failed'
  provider: 'cloudflare'
  stage: CloudflareCollectionStage
  kind: CloudflareFailureKind
  attemptedAt: string
}>

function failureKind(error: unknown): CloudflareFailureKind {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('authorization failed')) return 'authorization'
  if (message.includes('timed out')) return 'timeout'
  if (message.includes('configuration') || message.includes('credentials are unavailable')) return 'configuration'
  if (message.includes('incomplete')) return 'incomplete_response'
  if (message.includes('invalid')) return 'invalid_response'
  if (message.includes('request failed')) return 'request_failed'
  return 'unknown'
}

/** Allowlist only fixed diagnostic fields; never copy provider messages into logs. */
export function cloudflareCollectionFailureEvent(
  stage: CloudflareCollectionStage,
  error: unknown,
  attemptedAt: string,
): CloudflareCollectionFailureEvent {
  return {
    event: 'cloudflare_collection_failed',
    provider: 'cloudflare',
    stage,
    kind: failureKind(error),
    attemptedAt,
  }
}

export function logCloudflareCollectionFailure(
  stage: CloudflareCollectionStage,
  error: unknown,
  attemptedAt: string,
  write: (line: string) => void = line => console.error(line),
): void {
  write(JSON.stringify(cloudflareCollectionFailureEvent(stage, error, attemptedAt)))
}
