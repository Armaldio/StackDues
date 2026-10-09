export function verifyAuthenticationBoundary(
  baseUrl?: string,
  options?: {
    fetchImpl?: typeof fetch
    attempts?: number
    delayMs?: number
  },
): Promise<void>
